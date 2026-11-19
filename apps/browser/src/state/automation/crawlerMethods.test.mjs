import assert from "node:assert/strict";
import { test } from "node:test";

const entry = (profileId, extra = {}) => ({
  profileId, name: "Crawler", source: "profile", ready: true, reason: null, detail: null, readySince: "2026-11-18T21:04:05Z",
  navigationHeader: true, shopify: [], blocked: {}, ...extra,
});

let nativeState = { instanceMode: false, rulesVersion: "1", profiles: [] };
let resetReply = null;
const resets = [];
globalThis.acTestNativeModules = {
  ArdiaCrawler: {
    call: async (verb, _profile, json) => {
      if (verb === "state") return JSON.stringify(nativeState);
      if (verb === "reset") {
        resets.push(JSON.parse(json));
        return JSON.stringify(resetReply);
      }
      return "null";
    },
    addListener: () => ({ remove: () => {} }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { crawlerEngineProfile } = await import("../crawler/crawler.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 9, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  for (let i = 0; i < 100 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 9); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 9);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const work = S().createProfile({ name: "Work" });
  const shop = S().createProfile({ name: "Crawler" });
  return { work, shop, engine: crawlerEngineProfile(S(), shop) };
}

test("crawler.profile finds a crawler profile by name or id and says whether it's ready", async () => {
  const { shop, engine } = await setup();
  nativeState = { instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] };
  for (const name of ["Crawler", "crawler", shop]) {
    const reply = await call("crawler.profile", { profile: name });
    assert.deepEqual(reply.result, { id: shop, name: "Crawler", engineProfile: engine, ready: true, reason: null }, name);
  }
  nativeState = { instanceMode: false, rulesVersion: "1", profiles: [entry(engine, { ready: false, reason: "selftest_failed" })] };
  const notReady = await call("crawler.profile", { profile: "Crawler" });
  assert.equal(notReady.result.ready, false);
  assert.equal(notReady.result.reason, "selftest_failed");
});

test("other profiles are refused, unknown ones aren't there, and junk is a bad request", async () => {
  const { engine } = await setup();
  nativeState = { instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] };
  assert.equal((await call("crawler.profile", { profile: "Work" })).error.code, "refused");
  assert.equal((await call("crawler.reset", { profile: "Work" })).error.code, "refused");
  assert.equal((await call("crawler.profile", { profile: "Nope" })).error.code, "no_window");
  assert.equal((await call("crawler.reset", {})).error.code, "bad_request");
  assert.equal((await call("crawler.reset", { profile: "Crawler", extra: 1 })).error.code, "bad_request");
  assert.equal((await call("crawler.profile", { profile: 3 })).error.code, "bad_request");
});

test("in a crawler instance every profile is a crawler profile", async () => {
  const { work } = await setup();
  nativeState = { instanceMode: true, rulesVersion: "1", profiles: [entry(crawlerEngineProfile(S(), work), { source: "instance" })] };
  const reply = await call("crawler.profile", { profile: "Work" });
  assert.equal(reply.result.ready, true);
  assert.equal(reply.result.id, work);
});

test("crawler.reset clears the engine profile and reports the native problem", async () => {
  const { shop, engine } = await setup();
  nativeState = { instanceMode: false, rulesVersion: "1", profiles: [entry(engine)] };
  resets.length = 0;
  resetReply = null;
  const done = await call("crawler.reset", { profile: "Crawler" });
  assert.deepEqual(done.result, { ok: true, profile: shop, name: "Crawler", engineProfile: engine });
  assert.deepEqual(resets, [{ profileId: engine }]);
  resetReply = "not a crawler profile";
  const failed = await call("crawler.reset", { profile: shop });
  assert.equal(failed.error.code, "failed");
  assert.match(failed.error.message, /not a crawler profile/);
});

test("two profiles with one name are refused by name and found by id", async () => {
  const { shop } = await setup();
  const twin = S().createProfile({ name: "crawler" });
  nativeState = { instanceMode: true, rulesVersion: "1", profiles: [] };
  const reply = await call("crawler.profile", { profile: "Crawler" });
  assert.equal(reply.error.code, "bad_request");
  assert.match(reply.error.message, new RegExp(`${shop}.*${twin}|${twin}.*${shop}`));
  assert.equal((await call("crawler.profile", { profile: twin })).result.id, twin);
});
