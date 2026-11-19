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

test("a cancel after completion leaves no record that can cancel a later start", async () => {
  const page = extensionPage(["B"]);
  await page.call("start", "B", PRESET, "op-B");
  await page.call("cancel", "B", "op-B");
  const answer = await page.call("start", "B", PRESET, "op-B");
  assert.deepEqual(answer, { value: { targetId: "B" } });
});

test("a start cancelled while it runs detaches and doesn't count as a queued cancellation", async () => {
  const page = extensionPage(["B"]);
  let release;
  page.chrome.debugger.attach = ({ targetId }) => new Promise((resolve) => (release = () => resolve(void page.chrome.attached.add(targetId))));
  const started = page.call("start", "B", PRESET, "op-B");
  await new Promise((resolve) => setImmediate(resolve));
  const canceled = page.call("cancel", "B", "op-B");
  release();
  await canceled;
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

test("cancel acknowledges detach without waiting for a late attach, which then cleans itself up", async () => {
  const page = extensionPage(["A", "B"]);
  await page.call("start", "A", PRESET, "op-A");
  let release;
  page.chrome.debugger.attach = ({ targetId }) => new Promise((resolve) => (release = () => resolve(void page.chrome.attached.add(targetId))));
  const started = page.call("start", "B", PRESET, "op-B");
  await new Promise((resolve) => setImmediate(resolve));
  let cleaned = false;
  const canceled = page.call("cancel", "B", "op-B").then(() => { cleaned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
  assert.equal(page.chrome.attached.has("A"), true);
  release();
  assert.match((await started).error, /^canceled:/);
  await canceled;
  assert.equal(page.chrome.attached.has("B"), false);
  assert.deepEqual(page.chrome.commands.filter(([t]) => t === "B"), []);
  assert.equal(page.chrome.attached.has("A"), true);
});

test("cancel clears partly applied mobile overrides before answering while the old command remains pending", async () => {
  const page = extensionPage(["B"]);
  let release;
  let mobile = false;
  page.chrome.debugger.sendCommand = async (_, method) => {
    if (method === "Emulation.setDeviceMetricsOverride") {
      mobile = true;
      await new Promise((resolve) => { release = resolve; });
    }
  };
  page.chrome.debugger.detach = async ({ targetId }) => { page.chrome.attached.delete(targetId); mobile = false; };
  const started = page.call("start", "B", PRESET, "op-B");
  await new Promise((resolve) => setImmediate(resolve));
  let cleaned = false;
  const canceled = page.call("cancel", "B", "op-B").then(() => { cleaned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
  assert.equal(mobile, false);
  release();
  assert.match((await started).error, /^canceled:/);
  await canceled;
  assert.equal(mobile, false);
  assert.equal(page.chrome.attached.has("B"), false);
});

test("cancel detaches immediately while a target command is still stalled", async () => {
  const page = extensionPage(["B"]);
  let release;
  page.chrome.debugger.sendCommand = async (_, method) => {
    if (method === "Inspector.enable") await new Promise((resolve) => { release = resolve; });
  };
  const started = page.call("start", "B", PRESET, "old");
  await new Promise((resolve) => setImmediate(resolve));
  const canceled = page.call("cancel", "B", "old");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.chrome.attached.has("B"), false);
  release();
  await started;
  await canceled;
});

test("an old giveUp leaves a newer session on the same tab attached", async () => {
  const page = extensionPage(["B"]);
  let release;
  let first = true;
  page.chrome.debugger.sendCommand = async () => {
    if (first) {
      first = false;
      await new Promise((resolve) => { release = resolve; });
    }
  };
  const old = page.call("start", "B", PRESET, "old");
  await new Promise((resolve) => setImmediate(resolve));
  const canceled = page.call("cancel", "B", "old");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await page.call("start", "B", PRESET, "new"), { value: { targetId: "B" } });
  release();
  assert.match((await old).error, /^canceled:/);
  await canceled;
  assert.equal(page.chrome.attached.has("B"), true);
  assert.deepEqual(await page.call("stop", "B", "new"), { value: true });
});
