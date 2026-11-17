import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const heap = { size: 900, collections: 0, shrinkBy: 100, takesMs: 0, clock: null };
globalThis.HermesInternal = { getInstrumentedStats: () => ({ js_heapSize: heap.size }) };
globalThis.gc = () => {
  heap.collections++;
  heap.size -= heap.shrinkBy;
  if (heap.takesMs) heap.clock.setTime(Date.now() + heap.takesMs);
};

const { useBrowser } = await import("../browser/store.ts");
const { startMemoryTrim } = await import("./memoryTrim.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("closing a tab compacts the heap in quick steps, and one slow collection ends compaction for good", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  heap.clock = t.mock.timers;
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  startMemoryTrim();

  const changeTabCount = () => S().newTab(w, { url: "https://b.example/", background: true });
  const runSteps = () => {
    for (let i = 0; i < 12; i++) t.mock.timers.tick(250);
  };
  const runTrim = () => {
    t.mock.timers.tick(5000);
    runSteps();
  };

  changeTabCount();
  t.mock.timers.tick(4999);
  assert.equal(heap.collections, 0);
  t.mock.timers.tick(1);
  assert.equal(heap.collections, 1);
  runSteps();
  assert.equal(heap.collections, 8);

  t.mock.timers.tick(30000);
  heap.collections = 0;
  heap.takesMs = 400;
  changeTabCount();
  runTrim();
  assert.equal(heap.collections, 1);

  t.mock.timers.tick(30000);
  heap.takesMs = 0;
  changeTabCount();
  runTrim();
  assert.equal(heap.collections, 1);
  await settle();
});
