#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, isAlive, launch, session, sleep } from "../lib/instance.mjs";
import { createCrawlerMatcher } from "../../packages/ardiacore/scripts/crawler-rules.mjs";
import { EXPIRED, FIXTURE_HOSTS, MUST_LOAD, OTHER, SHOP, startFixtureServer } from "./fixture-server.mjs";
import { checkNetLog } from "./netlog-check.mjs";

const USAGE = `usage: scripts/crawler/run-proof.mjs <app> --metro HOST:PORT (--cli DIR | --skip-cli) [--python PATH] [--out DIR]

Runs the crawler-mode proof (docs/crawler-mode.md, Test plan) on hidden scratch instances:
  T2  the local fixture page (every vendor's embed, first-party beacons, sendBeacon, a service worker, iframes, a popup,
      a tab opened over CDP and never attached) with crawler mode on, and once off as the control
  T3  X-Ardia-Crawler and Shopify signature headers as the fixture server saw them, on a separate signed instance with
      no NetLog (Chrome's NetLog records headers), including redirects to another host and to plain http
  T4  fail closed (ARDIA_TEST crawlerRulesFail=1)
Every instance is quit by its pid. The ardia command lives in ardia-browser/plugins: --cli is the folder that holds
its ardia_cli package (plugins/cli, with crawler mode's commands), run as \`--python -m ardia_cli\` with its locked
dependencies. --skip-cli leaves out the five checks that need it and lists them as SKIP.
Prints a pass/fail table and the evidence folder; exit 0 only when every check that ran passes.`;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(repo, "scripts/agent/crawler-launch");
const VENDORS = ["google", "shopify", "meta", "microsoft", "klaviyo", "tiktok", "pinterest", "hotjar"];
const FAKE_SIGNATURE = "sig1=:Y3Jhd2xlci1wcm9vZi1zaWduYXR1cmU=:";
const SIGNATURE_MARK = "Y3Jhd2xlci1wcm9vZi1zaWduYXR1cmU";
const PROFILE_NAME = "Personal";
const MAIN_FRAME_HIT = "open_main_frame";

function parseArgs(argv) {
  const out = { python: "python3" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--metro", "--python", "--out", "--cli"].includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
    else if (argv[i] === "--skip-cli") out.skipCli = true;
    else positional.push(argv[i]);
  }
  out.app = positional[0];
  out.ardia = out.cli ? { python: out.python, dir: resolve(out.cli) } : null;
  return out;
}

const run = (command, args, options = {}) => new Promise((done) => {
  execFile(command, args, { encoding: "utf8", timeout: 240000, maxBuffer: 64 << 20, ...options }, (error, stdout, stderr) => {
    done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
  });
});

function signatureInput(expires) {
  return `sig1=("@authority" "signature-agent");created=1763500000;expires=${expires};keyid="crawler-proof";tag="web-bot-auth"`;
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.next = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((ok, bad) => { this.ws.onopen = ok; this.ws.onerror = () => bad(new Error("DevTools connection failed")); });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) this.events.push(msg);
    };
    return this;
  }
  send(method, params = {}, sessionId, timeout = 20000) {
    const id = ++this.next;
    return new Promise((ok, bad) => {
      this.pending.set(id, (msg) => (msg.error ? bad(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), bad(new Error(`${method}: timed out`))), timeout);
    });
  }
  of(sessionId, method) {
    return this.events.filter((e) => e.sessionId === sessionId && (!method || e.method === method));
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function until(seconds, test) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const fixtureUrl = (r) => `https://${r.host}${r.path}${r.query}`;

async function startRun(name, root, extra, metro) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fixture = await startFixtureServer({ dir: join(dir, "fixture") });
  const netLog = join(dir, "netlog.json");
  const args = [extra.app, "--metro", metro, "--data-dir", join(dir, "data"), ...(extra.netLog === false ? [] : ["--net-log", netLog]), "--timeout", "120",
    ...fixture.switches.flatMap((s) => ["--switch", s]), ...extra.args];
  const launched = await run(process.execPath, [launcher, ...args]);
  writeFileSync(join(dir, "launcher.out"), `exit ${launched.code}\n--- stdout\n${launched.stdout}--- stderr\n${launched.stderr}`);
  const line = launched.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let info = null;
  try {
    info = JSON.parse(line);
  } catch {
    info = { unparsed: line };
  }
  return { name, dir, data: join(dir, "data"), fixture, netLog, launched, info };
}

