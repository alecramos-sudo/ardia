import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../../../../packages/ardiacore/extensions/device-emulation/emulate.js", import.meta.url), "utf8");
const PRESET = { width: 402, height: 874, deviceScaleFactor: 3, scale: 1, maxTouchPoints: 5, userAgent: "iPhone", platform: "iPhone" };

function extensionPage(targets) {
  const chrome = {
    attached: new Set(),
    commands: [],
    debugger: {
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
      getTargets: async () => targets.map((id) => ({ id, type: "page", url: `https://${id}.example/` })),
      attach: async ({ targetId }) => void chrome.attached.add(targetId),
      detach: async ({ targetId }) => void chrome.attached.delete(targetId),
      sendCommand: async ({ targetId }, method) => void chrome.commands.push([targetId, method]),
    },
  };
  const context = vm.createContext({ chrome, Symbol, Map, Set, Promise, Error, JSON, Object, String });
  vm.runInContext(SOURCE, context);
  const api = context.ardiaDeviceEmulation;
  const call = (verb, ...args) =>
    new Promise((resolve) => {
      api[verb]((_, json) => resolve(JSON.parse(json)), ...args);
    });
  return { chrome, call };
}

test("a cancellation outlives any number of later ones until its queued start arrives, which then refuses to run", async () => {
  const page = extensionPage(["B", ...Array.from({ length: 100 }, (_, i) => `T${i}`)]);
  await page.call("cancel", "B", "op-B");
  for (let i = 0; i < 100; i++) await page.call("cancel", `T${i}`, `op-${i}`);
  const answer = await page.call("start", "B", PRESET, "op-B");
  assert.match(answer.error, /^canceled:/);
  assert.equal(page.chrome.attached.has("B"), false);
  assert.deepEqual(page.chrome.commands.filter(([t]) => t === "B"), []);
});

test("a start cancelled while it runs detaches and doesn't count as a queued cancellation", async () => {
  const page = extensionPage(["B"]);
  let release;
  page.chrome.debugger.attach = ({ targetId }) => new Promise((resolve) => (release = () => resolve(void page.chrome.attached.add(targetId))));
  const started = page.call("start", "B", PRESET, "op-B");
  await new Promise((resolve) => setImmediate(resolve));
  await page.call("cancel", "B", "op-B");
  release();
  assert.match((await started).error, /^canceled:/);
  assert.equal(page.chrome.attached.has("B"), false);
  page.chrome.debugger.attach = async ({ targetId }) => void page.chrome.attached.add(targetId);
  assert.deepEqual(await page.call("start", "B", PRESET, "op-B2"), { value: { targetId: "B" } });
  assert.equal(page.chrome.attached.has("B"), true);
});

test("a late stop for an older operation leaves the newer session on that tab alone", async () => {
  const page = extensionPage(["B"]);
  assert.deepEqual(await page.call("start", "B", PRESET, "op-1"), { value: { targetId: "B" } });
  assert.deepEqual(await page.call("start", "B", PRESET, "op-2"), { value: { targetId: "B" } });
  assert.deepEqual(await page.call("stop", "B", "op-1"), { value: false });
  assert.equal(page.chrome.attached.has("B"), true);
  assert.deepEqual(await page.call("stop", "B", "op-2"), { value: true });
  assert.equal(page.chrome.attached.has("B"), false);
});
