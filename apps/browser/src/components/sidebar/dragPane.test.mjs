import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { mixedScene } = await import("./fixtures/dragWorld.mjs");
const { splitOf } = await import("../../state/splits/splits.ts");
const { S, entryKey, mount, centre } = D;

const frameOf = (m, key) => m.L.entries.find((e) => e.key === key).frame;
const listOrder = (m) => D.committed(m.w).tabIds.filter((id) => [m.id.a, m.id.b, m.id.s1, m.id.s2, m.id.c].includes(id));

test("dragging one pane out of a split row drops only that tab and ends the split", async () => {
  const m = mixedScene();
  const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
  const pane = frameOf(m, entryKey("tab", m.id.s2));
  const row = frameOf(m, entryKey("split", m.SP));
  const last = frameOf(m, entryKey("tab", m.id.c));
  const read = await D.drag(c, entryKey("tab", m.id.s2), centre(pane), { x: 60, y: last.y + last.h + 20 });
  assert.equal(read.drop.type, "tabs");
  assert.equal(ghosts.at(-1).width, row.w, "the ghost is a full row, not half of one");
  c.end(true);
  await D.settle();
  assert.equal(splitOf(S(), m.id.s2), undefined);
  assert.equal(splitOf(S(), m.id.s1), undefined);
  assert.equal(listOrder(m).at(-1), m.id.s2);
});

test("a pane dropped above its own row lands before the tab it was split with", async () => {
  const m = mixedScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const pane = frameOf(m, entryKey("tab", m.id.s2));
  const above = frameOf(m, entryKey("tab", m.id.b));
  await D.drag(c, entryKey("tab", m.id.s2), centre(pane), { x: 60, y: above.y + 2 });
  c.end(true);
  await D.settle();
  assert.equal(splitOf(S(), m.id.s1), undefined);
  const order = listOrder(m);
  assert.equal(order.indexOf(m.id.s2), order.indexOf(m.id.b) - 1);
});

test("a cancelled pane drag leaves the split as it was", async () => {
  const m = mixedScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const pane = frameOf(m, entryKey("tab", m.id.s1));
  const last = frameOf(m, entryKey("tab", m.id.c));
  const before = listOrder(m);
  await D.drag(c, entryKey("tab", m.id.s1), centre(pane), { x: 60, y: last.y + last.h + 20 });
  c.end(false);
  await D.settle();
  assert.equal(splitOf(S(), m.id.s1)?.id, m.SP);
  assert.deepEqual(listOrder(m), before);
});

test("the whole split row still drags as one and keeps its panes together", async () => {
  const m = mixedScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const row = frameOf(m, entryKey("split", m.SP));
  const first = frameOf(m, entryKey("tab", m.id.a));
  await D.drag(c, entryKey("split", m.SP), centre(row), { x: 60, y: first.y + 2 });
  c.end(true);
  await D.settle();
  assert.equal(splitOf(S(), m.id.s1)?.id, m.SP);
  assert.deepEqual(listOrder(m), [m.id.s1, m.id.s2, m.id.a, m.id.b, m.id.c]);
});
