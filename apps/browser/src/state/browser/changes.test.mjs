import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
const { changedIds } = await import("./changes.ts");

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("changed, added and removed ids are listed, and the same pair is answered from memory", () => {
  const a = { id: "a" };
  const prev = { a, b: { id: "b" }, c: { id: "c" } };
  const next = { a, b: { id: "b" }, d: { id: "d" } };
  const ids = changedIds(next, prev);
  assert.deepEqual([...ids].sort(), ["b", "c", "d"]);
  assert.equal(changedIds(next, prev), ids);
  assert.deepEqual(changedIds(next, next), []);
  assert.deepEqual([...changedIds(prev, next)].sort(), ["b", "c", "d"]);
});

test("a snapshot the store has moved past is let go", async () => {
  let current = { t0: { n: 0 } };
  const first = new WeakRef(current);
  const middle = [];
  for (let i = 1; i <= 400; i++) {
    const next = { ...current, t0: { n: i } };
    assert.deepEqual(changedIds(next, current), ["t0"]);
    if (i === 200) middle.push(new WeakRef(next));
    current = next;
  }
  await nextTurn();
  collect();
  assert.equal(first.deref(), undefined);
  assert.equal(middle[0].deref(), undefined);
  assert.equal(current.t0.n, 400);
});
