#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: scripts/crawler/launch-status.mjs <status.json> <pid> <started ms>

Exit 0 when the crawler status file was written by this launch (top-level pid equals <pid>, startedAt within 2 s of
<started ms>, the process start time) and every crawler profile in it has settled (ready, or not ready with a reason);
exit 1 otherwise. crawler-launch waits on it through scripts/agent/await.`;

export const STARTED_SLACK_MS = 2000;

export function readStatusFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function freshness(status, pid, startedMs) {
  if (!status || typeof status !== "object") return { fresh: false, why: "no status file yet" };
  if (status.pid !== pid) return { fresh: false, why: `written by pid ${status.pid ?? "none"}, not ${pid}` };
  const startedAt = typeof status.startedAt === "string" ? Date.parse(status.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return { fresh: false, why: "no startedAt" };
  if (Number.isFinite(startedMs) && Math.abs(startedAt - startedMs) > STARTED_SLACK_MS) {
    return { fresh: false, why: `startedAt ${status.startedAt} isn't this launch's start` };
  }
  return { fresh: true, why: null };
}

export function verdict(status, pid, startedMs) {
  const fresh = freshness(status, pid, startedMs);
  if (!fresh.fresh) return { settled: false, ready: false, stale: true, why: fresh.why, notReady: [] };
  const profiles = Object.entries(status.profiles && typeof status.profiles === "object" ? status.profiles : {});
  if (!profiles.length) return { settled: false, ready: false, stale: false, why: "no crawler profiles yet", notReady: [] };
  const notReady = profiles.filter(([, p]) => !p?.ready).map(([id, p]) => ({ id, name: p?.name ?? (id || "Default"), reason: p?.reason ?? null }));
  const settled = notReady.every((p) => p.reason);
  return { settled, ready: notReady.length === 0, stale: false, why: notReady.length ? "not ready" : null, notReady };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [path, pid, started] = process.argv.slice(2);
  if (!path || path === "-h" || path === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(path ? 0 : 64);
  }
  process.exit(verdict(readStatusFile(path), Number(pid), Number(started)).settled ? 0 : 1);
}
