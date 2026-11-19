#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCrawlerMatcher } from "../../packages/ardiacore/scripts/crawler-rules.mjs";

const USAGE = `usage: scripts/crawler/netlog-check.mjs <netlog.json> [--expect-blocked | --expect-leaks] [--vendors a,b,…] [--first-party host,…] [--json]

Lists every http(s) and ws(s) URL Chrome's network stack started (URL_REQUEST_START_JOB in a --log-net-log file; a
request the crawler ruleset blocks never gets one), classifies each with the crawler ruleset, and lists every
distinct third-party host for review. A file cut off by a crash is read up to its last whole event.

  --expect-blocked   crawler on: pass only when no tracker request left
  --expect-leaks     control run: pass only when tracker requests did leave (every --vendors vendor, if given);
                     none means the detector is broken
  --first-party      hosts that aren't third parties (the fixture's own)

Exit status: 0 pass (or report only), 1 fail, 2 the file can't be read or has no URL requests at all.`;

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export function parseNetLog(text) {
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === "object" && Array.isArray(whole.events)) return { constants: whole.constants ?? {}, events: whole.events, truncated: false, unreadable: 0 };
  } catch {
    if (!text.trim()) throw new Error("the file is empty");
  }
  const marker = text.search(/,\s*"events"\s*:\s*\[/);
  if (marker < 0) throw new Error("not a NetLog file: no events list");
  const constants = JSON.parse(`${text.slice(0, marker)}}`).constants ?? {};
  const events = [];
  let unreadable = 0;
  for (const line of text.slice(text.indexOf("[", marker) + 1).split("\n")) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      unreadable += 1;
    }
  }
  return { constants, events, truncated: true, unreadable };
}

export function sentRequests({ constants, events }) {
  const eventType = constants.logEventTypes?.URL_REQUEST_START_JOB;
  const sourceType = constants.logSourceType?.URL_REQUEST;
  const begin = constants.logEventPhase?.PHASE_BEGIN ?? 1;
  if (eventType === undefined) throw new Error("the NetLog's constants have no URL_REQUEST_START_JOB");
  const out = [];
  for (const event of events) {
    if (event?.type !== eventType || (sourceType !== undefined && event.source?.type !== sourceType)) continue;
    if (event.phase !== undefined && event.phase !== begin) continue;
    const url = event.params?.url;
    if (typeof url !== "string") continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!NETWORK_SCHEMES.has(parsed.protocol)) continue;
    out.push({ url, host: parsed.hostname, method: event.params?.method ?? null, initiator: event.params?.initiator ?? null, source: event.source?.id ?? null });
  }
  return out;
}

export function classify(requests, { matcher = createCrawlerMatcher(), firstParty = [] } = {}) {
  const own = new Set(firstParty.map((h) => h.toLowerCase()));
  const trackers = [];
  const hosts = new Map();
  for (const request of requests) {
    const rule = matcher.blockedBy(request.url);
    if (rule) trackers.push({ ...request, vendor: rule.vendor, ruleId: rule.ruleId });
    if (!own.has(request.host)) hosts.set(request.host, (hosts.get(request.host) ?? 0) + 1);
  }
  const vendors = {};
  for (const t of trackers) vendors[t.vendor] = (vendors[t.vendor] ?? 0) + 1;
  return {
    requests: requests.length,
    trackers,
    vendors,
    thirdPartyHosts: [...hosts].sort(([a], [b]) => a.localeCompare(b)).map(([host, count]) => ({ host, count })),
  };
}

export function verdict(report, { expect = null, vendors = [] } = {}) {
  if (!report.requests) return { pass: false, why: "no URL requests at all: the NetLog is empty or wasn't written" };
  if (expect === "blocked") {
    return report.trackers.length === 0
      ? { pass: true, why: "no tracker request left the browser" }
      : { pass: false, why: `${report.trackers.length} tracker requests left: ${Object.entries(report.vendors).map(([v, n]) => `${v} ${n}`).join(", ")}` };
  }
  if (expect === "leaks") {
    if (!report.trackers.length) return { pass: false, why: "no tracker requests in the control run: the detector is broken" };
    const missing = vendors.filter((v) => !report.vendors[v]);
    return missing.length
      ? { pass: false, why: `the control run never contacted ${missing.join(", ")}: the detector or the fixture is broken` }
      : { pass: true, why: `trackers left as expected: ${Object.entries(report.vendors).map(([v, n]) => `${v} ${n}`).join(", ")}` };
  }
  return { pass: true, why: "report only" };
}

export function checkNetLog(path, options = {}) {
  const log = parseNetLog(readFileSync(path, "utf8"));
  const report = classify(sentRequests(log), options);
  return { ...report, truncated: log.truncated, unreadable: log.unreadable, verdict: verdict(report, options) };
}

function main(argv) {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length ? 0 : 2;
  }
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? (argv[at + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  };
  const path = argv.find((a, i) => !a.startsWith("--") && !["--vendors", "--first-party"].includes(argv[i - 1]));
  if (argv.includes("--expect-blocked") && argv.includes("--expect-leaks")) {
    process.stderr.write("netlog-check: give --expect-blocked or --expect-leaks, not both\n");
    return 2;
  }
  const expect = argv.includes("--expect-blocked") ? "blocked" : argv.includes("--expect-leaks") ? "leaks" : null;
  let result;
  try {
    result = checkNetLog(path, { expect, vendors: value("--vendors"), firstParty: value("--first-party") });
  } catch (error) {
    process.stderr.write(`netlog-check: ${path}: ${error.message}\n`);
    return 2;
  }
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const lines = [`${result.requests} URL requests${result.truncated ? " (file cut off; read to its last whole event, ${result.unreadable} partial lines skipped)" : ""}`];
    lines.push(`tracker requests that left: ${result.trackers.length}`);
    for (const t of result.trackers) lines.push(`  ${t.vendor}  ${t.method ?? ""} ${t.url}`);
    lines.push(`third-party hosts (${result.thirdPartyHosts.length}):`);
    for (const h of result.thirdPartyHosts) lines.push(`  ${h.host}  ${h.count}`);
    lines.push(`${result.verdict.pass ? "PASS" : "FAIL"}: ${result.verdict.why}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (!result.requests) return 2;
  return result.verdict.pass ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
