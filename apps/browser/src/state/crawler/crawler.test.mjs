import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const notReady = [];
globalThis.crawlerTestNotReady = notReady;
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/state/crawler/actions.ts") || specifier !== "../telemetry/errors") return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent("export const captureCrawlerNotReady = (reason) => globalThis.crawlerTestNotReady.push(reason);")}`, shortCircuit: true };
  },
});

const entry = (profileId, extra = {}) => ({
  profileId,
  name: "Crawler",
  source: "profile",
  ready: true,
  reason: null,
  detail: null,
  readySince: "2026-11-18T21:04:05Z",
  navigationHeader: true,
  shopify: [],
  blocked: {},
  ...extra,
});

let nativeState = { instanceMode: false, rulesVersion: "2026-11-18.1", profiles: [] };
let setProfileReply = null;
const calls = [];
const listeners = new Set();
globalThis.acTestNativeModules = {
  ArdiaCrawler: {
    call: async (verb, _profile, json) => {
      calls.push({ verb, args: JSON.parse(json) });
      if (verb === "state") return JSON.stringify(nativeState);
      if (verb === "setProfile") return JSON.stringify(setProfileReply);
      return "null";
    },
    addListener: (_channel, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  },
};
const emit = (state) => {
  for (const listener of [...listeners]) listener({ name: "crawler.changed", data: state });
};

const { useBrowser } = await import("../browser/store.ts");
const { incognitoProfileId } = await import("../browser/model.ts");
const crawler = { ...(await import("./crawler.ts")), ...(await import("./actions.ts")) };

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function profiles() {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const twin = S().createProfile({ name: "Work Twin", shareWith: work });
  const other = S().createProfile({ name: "Other" });
  return { work, twin, other, engine: crawler.crawlerEngineProfile(S(), work) };
}

test("the state loads at start, and a crawler profile is the engine profile: every app profile sharing its data counts", async () => {
  const { work, twin, other, engine } = profiles();
  nativeState = { instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] };
  crawler.startCrawler();
  crawler.startCrawler();
  await settle();
  assert.equal(listeners.size, 1);
  assert.equal(crawler.isCrawlerProfile(work), true);
  assert.equal(crawler.isCrawlerProfile(twin), true);
  assert.equal(crawler.isCrawlerReady(twin), true);
  assert.equal(crawler.isCrawlerProfile(other), false);
  assert.equal(crawler.isCrawlerProfile("default"), false);
  assert.equal(crawler.crawlerProfileCount(), 1);
});

test("the default profile's engine profile is the empty name", () => {
  S().hydrate({});
  crawler.applyCrawlerState({ instanceMode: false, rulesVersion: "1", profiles: [entry("")] });
  assert.equal(crawler.crawlerEngineProfile(S(), "default"), "");
  assert.equal(crawler.isCrawlerProfile("default"), true);
});

test("an incognito window of a crawler profile is a crawler profile that is never ready", () => {
  const { work, other, engine } = profiles();
  crawler.applyCrawlerState({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] });
  assert.equal(crawler.isCrawlerProfile(incognitoProfileId("w-1", work)), true);
  assert.equal(crawler.isCrawlerReady(incognitoProfileId("w-1", work)), false);
  assert.equal(crawler.isCrawlerProfile(incognitoProfileId("w-1", other)), false);
});

test("in a crawler instance every profile is a crawler profile, ready only once the engine says so", () => {
  const { work, other, engine } = profiles();
  crawler.applyCrawlerState({ instanceMode: true, rulesVersion: "1", profiles: [entry(engine, { source: "instance" })] });
  assert.equal(crawler.isCrawlerProfile(other), true);
  assert.equal(crawler.isCrawlerReady(other), false);
  assert.equal(crawler.isCrawlerReady(work), true);
});

test("before the engine answers, nothing is a crawler profile", () => {
  const { work } = profiles();
  crawler.useCrawler.setState({ state: null });
  assert.equal(crawler.isCrawlerProfile(work), false);
  assert.equal(crawler.crawlerProfileCount(), 0);
});