async function disableContentBlocker(instance) {
  await instance.eval(`return ac.engine.call("contentBlocker.setEnabled", { enabled: false })`, { timeout: 30000 });
  return instance.eval(`return ac.engine.call("contentBlocker.state", {}).then((s) => s.enabled)`, { timeout: 30000 });
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  for (const domain of ["Network", "Page", "Runtime", "Log"]) await cdp.send(`${domain}.enable`, {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  await until(20, () => cdp.of(sessionId, "Page.loadEventFired").length > 0);
  return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression, userGesture = false) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId);
  return r.result?.value;
}

async function navigate(cdp, sessionId, url) {
  const before = cdp.of(sessionId, "Page.loadEventFired").length;
  const r = await cdp.send("Page.navigate", { url }, sessionId);
  await until(15, () => cdp.of(sessionId, "Page.loadEventFired").length > before || r.errorText);
  return r;
}

function blockedByClient(cdp, sessionIds, matcher) {
  const urls = new Map();
  for (const e of cdp.events) if (e.method === "Network.requestWillBeSent" && sessionIds.includes(e.sessionId)) urls.set(`${e.sessionId}:${e.params.requestId}`, e.params.request.url);
  const blocked = {};
  for (const e of cdp.events) {
    if (e.method !== "Network.loadingFailed" || !sessionIds.includes(e.sessionId) || e.params.errorText !== "net::ERR_BLOCKED_BY_CLIENT") continue;
    const url = urls.get(`${e.sessionId}:${e.params.requestId}`) ?? "";
    const vendor = matcher.blockedBy(url)?.vendor ?? "other";
    blocked[vendor] = (blocked[vendor] ?? 0) + 1;
  }
  return blocked;
}

async function webkitAttempt(instance, urlPart) {
  const body = `const s = ac.store.getState(); const id = Object.keys(s.tabs).find((k) => (s.tabs[k].url || "").includes(${JSON.stringify(urlPart)}));
    if (!id) return { found: false };
    const before = s.tabs[id].engine ?? null;
    try { ac.runCommand({ command: "togglePageEngine", arg: null, windowId: s.tabs[id].windowId }, { strictWindow: true, tabId: id }); } catch (e) { return { found: true, before, refused: String(e && e.message || e) }; }
    return { found: true, id, before };`;
  const tried = await instance.eval(body, { timeout: 30000 }).catch((error) => ({ error: error.message }));
  await sleep(4000);
  const after = tried?.id ? await instance.eval(`const t = ac.store.getState().tabs[${JSON.stringify(tried.id)}]; return t ? { engine: t.engine ?? "chromium", url: t.url } : { closed: true }`, { timeout: 30000 }).catch((error) => ({ error: error.message })) : null;
  return { ...tried, after };
}

