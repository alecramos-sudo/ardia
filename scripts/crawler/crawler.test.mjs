import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_HOSTS, SHOP, VENDOR_HOSTS, requestRecord, startFixtureServer } from "./fixture-server.mjs";
import { checkNetLog, classify, parseNetLog, sentRequests, verdict } from "./netlog-check.mjs";
import { verdict as launchVerdict } from "./launch-status.mjs";
import { appSwitches, netLogSwitchIn } from "./netlog-switches.mjs";

const constants = { logEventTypes: { URL_REQUEST_START_JOB: 7, REQUEST_ALIVE: 2 }, logSourceType: { URL_REQUEST: 1, SOCKET: 4 }, logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2 } };
const start = (url, extra = {}) => ({ type: 7, phase: 1, source: { type: 1, id: 1 }, params: { url, method: "GET" }, ...extra });
const netLogText = (events, closed = true) =>
  `{"constants": ${JSON.stringify(constants)},\n"events": [\n${events.map((e) => JSON.stringify(e)).join(",\n")}${closed ? "\n]}\n" : ",\n{\"type\": 7, \"pha"}`;
const scratch = () => mkdtempSync(join(tmpdir(), "crawler-test-"));

test("only URL_REQUEST_START_JOB begins on network schemes count as sent", () => {
  const log = parseNetLog(netLogText([
    start("https://www.google-analytics.com/g/collect?v=2&tid=G-1"),
    start("https://cdn.shopify.com/s/files/theme.css"),
    start("chrome-extension://jphbnffonbejilmcbfhnpjfmblejpcgc/bridge.html"),
    start("data:text/plain,hi"),
    start("https://x.example/", { phase: 2 }),
    start("https://y.example/", { source: { type: 4, id: 2 } }),
    { type: 2, phase: 1, source: { type: 1, id: 3 }, params: { url: "https://z.example/" } },
  ]));
  assert.equal(log.truncated, false);
  assert.deepEqual(sentRequests(log).map((r) => r.host), ["www.google-analytics.com", "cdn.shopify.com"]);
});

test("a NetLog cut off mid-event is read up to its last whole event", () => {
  const log = parseNetLog(netLogText([start("https://connect.facebook.net/en_US/fbevents.js"), start("https://shop.example/")], false));
  assert.equal(log.truncated, true);
  assert.equal(log.unreadable, 1);
  assert.equal(sentRequests(log).length, 2);
  assert.throws(() => parseNetLog(""), /empty/);
  assert.throws(() => parseNetLog("{\"nope\": 1}"), /no events/);
});

test("trackers are classified by the crawler ruleset and third parties listed", () => {
  const report = classify([
    { url: "https://www.google-analytics.com/g/collect?v=2", host: "www.google-analytics.com" },
    { url: "https://shop.example/.well-known/shopify/monorail/unstable/produce_batch", host: "shop.example" },
    { url: "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X", host: "static.klaviyo.com" },
    { url: "https://shop.example/cart.js", host: "shop.example" },
  ], { firstParty: ["shop.example"] });
  assert.deepEqual(report.vendors, { google: 1, shopify: 1 });
  assert.deepEqual(report.thirdPartyHosts.map((h) => h.host), ["static.klaviyo.com", "www.google-analytics.com"]);
});

test("verdicts: blocked needs zero trackers, leaks needs every vendor, empty fails both", () => {
  const leaky = { requests: 3, trackers: [{ vendor: "google" }], vendors: { google: 1 } };
  const clean = { requests: 3, trackers: [], vendors: {} };
  assert.equal(verdict(clean, { expect: "blocked" }).pass, true);
  assert.equal(verdict(leaky, { expect: "blocked" }).pass, false);
  assert.equal(verdict(leaky, { expect: "leaks" }).pass, true);
  assert.equal(verdict(leaky, { expect: "leaks", vendors: ["google", "meta"] }).pass, false);
  assert.match(verdict(clean, { expect: "leaks" }).why, /detector is broken/);
  assert.equal(verdict({ requests: 0, trackers: [], vendors: {} }, { expect: "blocked" }).pass, false);
});

test("the CLI's exit codes follow the verdict", () => {
  const dir = scratch();
  const file = join(dir, "netlog.json");
  writeFileSync(file, netLogText([start("https://www.googletagmanager.com/gtag/js?id=G-1"), start("https://cdn.shopify.com/a.css")]));
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("./netlog-check.mjs", import.meta.url)), file, ...args], { encoding: "utf8" });
  assert.equal(cli("--expect-blocked").status, 1);
  assert.equal(cli("--expect-leaks", "--vendors", "google").status, 0);
  assert.equal(cli("--expect-leaks", "--vendors", "google,meta").status, 1);
  assert.equal(cli().status, 0);
  assert.equal(JSON.parse(cli("--json").stdout).trackers[0].vendor, "google");
  writeFileSync(file, "");
  assert.equal(cli("--expect-blocked").status, 2);
  assert.throws(() => checkNetLog(join(dir, "missing.json")), /ENOENT/);
});