test("a not-ready reason is reported once when it starts, not again while it lasts", () => {
  const { engine } = profiles();
  notReady.length = 0;
  crawler.applyCrawlerState({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] });
  emit({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine, { ready: false, reason: "timeout" })] });
  emit({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine, { ready: false, reason: "timeout" })] });
  assert.deepEqual(notReady, ["timeout"]);
  emit({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine, { ready: false, reason: "selftest_failed" })] });
  emit({ instanceMode: false, rulesVersion: "1", profiles: [entry(engine, { ready: false, reason: null })] });
  assert.deepEqual(notReady, ["timeout", "selftest_failed"]);
  assert.equal(crawler.currentCrawlerProfile(S().profileOrder.find((id) => crawler.crawlerEngineProfile(S(), id) === engine)).ready, false);
});

test("a crawler profile is created new: a fresh profile, marked crawler before anything opens in it", async () => {
  profiles();
  const before = S().profileOrder.length;
  calls.length = 0;
  setProfileReply = null;
  const made = await crawler.createCrawlerProfile("  ");
  assert.equal(made.problem, null);
  assert.equal(S().profiles[made.profileId].name, "Crawler");
  assert.equal(S().profileOrder.length, before + 1);
  assert.deepEqual(calls.map((c) => c.verb), ["setProfile", "state"]);
  assert.deepEqual(calls[0].args, { profileId: crawler.crawlerEngineProfile(S(), made.profileId), enabled: true, name: "Crawler" });
  assert.equal(Object.values(S().tabs).filter((t) => t.profileId === made.profileId).length, 0);
});

test("when the engine refuses, the new profile is removed again and the reason is shown", async () => {
  profiles();
  const before = S().profileOrder.length;
  setProfileReply = "the crawler extension didn't load (no id)";
  const made = await crawler.createCrawlerProfile("QA Crawler");
  assert.deepEqual(made, { profileId: null, problem: "the crawler extension didn't load (no id)" });
  assert.equal(S().profileOrder.length, before);
  setProfileReply = null;
});

test("actions send the engine profile name, clean what was typed, and reload the state", async () => {
  const { work, engine } = profiles();
  calls.length = 0;
  await crawler.setCrawlerHeaderValue(work, "   ");
  await crawler.setCrawlerHeaderValue(work, " qa; run=7 ");
  await crawler.addCrawlerShopifySignature(work, { domain: " https://Shop.myshopify.com/admin ", signatureInput: " sig1=(); expires=1 ", signature: " sig1=:abc=: " });
  await crawler.removeCrawlerSignature(work, "shop.myshopify.com");
  await crawler.clearCrawlerData(work);
  const writes = calls.filter((c) => c.verb !== "state");
  assert.deepEqual(writes, [
    { verb: "setHeader", args: { profileId: engine, value: null } },
    { verb: "setHeader", args: { profileId: engine, value: "qa; run=7" } },
    { verb: "setShopifySignature", args: { profileId: engine, domain: "shop.myshopify.com", signatureInput: "sig1=(); expires=1", signature: "sig1=:abc=:" } },
    { verb: "removeShopifySignature", args: { profileId: engine, domain: "shop.myshopify.com" } },
    { verb: "reset", args: { profileId: engine } },
  ]);
  assert.equal(calls.filter((c) => c.verb === "state").length, writes.length);
});

test("not-ready reasons read as plain words", () => {
  assert.equal(crawler.crawlerNotReadyText(null), "Getting ready…");
  for (const reason of ["selftest_failed", "configure_failed", "timeout", "refused_not_scratch", "other"]) {
    const text = crawler.crawlerNotReadyText(reason);
    assert.ok(text && !text.includes("_"), reason);
  }
});

test("a signature row says when it expires, and an expired one says it isn't sent", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: "2026-11-01T00:00:00Z", sent: false }, now), "Expired, not sent");
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: "2026-11-01T00:00:00Z", sent: true }, now), "Expired, not sent");
  assert.match(crawler.crawlerSignatureStatus({ domain: "a.com", expires: "2027-02-16T00:00:00Z", sent: true }, now), /^Expires .*2027/);
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: null, sent: true }, now), "Sent");
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: null, sent: false }, now), "Not sent");
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: "2027-02-16T00:00:00Z", sent: false, detail: "NetLog is on" }, now), "Not sent: NetLog is on");
  assert.equal(crawler.crawlerSignatureStatus({ domain: "a.com", expires: "2027-02-16T00:00:00Z", sent: false, detail: "expired" }, now), "Expired, not sent");
});
