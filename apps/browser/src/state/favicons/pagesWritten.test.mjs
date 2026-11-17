import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
const { pagesWrittenSince, withPages } = await import("./pagesWritten.ts");

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const write = (pages, n) => withPages(pages, [[`https://site.example/${n}`, `icon-${n}`]]);

test("the pages written between two snapshots are listed for up to 16 writes, then unknown", () => {
  const start = {};
  let pages = start;
  const snapshots = [start];
  for (let n = 1; n <= 20; n++) snapshots.push((pages = write(pages, n)));
  assert.deepEqual(pagesWrittenSince(pages, pages), []);
  assert.deepEqual(pagesWrittenSince(pages, snapshots[19]), ["https://site.example/20"]);
  assert.deepEqual(
    pagesWrittenSince(pages, snapshots[4]),
    Array.from({ length: 16 }, (_, i) => `https://site.example/${20 - i}`),
  );
  assert.equal(pagesWrittenSince(pages, snapshots[3]), null);
  assert.equal(pagesWrittenSince(pages, start), null);
  assert.equal(pagesWrittenSince(pages, {}), null);
});

test("a page list from many writes back is let go", async () => {
  let pages = {};
  const first = new WeakRef(pages);
  const early = [];
  for (let n = 1; n <= 300; n++) {
    pages = write(pages, n);
    if (n === 100) early.push(new WeakRef(pages));
  }
  await nextTurn();
  collect();
  assert.equal(first.deref(), undefined);
  assert.equal(early[0].deref(), undefined);
  assert.equal(pages["https://site.example/300"], "icon-300");
});