test("the fixture log records header presence, never values", () => {
  const record = requestRecord({ method: "GET", url: "/g/collect?v=2", headers: { host: `${SHOP}:443`, "x-ardia-crawler": "qa; run=1", signature: "sig1=:c2VjcmV0:", "sec-fetch-dest": "document" } }, 1);
  assert.deepEqual(record, { at: 1, scheme: "http", method: "GET", host: SHOP, path: "/g/collect", query: "?v=2", dest: "document", mode: null, crawlerHeader: true, signatureInput: false, signature: true, signatureAgent: false });
  assert.doesNotMatch(JSON.stringify(record), /c2VjcmV0|run=1/);
});

test("the fixture server serves the page and vendor stubs over HTTPS and logs each request", async () => {
  const dir = scratch();
  const fixture = await startFixtureServer({ dir });
  try {
    const get = (host, path, headers = {}) => new Promise((ok, bad) => {
      const req = request({ host: "127.0.0.1", port: fixture.port, path, servername: host, rejectUnauthorized: false, headers: { host, ...headers } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => ok({ status: res.statusCode, body, type: res.headers["content-type"] }));
      });
      req.on("error", bad);
      req.end();
    });
    const page = await get(SHOP, "/?tab=main");
    for (const marker of ["gtag/js?id=G-", "gtm.js?id=", "fbevents.js", "clarity.ms/tag/", "klaviyo.js?company_id=", "events.js", "s.pinimg.com/ct/core.js", "static.hotjar.com", "sendBeacon", "serviceWorker", "<iframe", "window.open", "/g/collect", "/.well-known/shopify/monorail/"]) {
      assert.ok(page.body.includes(marker), marker);
    }
    assert.match((await get("www.googletagmanager.com", "/gtag/js?id=G-FIXTURE01")).body, /g\/collect/);
    assert.equal((await get("www.facebook.com", "/tr?id=1&ev=PageView")).type, "image/gif");
    assert.match((await get(SHOP, "/sw.js")).body, /google-analytics\.com\/g\/collect/);
    assert.equal((await get(SHOP, "/cart.js")).status, 200);
    await get(SHOP, "/cors", { signature: "sig1=:c2VjcmV0:" });
    const other = await get(SHOP, "/redirect-other?from=t");
    assert.equal(other.status, 302);
    const toHttp = await new Promise((ok, bad) => {
      const req = httpRequest({ host: "127.0.0.1", port: fixture.port, path: "/landed?via=plain", headers: { host: SHOP } }, (res) => {
        res.resume();
        res.on("end", () => ok(res.statusCode));
      });
      req.on("error", bad);
      req.end();
    });
    assert.equal(toHttp, 200);
    const logged = readFileSync(fixture.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(logged.length, 8);
    assert.deepEqual(logged.slice(-2).map((r) => r.scheme), ["https", "http"]);
    assert.equal(logged.find((r) => r.path === "/cors").signature, true);
    assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /c2VjcmV0/);
    assert.equal(fixture.switches.length, 2);
    for (const host of [...FIXTURE_HOSTS, ...VENDOR_HOSTS]) assert.ok(fixture.switches[0].includes(`MAP ${host} 127.0.0.1:${fixture.port}`), host);
  } finally {
    await fixture.close();
  }
});

test("crawler-launch prints its help and refuses bad arguments without launching", () => {
  const launcher = fileURLToPath(new URL("../agent/crawler-launch", import.meta.url));
  const help = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /crawler-launch <app>/);
  assert.doesNotMatch(help.stdout, /^\/\//m);
  assert.equal(spawnSync(process.execPath, [launcher, "a.app", "--bogus"], { encoding: "utf8" }).status, 64);
  assert.equal(spawnSync(process.execPath, [launcher, "a.app", "--timeout", "900"], { encoding: "utf8" }).status, 64);
  const installed = spawnSync(process.execPath, [launcher, "/Applications/Ardia.app", "--data-dir", join(scratch(), "d")], { encoding: "utf8" });
  assert.equal(installed.status, 1);
  assert.match(installed.stdout, /never an installed app/);
  assert.doesNotMatch(installed.stdout, /"port"/);
});

