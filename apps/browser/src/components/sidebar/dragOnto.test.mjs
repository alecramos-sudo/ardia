import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { mixedScene } = await import("./fixtures/dragWorld.mjs");
const { S, entryKey, mount, centre } = D;

const frameOf = (m, key) => m.L.entries.find((e) => e.key === key).frame;

async function dropOnCentre(grouping) {
  const m = mixedScene();
  S().updateSettings({ dragToGroupInSidebar: grouping });
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const read = await D.drag(c, entryKey("tab", m.id.c), centre(frameOf(m, entryKey("tab", m.id.c))), centre(frameOf(m, entryKey("tab", m.id.b))));
  c.end(true);
  await D.settle();
  return { m, drop: read.drop, groups: Object.values(S().groups).filter((g) => g.tabIds.includes(m.id.c)) };
}

test("with grouping on, a tab dropped on the middle of another makes a group of the two", async () => {
  const { m, drop, groups } = await dropOnCentre(true);
  assert.equal(drop.type, "onto");
  assert.equal(groups.length, 1);
  assert.ok(groups[0].tabIds.includes(m.id.b));
});

test("with grouping off, the same drop only reorders", async () => {
  const { drop, groups } = await dropOnCentre(false);
  assert.equal(drop.type, "tabs");
  assert.deepEqual(groups, []);
});

test("grouping in the sidebar is off unless chosen", async () => {
  const { DEFAULT_SETTINGS } = await import("../../state/settings/settings.ts");
  assert.equal(DEFAULT_SETTINGS.dragToGroupInSidebar, false);
});