const NET_LOG_PAGE = /^(?:view-source:)?(?:chrome|ardia|about):\/*net-(?:export|internals)/i;

async function netLogPagesAttempt(instance, cdp) {
  const made = await instance.eval(`const s = ac.store.getState();
    const second = s.createProfile({ name: "Second" });
    const firstWindow = s.windowOrder.find((id) => s.windows[id].profileId !== second);
    const tab = s.newTab(firstWindow, { url: "chrome://net-export/", background: true });
    const window = s.createWindow({ profileId: second, url: "chrome://net-internals/" });
    return { second, tab, window, profiles: Object.keys(ac.store.getState().profiles) };`, { timeout: 30000 }).catch((error) => ({ error: error.message }));
  const viaCdp = await cdp.send("Target.createTarget", { url: "chrome://net-export/" }).then((r) => ({ targetId: r.targetId }), (error) => ({ refused: error.message }));
  await sleep(4000);
  const targets = await (await fetch(`http://127.0.0.1:${instance.port}/json/list`)).json();
  const open = targets.filter((t) => NET_LOG_PAGE.test(t.url ?? "")).map((t) => `${t.type} ${t.url}`);
  const storeTabs = await instance.eval(`return Object.values(ac.store.getState().tabs).filter((t) => /net-(export|internals)/i.test(t.url || "")).map((t) => ({ profile: t.profileId, url: t.url }))`, { timeout: 30000 })
    .catch((error) => [{ error: error.message }]);
  return { made, viaCdp, open, storeTabs };
}

async function conversionAttempt(instance) {
  return instance.eval(`const threw = (e) => "threw: " + e.message;
    return ac.engine.call("crawler.setProfile", { profileId: "", enabled: true, name: "Crawler" }).catch(threw).then((existing) => {
      const fresh = ac.store.getState().createProfile({ name: "Fresh Crawler" });
      return ac.engine.call("crawler.setProfile", { profileId: fresh, enabled: true, name: "Fresh Crawler" }).catch(threw)
        .then((created) => ac.engine.call("crawler.state", {}).then((state) => ({ existing, created, fresh, crawlerProfiles: state.profiles.map((p) => p.profileId) })));
    });`, { timeout: 30000 }).catch((error) => ({ error: error.message }));
}

async function harFromSigned(run, ardia, harPath) {
  if (!ardia) return null;
  const instance = attach(run.data);
  const cli = ["-m", "ardia_cli", "browse", "--port", String(instance.port), "--data-dir", run.data, "--session", "har", "--profile", PROFILE_NAME];
  const steps = {};
  steps.open = await run_(ardia, [...cli, "open", `https://${SHOP}/har?tab=har`]);
  steps.start = await run_(ardia, [...cli, "network", "har", "start"]);
  steps.next = await run_(ardia, [...cli, "open", `https://${SHOP}/har-next?tab=har`]);
  steps.stop = await run_(ardia, [...cli, "network", "har", "stop", harPath]);
  steps.close = await run_(ardia, ["-m", "ardia_cli", "browse", "--port", String(instance.port), "--data-dir", run.data, "--session", "har", "close"]);
  return steps;
}

async function drive(run, { browse, ardia }) {
  const instance = attach(run.data);
  const evidence = { contentBlockerOn: await disableContentBlocker(instance) };
  const version = await (await fetch(`http://127.0.0.1:${instance.port}/json/version`)).json();
  const cdp = await new Cdp(version.webSocketDebuggerUrl).open();
  const main = await openTab(cdp, `https://${SHOP}/?tab=main`);
  await until(10, async () => (await evaluate(cdp, main.sessionId, "window.__fixture && window.__fixture.serviceWorker")) !== undefined);
  await sleep(3000);
  evidence.fixture = await evaluate(cdp, main.sessionId, "JSON.parse(JSON.stringify(window.__fixture))");
  evidence.popupOpened = await evaluate(cdp, main.sessionId, "window.openPopup()", true);
  await cdp.send("Target.createTarget", { url: `https://${SHOP}/?tab=unattached` });
  await sleep(4000);
  evidence.mainFrameOpened = await evaluate(cdp, main.sessionId, `!!window.open('https://www.google-analytics.com/g/collect?v=2&tid=G-FIXTURE01&en=${MAIN_FRAME_HIT}', '_blank')`, true);
  await sleep(2000);
  await navigate(cdp, main.sessionId, `https://${SHOP}/redirect-other?from=nav`);
  await navigate(cdp, main.sessionId, `https://${SHOP}/redirect-http?from=nav`);
  await navigate(cdp, main.sessionId, `https://${SHOP}/next`);
  await navigate(cdp, main.sessionId, `https://${EXPIRED}/expired`);
  await navigate(cdp, main.sessionId, `https://${OTHER}/other`);
  await sleep(1500);
  evidence.consoleCors = cdp.of(main.sessionId).filter((e) => (e.method === "Log.entryAdded" && /CORS/i.test(e.params.entry.text)) ||
    (e.method === "Runtime.consoleAPICalled" && /CORS/i.test(JSON.stringify(e.params.args)))).length;
  evidence.cdpBlocked = blockedByClient(cdp, [main.sessionId], createCrawlerMatcher());
  if (browse) {
    evidence.webkit = await webkitAttempt(instance, `${SHOP}/?tab=unattached`);
    evidence.netLogPages = await netLogPagesAttempt(instance, cdp);
    const cli = ["-m", "ardia_cli", "browse", "--port", String(instance.port), "--data-dir", run.data, "--session", "proof"];
    evidence.browseOpen = await cliRun(ardia, [...cli, "--profile", PROFILE_NAME, "open", `https://${SHOP}/browse?tab=browse`]);
    evidence.browseClose = await cliRun(ardia, [...cli, "close"]);
  }
  cdp.close();
  return { instance, evidence };
}

const run_ = (ardia, args) => run(ardia.python, args, { cwd: ardia.dir, timeout: 120000 }).then((r) => ({ code: r.code, out: (r.stdout + r.stderr).trim().slice(0, 2000) }));
const cliRun = (ardia, args) => (ardia ? run_(ardia, args) : Promise.resolve(null));

async function waitBlockedCounts(data, seconds) {
  const path = join(data, "crawler/status.json");
  return until(seconds, () => {
    const p = readJson(path)?.profiles?.[""];
    return p && Object.keys(p.blocked ?? {}).length ? p : null;
  }) ?? readJson(path)?.profiles?.[""];
}

async function quit(instance) {
  try {
    return (await instance.quit()).how;
  } catch (error) {
    return `quit failed: ${error.message}`;
  }
}

function leaksIn(files) {
  return files.filter((f) => existsSync(f) && readFileSync(f, "latin1").includes(SIGNATURE_MARK));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app || !args.metro || !(args.cli || args.skipCli) || process.argv.includes("--help")) {
    console.log(USAGE);
    process.exit(args.app && args.metro && (args.cli || args.skipCli) ? 0 : 64);
  }
  const stamp = Date.now().toString(36);
  const root = resolve(args.out ?? join(homedir(), "scratch/2026-11-18-crawler-mode/runs", `proof-${stamp}`));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const matcher = createCrawlerMatcher();
  const rows = [];
  const check = (test, name, ok, evidence) => {
    rows.push({ test, name, ok: !!ok, evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence) });
    console.error(`${ok ? "PASS" : "FAIL"} ${test} ${name}`);
  };
  const checkCli = (test, name, result, ok, evidence) => {
    if (result) return check(test, name, ok(result), evidence ?? result);
    rows.push({ test, name, ok: null, evidence: "--skip-cli" });
    console.error(`SKIP ${test} ${name}`);
  };
  const signatures = join(root, "signatures.json");
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(signatures, JSON.stringify([
    { domain: SHOP, signatureInput: signatureInput(now + 30 * 86400), signature: FAKE_SIGNATURE },
    { domain: EXPIRED, signatureInput: signatureInput(now - 3600), signature: FAKE_SIGNATURE },
  ]), { mode: 0o600 });
  chmodSync(signatures, 0o600);
  const runId = `proof-${stamp}`;
  const started = [];
  const servers = [];
  let onEvidence = null;
  let offEvidence = null;

  try {
    const on = await startRun("on", root, { app: args.app, netLog: true, args: ["--header", `qa; run=${runId}`] }, args.metro);
    servers.push(on.fixture);
    check("T2", "crawler-launch: crawler on gets ready and prints the port", on.launched.code === 0 && on.info?.ready && on.info?.port, on.info ?? on.launched.stderr);
    if (on.launched.code === 0) {
      const onDrive = await drive(on, { browse: true, ardia: args.ardia });
      started.push(onDrive.instance);
      const status = await waitBlockedCounts(on.data, 75);
      copyFileSync(join(on.data, "crawler/status.json"), join(on.dir, "status.json"));
      onDrive.quit = await quit(onDrive.instance);
      const e = onDrive.evidence;
      onEvidence = e;
      writeFileSync(join(on.dir, "evidence.json"), JSON.stringify({ ...e, status }, null, 2));
      check("T2", "content blocker (uBO) off, so only the crawler ruleset blocks", e.contentBlockerOn === false, `uBO enabled: ${e.contentBlockerOn}`);
      const net = checkNetLog(on.netLog, { expect: "blocked", firstParty: FIXTURE_HOSTS });
      writeFileSync(join(on.dir, "netlog-check.json"), JSON.stringify(net, null, 2));
      check("T2", "NetLog: no tracker request left the browser", net.verdict.pass, `${net.requests} requests; ${net.verdict.why}`);
      const reqs = on.fixture.requests();
      const reached = reqs.filter((r) => matcher.blockedBy(fixtureUrl(r)));
      check("T2", "fixture server: no tracker request reached it", reached.length === 0, reached.map(fixtureUrl).slice(0, 10));
      const opened = reqs.filter((r) => r.query.includes(`en=${MAIN_FRAME_HIT}`));
      const openedInNetLog = readFileSync(on.netLog, "utf8").includes(`en=${MAIN_FRAME_HIT}`);
      check("T2", "window.open to google-analytics.com/g/collect from a crawler page is blocked (main_frame)", e.mainFrameOpened !== undefined && opened.length === 0 && !openedInNetLog,
        `opened: ${e.mainFrameOpened}; reached fixture ${opened.length}; in NetLog ${openedInNetLog}`);
      check("T2", "CDP: tracker requests failed with ERR_BLOCKED_BY_CLIENT", Object.keys(e.cdpBlocked).filter((v) => v !== "other").length >= 5, e.cdpBlocked);
      const counted = status?.blocked ?? {};
      const short = Object.entries(e.cdpBlocked).filter(([v, n]) => v !== "other" && (counted[v] ?? 0) < n);
      check("T2", "status blocked counts cover every block CDP saw", Object.keys(counted).length > 0 && short.length === 0 && !("selftest" in counted),
        { status: counted, cdp: e.cdpBlocked });
      const missing = MUST_LOAD.filter((a) => !e.fixture?.assets?.[a]);
      check("T2", "must-not-block assets loaded (theme, cart.js, product.js, klaviyo.js, CORS fetch)", missing.length === 0, missing.length ? { missing } : e.fixture?.assets);
      check("T2", "the never-attached CDP tab loaded the page", reqs.some((r) => r.host === SHOP && r.path === "/" && r.query.includes("tab=unattached")), "tab=unattached");
      check("T2", "the popup and both iframes loaded", ["popup", "frame-same", "frame-other"].every((t) => reqs.some((r) => r.query.includes(`tab=${t}`) && (r.dest === "document" || r.dest === "iframe"))),
        reqs.filter((r) => r.dest === "document" || r.dest === "iframe").map((r) => `${r.host}${r.path}${r.query}`));
      check("T2", "the service worker installed (and its GA fetch was blocked)", e.fixture?.serviceWorker === "ready" && reqs.some((r) => r.path === "/sw.js"), e.fixture?.serviceWorker);
      checkCli("T2", "ardia browse --profile opens its tab in the crawler profile", e.browseOpen, (opened) => opened.code === 0 && reqs.some((r) => r.path === "/browse" && r.crawlerHeader));
      const webkit = e.webkit ?? {};
      check("T2", "opening the crawler page in WebKit is refused or stays on Chromium", webkit.found && !webkit.error && (webkit.refused || webkit.after?.closed || webkit.after?.engine === "chromium"),
        webkit);
      check("T2", "instance quit by its pid", ["quit", "SIGTERM", "SIGKILL", "gone"].includes(onDrive.quit), onDrive.quit);
    }

    const signed = await startRun("signed", root, { app: args.app, netLog: false, args: ["--header", `qa; run=${runId}`, "--shopify-signatures", signatures] }, args.metro);
    servers.push(signed.fixture);
    check("T3", "crawler-launch: the signed instance gets ready, with no NetLog", signed.launched.code === 0 && signed.info?.ready && signed.info.netLog === null && !existsSync(signed.netLog),
      signed.info ?? signed.launched.stderr);
    if (signed.launched.code === 0) {
      const signedDrive = await drive(signed, { browse: false, ardia: args.ardia });
      started.push(signedDrive.instance);
      const harPath = join(signed.dir, "signed.har");
      const harSteps = await harFromSigned(signed, args.ardia, harPath);
      writeFileSync(join(signed.dir, "har-steps.json"), JSON.stringify(harSteps, null, 2));
      const status = readJson(join(signed.data, "crawler/status.json"))?.profiles?.[""];
      copyFileSync(join(signed.data, "crawler/status.json"), join(signed.dir, "status.json"));
      const statusCli = await cliRun(args.ardia, ["-m", "ardia_cli", "crawler", "status", "--data-dir", signed.data]);
      if (statusCli) writeFileSync(join(signed.dir, "crawler-status.txt"), `exit ${statusCli.code}\n${statusCli.out}\n`);
      signedDrive.quit = await quit(signedDrive.instance);
      const e = signedDrive.evidence;
      writeFileSync(join(signed.dir, "evidence.json"), JSON.stringify({ ...e, status }, null, 2));
      const reqs = signed.fixture.requests();
      const docs = reqs.filter((r) => r.dest === "document" || r.dest === "iframe");
      const subs = reqs.filter((r) => r.dest && r.dest !== "document" && r.dest !== "iframe");
      const want = [["main page", (r) => r.path === "/" && r.query.includes("tab=main")], ["same-site iframe", (r) => r.query.includes("tab=frame-same")],
        ["cross-site iframe", (r) => r.query.includes("tab=frame-other")], ["popup", (r) => r.query.includes("tab=popup")], ["never-attached tab", (r) => r.query.includes("tab=unattached")]];
      check("T3", "X-Ardia-Crawler on top-level, iframe and popup navigations", want.every(([, f]) => docs.some((r) => f(r) && r.crawlerHeader)),
        want.map(([n, f]) => `${n}: ${docs.find(f)?.crawlerHeader ?? "not seen"}`).join("; "));
      const subWith = subs.filter((r) => r.crawlerHeader);
      check("T3", "no X-Ardia-Crawler on subresources (first or third party)", subs.length > 0 && subWith.length === 0, `${subs.length} subresources, ${subWith.length} with it`);
      const onSigned = reqs.filter((r) => r.host === SHOP && r.scheme === "https" && r.method !== "OPTIONS");
      const unsigned = onSigned.filter((r) => !(r.signature && r.signatureInput && r.signatureAgent));
      check("T3", "Shopify signature headers on every https request to the signed domain", onSigned.length >= 5 && unsigned.length === 0,
        `${onSigned.length} requests; unsigned: ${unsigned.map((r) => `${r.dest}:${r.path}`).slice(0, 8).join(", ") || "none"}`);
      const elsewhere = reqs.filter((r) => (r.host !== SHOP || r.scheme !== "https") && (r.signature || r.signatureInput || r.signatureAgent));
      check("T3", "no signature headers anywhere else (other site, CDN, expired domain, plain http)", elsewhere.length === 0 && reqs.some((r) => r.host === EXPIRED) && reqs.some((r) => r.host !== SHOP),
        elsewhere.map((r) => `${r.scheme}://${r.host}${r.path}${r.query}`).slice(0, 8));
      const landed = reqs.filter((r) => r.path === "/landed");
      const landedSigned = landed.filter((r) => r.signature || r.signatureInput || r.signatureAgent);
      const describeLanding = (via) => landed.filter((r) => r.query.includes(`via=${via}`)).map((r) => `${r.scheme}://${r.host}${r.query} ${r.dest}${r.signature || r.signatureInput || r.signatureAgent ? " SIGNED" : ""}`);
      const otherLandings = landed.filter((r) => r.query.includes("via=redirect-other"));
      const httpLandings = landed.filter((r) => r.query.includes("via=redirect-http"));
      check("T3", "redirect to another host: the landing request carries no signature headers", otherLandings.length >= 1 && otherLandings.every((r) => !(r.signature || r.signatureInput || r.signatureAgent)),
        describeLanding("redirect-other"));
      check("T3", "redirect to plain http on the signed host: the landing request carries no signature headers", httpLandings.length >= 1 && httpLandings.every((r) => !(r.signature || r.signatureInput || r.signatureAgent)),
        describeLanding("redirect-http"));
      writeFileSync(join(signed.dir, "redirects.json"), JSON.stringify({ landed, signedLandings: landedSigned.length, redirectRequests: reqs.filter((r) => r.path.startsWith("/redirect-")) }, null, 2));
      const shopify = status?.shopify ?? [];
      const okSigned = shopify.find((x) => x.domain === SHOP);
      const okExpired = shopify.find((x) => x.domain === EXPIRED);
      check("T3", "expired signature reported and not sent; the live one sent with its expiry",
        okSigned?.sent === true && !!okSigned.expires && okExpired?.sent === false && !!okExpired.expires, shopify);
      const preflights = reqs.filter((r) => r.method === "OPTIONS");
      check("T3", "no CORS errors and no preflights", e.consoleCors === 0 && preflights.length === 0 && e.fixture?.assets?.cors === true,
        `console CORS messages ${e.consoleCors}, OPTIONS ${preflights.length}, cors fetch ${e.fixture?.assets?.cors ?? false}`);
      const leaked = leaksIn([join(signed.data, "crawler/status.json"), join(signed.data, "app.out.log"), signed.fixture.log, join(signed.dir, "crawler-status.txt"), join(signed.dir, "launcher.out"), join(signed.dir, "evidence.json")]);
      check("T3", "no signature value in the status file, app log, fixture log or CLI output", leaked.length === 0, leaked);
      checkCli("T3", "status CLI prints ready, header on and both domains", statusCli, (s) => s.code === 0 && s.out.includes("header: on") && s.out.includes(SHOP) && s.out.includes(EXPIRED), statusCli?.out.split("\n").slice(0, 4).join(" | "));
      const har = existsSync(harPath) ? readFileSync(harPath, "utf8") : "";
      const harEntries = har ? JSON.parse(har).log.entries : [];
      const toShop = harEntries.filter((entry) => entry.request.url.includes(SHOP));
      const signatureNames = [...new Set(toShop.flatMap((entry) => entry.request.headers.map((h) => h.name)).filter((name) => /^signature/i.test(name)))];
      checkCli("T3", "a HAR of the signed instance holds no signature value", harSteps, (steps) => steps.stop.code === 0 && toShop.length > 0 && !har.includes(SIGNATURE_MARK),
        `${harEntries.length} entries, ${toShop.length} to the signed host; signature header names seen: ${signatureNames.join(", ") || "none"}; value present: ${har.includes(SIGNATURE_MARK)}`);
      check("T3", "instance quit by its pid", ["quit", "SIGTERM", "SIGKILL", "gone"].includes(signedDrive.quit), signedDrive.quit);
    }

    const off = await startRun("off", root, { app: args.app, netLog: true, args: ["--no-crawler"] }, args.metro);
    servers.push(off.fixture);
    check("T2c", "control instance launched without crawler mode", off.launched.code === 0 && off.info?.ready && off.info.crawler === false && !existsSync(join(off.data, "crawler/status.json")), off.info ?? off.launched.stderr);
    if (off.launched.code === 0) {
      const offDrive = await drive(off, { browse: false, ardia: args.ardia });
      started.push(offDrive.instance);
      offDrive.evidence.conversion = await conversionAttempt(offDrive.instance);
      offDrive.quit = await quit(offDrive.instance);
      writeFileSync(join(off.dir, "evidence.json"), JSON.stringify(offDrive.evidence, null, 2));
      offEvidence = offDrive.evidence;
      check("T2c", "content blocker (uBO) off in the control too", offDrive.evidence.contentBlockerOn === false, `uBO enabled: ${offDrive.evidence.contentBlockerOn}`);
      const net = checkNetLog(off.netLog, { expect: "leaks", vendors: VENDORS, firstParty: FIXTURE_HOSTS });
      writeFileSync(join(off.dir, "netlog-check.json"), JSON.stringify(net, null, 2));
      check("T2c", "NetLog: the control's trackers DID leave (detector works)", net.verdict.pass, `${net.trackers.length} tracker requests; ${net.verdict.why}`);
      const reqs = off.fixture.requests();
      const hits = reqs.filter((r) => matcher.blockedBy(fixtureUrl(r)));
      const paths = [["service worker", (r) => /en=sw_/.test(r.query)], ["sendBeacon on pagehide", (r) => r.query.includes("en=page_hide")],
        ["never-attached tab", (r) => r.query.includes("tab=unattached")], ["popup", (r) => r.query.includes("tab=popup")],
        ["iframe", (r) => r.query.includes("tab=frame")], ["first-party /g/collect", (r) => r.host === SHOP && r.path === "/g/collect"],
        ["monorail", (r) => r.host === SHOP && r.path.startsWith("/.well-known/shopify/monorail/")]];
      check("T2c", "control: tracker hits from every path reached the fixture", paths.every(([, f]) => hits.some(f)), paths.map(([n, f]) => `${n}: ${hits.filter(f).length}`).join("; "));
      check("T2c", "control: the window.open to g/collect reached the fixture (main_frame detector works)", reqs.some((r) => r.query.includes(`en=${MAIN_FRAME_HIT}`) && r.dest === "document"),
        reqs.filter((r) => r.query.includes(`en=${MAIN_FRAME_HIT}`)).map((r) => `${r.host}${r.path} ${r.dest}`));
      check("T2c", "control: no CDP ERR_BLOCKED_BY_CLIENT", Object.keys(offDrive.evidence.cdpBlocked).length === 0, offDrive.evidence.cdpBlocked);
      check("T2c", "control instance quit by its pid", ["quit", "SIGTERM", "SIGKILL", "gone"].includes(offDrive.quit), offDrive.quit);
    }

    const conversion = offEvidence?.conversion ?? {};
    check("T4", "turning an existing, loaded profile into a crawler profile is refused (a brand-new one is allowed)",
      typeof conversion.existing === "string" && !conversion.crawlerProfiles?.includes("") && conversion.created === null && conversion.crawlerProfiles?.includes(conversion.fresh), conversion);
    const pages = onEvidence?.netLogPages ?? {};
    check("T4", "chrome://net-export and net-internals open in no profile of a crawler instance", !!pages.made && !pages.made.error && pages.open?.length === 0 &&
      Array.isArray(pages.storeTabs) && pages.storeTabs.length === 0, pages);
    const bareNetLog = await run(process.execPath, [launcher, args.app, "--data-dir", join(root, "bare-netlog", "data"), "--shopify-signatures", signatures,
      "--switch", `log-net-log=${join(root, "bare-netlog", "netlog.json")}`]);
    check("T4", "crawler-launch refuses signatures with a bare log-net-log switch (exit 2, no port, no NetLog)",
      bareNetLog.code === 2 && !/"port"/.test(bareNetLog.stdout) && !existsSync(join(root, "bare-netlog", "netlog.json")), `exit ${bareNetLog.code}: ${bareNetLog.stderr.trim().slice(0, 300)}`);
    const fail = await startRun("fail", root, { app: args.app, args: ["--test", "crawlerRulesFail=1"] }, args.metro);
    servers.push(fail.fixture);
    const printed = fail.launched.stdout;
    check("T4", "crawler-launch exits non-zero with the reason and no port", fail.launched.code !== 0 && !/"port"/.test(printed) && /"reason"/.test(printed), `exit ${fail.launched.code}: ${printed.trim()}`);
    const leftover = readJson(join(fail.data, "instance.json"));
    const gone = leftover?.pid ? await until(5, () => !isAlive(leftover.pid)) : null;
    check("T4", "crawler-launch quit the instance it started", !!gone, leftover?.pid ? `pid ${leftover.pid} ${gone ? "gone" : "still running"}` : "no instance recorded");
    const direct = join(root, "fail-direct");
    mkdirSync(direct, { recursive: true, mode: 0o700 });
    const directFixture = await startFixtureServer({ dir: join(direct, "fixture") });
    servers.push(directFixture);
    const directNet = join(direct, "netlog.json");
    const directData = join(direct, "data");
    mkdirSync(directData, { recursive: true, mode: 0o700 });
    writeFileSync(join(directData, "session.json"), JSON.stringify(session({ settings: { cliControl: true } })));
    const metroPort = Number(args.metro.split(":").at(-1));
    const held = await launch(args.app, { data: directData, onboarded: true, ready: false, js: "pinned", metroPort, instance: { crawler: "on" },
      test: { crawlerRulesFail: true }, switches: [...directFixture.switches, `--log-net-log=${directNet}`] });
    started.push(held);
    const settled = await until(60, () => {
      const p = readJson(join(directData, "crawler/status.json"))?.profiles?.[""];
      return p && (p.ready || p.reason) ? p : null;
    });
    check("T4", "status ready: false with the reason", settled && settled.ready === false && !!settled.reason, settled);
    const exitedItself = await until(20, () => !isAlive(held.pid));
    check("T4", "the not-ready instance quit itself (fail-closed containment)", !!exitedItself, exitedItself ? `pid ${held.pid} exited by itself` : `pid ${held.pid} still running`);
    const statusCli = await cliRun(args.ardia, ["-m", "ardia_cli", "crawler", "status", "--data-dir", directData]);
    checkCli("T4", "ardia crawler status refuses: not ready (1) or, once the app quit, a stale status file (2)", statusCli,
      (s) => (s.code === 1 && /not ready/.test(s.out)) || (s.code === 2 && /stale status file/.test(s.out) && exitedItself));
    const browse = await cliRun(args.ardia, ["-m", "ardia_cli", "browse", "--port", String(held.port), "--data-dir", directData, "--session", "proof", "--profile", PROFILE_NAME, "open", `https://${SHOP}/?tab=t4-browse`]);
    checkCli("T4", "ardia browse --profile refuses", browse, (b) => b.code === 1 && /isn't ready|stale status file/.test(b.out));
    if (!exitedItself) {
      const version = await (await fetch(`http://127.0.0.1:${held.port}/json/version`)).json();
      const cdp = await new Cdp(version.webSocketDebuggerUrl).open();
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Network.enable", {}, sessionId);
      const nav = await cdp.send("Page.navigate", { url: `https://${SHOP}/?tab=t4` }, sessionId).catch((e) => ({ errorText: e.message }));
      await sleep(3000);
      cdp.close();
      check("T4", "a navigation in the not-ready profile is blocked", /ERR_BLOCKED_BY_CLIENT/.test(nav.errorText ?? ""), nav.errorText ?? "navigated");
    }
    const heldQuit = await quit(held);
    check("T4", "fixture server saw no request at all", directFixture.requests().length === 0, directFixture.requests().map(fixtureUrl).slice(0, 5));
    const t4Net = checkNetLog(directNet, { firstParty: FIXTURE_HOSTS });
    const netText = readFileSync(directNet, "utf8");
    const fixtureInNetLog = FIXTURE_HOSTS.filter((h) => netText.includes(`https://${h}/`));
    writeFileSync(join(direct, "netlog-check.json"), JSON.stringify(t4Net, null, 2));
    check("T4", "NetLog has no request to the fixture", fixtureInNetLog.length === 0 && t4Net.trackers.length === 0, fixtureInNetLog.length ? fixtureInNetLog : `${t4Net.requests} requests, none to the fixture`);
    check("T4", "instance gone (by itself, or quit by its pid)", ["quit", "SIGTERM", "SIGKILL", "gone"].includes(heldQuit) && !isAlive(held.pid), heldQuit);
  } catch (error) {
    check("run", "harness", false, error.stack);
  } finally {
    for (const instance of started) if (instance.alive) await quit(instance);
    for (const server of servers) await server.close().catch(() => {});
  }

  writeFileSync(join(root, "results.json"), JSON.stringify(rows, null, 2));
  const width = Math.max(...rows.map((r) => r.name.length));
  const table = [`| Test | Check${" ".repeat(width - 5)} | Result |`, `| --- | ${"-".repeat(width)} | --- |`,
    ...rows.map((r) => `| ${r.test} | ${r.name.padEnd(width)} | ${r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL"} |`)].join("\n");
  writeFileSync(join(root, "table.md"), `${table}\n`);
  console.log(table);
  const ran = rows.filter((r) => r.ok !== null);
  console.log(`\n${ran.filter((r) => r.ok).length}/${ran.length} passed, ${rows.length - ran.length} skipped. Evidence: ${root}`);
  for (const r of ran.filter((r) => !r.ok)) console.log(`FAIL ${r.test} ${r.name}: ${r.evidence.slice(0, 600)}`);
  process.exit(ran.length && ran.every((r) => r.ok) ? 0 : 1);
}

await main();