test("crawler-launch refuses Shopify signatures together with a NetLog, however the NetLog is asked for", () => {
  const launcher = fileURLToPath(new URL("../agent/crawler-launch", import.meta.url));
  const dir = scratch();
  const signatures = join(dir, "signatures.json");
  writeFileSync(signatures, "[]", { mode: 0o600 });
  const app = join(dir, "Missing.app");
  for (const extra of [["--net-log", join(dir, "n.json")], ["--switch", `--log-net-log=${join(dir, "n.json")}`], ["--switch", "--net-log-capture-mode=Everything"],
    ["--switch", `log-net-log=${join(dir, "n.json")}`], ["--switch", "log-net-log"], ["--switch", "net-log-capture-mode=Everything"], ["--switch", "--net-log-max-size=10"],
    ["--switch", `--ignore-certificate-errors --log-net-log=${join(dir, "n.json")}`], ["--switch", "--ignore-certificate-errors", "--switch", "net-log-capture-mode=IncludeSensitive"]]) {
    const r = spawnSync(process.execPath, [launcher, app, "--shopify-signatures", signatures, "--data-dir", join(dir, "d"), ...extra], { encoding: "utf8" });
    assert.equal(r.status, 2, extra.join(" "));
    assert.match(r.stderr, /refuses .*signatures.*NetLog|NetLog.*signatures/i, extra.join(" "));
    assert.doesNotMatch(r.stdout, /"port"/);
  }
  const unsigned = spawnSync(process.execPath, [launcher, app, "--net-log", join(dir, "n.json"), "--data-dir", join(dir, "d2")], { encoding: "utf8" });
  assert.notEqual(unsigned.status, 2);
});

test("the launcher's status check: an old ready status in a reused data dir isn't this launch's", () => {
  const dir = scratch();
  const file = join(dir, "status.json");
  const probe = fileURLToPath(new URL("./launch-status.mjs", import.meta.url));
  const startedMs = Date.parse("2026-11-19T05:40:00Z");
  const write = (status) => writeFileSync(file, JSON.stringify({ version: 1, rulesVersion: "2026-11-18.2", ...status }));
  const run = (pid = 4242) => spawnSync(process.execPath, [probe, file, String(pid), String(startedMs)], { encoding: "utf8" }).status;
  const ready = { "": { name: "Default", ready: true, reason: null } };
  write({ pid: 999, startedAt: "2026-11-19T05:36:07Z", profiles: ready });
  assert.equal(run(), 1, "old app's pid");
  assert.equal(launchVerdict(JSON.parse(readFileSync(file, "utf8")), 4242, startedMs).stale, true);
  write({ pid: 4242, startedAt: "2026-11-19T05:36:07Z", profiles: ready });
  assert.equal(run(), 1, "pid reused, startedAt from the old launch");
  write({ profiles: ready });
  assert.equal(run(), 1, "no pid at all");
  write({ pid: 4242, startedAt: "2026-11-19T05:40:01Z", profiles: {} });
  assert.equal(run(), 1, "no profiles yet");
  write({ pid: 4242, startedAt: "2026-11-19T05:40:01Z", profiles: { "": { ready: false, reason: null } } });
  assert.equal(run(), 1, "still getting ready");
  write({ pid: 4242, startedAt: "2026-11-19T05:40:01Z", profiles: { "": { ready: false, reason: "selftest_failed" } } });
  assert.equal(run(), 0, "settled, not ready");
  assert.deepEqual(launchVerdict(JSON.parse(readFileSync(file, "utf8")), 4242, startedMs).notReady, [{ id: "", name: "Default", reason: "selftest_failed" }]);
  write({ pid: 4242, startedAt: "2026-11-19T05:40:01Z", profiles: ready });
  assert.equal(run(), 0, "this launch, ready");
  assert.equal(launchVerdict(JSON.parse(readFileSync(file, "utf8")), 4242, startedMs).ready, true);
});

test("the NetLog switch check normalizes switches the way the app does", () => {
  assert.deepEqual(appSwitches(["log-net-log=/x", "--ignore-certificate-errors"]), ["--log-net-log=/x", "--ignore-certificate-errors"]);
  for (const list of [["log-net-log=/x"], ["--log-net-log=/x"], ["log-net-log"], ["--net-log-capture-mode=Everything"], ["net-log-capture-mode", "Everything"], ["--a --net-log-max-size=3"]]) {
    assert.ok(netLogSwitchIn(list), list.join(" "));
  }
  assert.equal(netLogSwitchIn(["--host-rules=MAP a 127.0.0.1:1,MAP b 127.0.0.1:1", "--ignore-certificate-errors"]), null);
});
