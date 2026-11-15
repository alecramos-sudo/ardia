import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { mixedScene } = await import("./fixtures/dragWorld.mjs");
const { profileRegion } = await import("./dragModel.ts");
const { dragMarksOf } = await import("../../state/sidebar/dragMarks.ts");
const { splitOf } = await import("../../state/splits/splits.ts");
const { S, entryKey, mount, centre } = D;

const DOT = { x: 96, y: 840, w: 12, h: 28 };
const frameOf = (m, key) => m.L.entries.find((e) => e.key === key).frame;
const onDot = centre(DOT);

function scene() {
  const m = mixedScene();
  const home = S().windows[m.w].profileId;
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(m.w, home);
  S().updateSettings({ warnBeforeMovingTabsToProfile: false });
  const mounted = mount({ entries: m.L.entries, regions: { ...m.regions, [profileRegion(work)]: DOT } });
  return { ...m, ...mounted, home, work };
}

const profileOf = (id) => S().tabs[id].profileId;

test("a tab dragged onto another profile's switcher mark moves to that profile", async () => {
  const m = scene();
  const read = await D.drag(m.c, entryKey("tab", m.id.b), centre(frameOf(m, entryKey("tab", m.id.b))), onDot);
  assert.deepEqual(read.drop, { type: "profile", profileId: m.work });
  assert.equal(read.gapKey, null);
  assert.equal(dragMarksOf(m.c.marks).profile, m.work);
  m.c.end(true);
  await D.settle();
  assert.equal(profileOf(m.id.b), m.work);
  assert.equal(profileOf(m.id.a), m.home);
  assert.equal(dragMarksOf(m.c.marks).profile, null);
  assert.equal(S().windows[m.w].activeTabIds[m.work], m.id.b);
});

test("the mark is a target only while the pointer is on it, and a cancelled drag moves nothing", async () => {
  const m = scene();
  const from = centre(frameOf(m, entryKey("tab", m.id.b)));
  const near = { x: DOT.x + DOT.w + 30, y: onDot.y };
  let read = await D.drag(m.c, entryKey("tab", m.id.b), from, [onDot, near]);
  assert.notEqual(read.drop.type, "profile");
  assert.equal(dragMarksOf(m.c.marks).profile, null);
  m.c.move(onDot.x, onDot.y);
  assert.equal(dragMarksOf(m.c.marks).profile, m.work);
  m.c.end(false);
  await D.settle();
  assert.equal(profileOf(m.id.b), m.home);
});

test("selected tabs dragged onto a profile all move, top one first", async () => {
  const m = scene();
  S().setSelection(m.w, [m.id.c, m.id.a]);
  const read = await D.drag(m.c, entryKey("tab", m.id.c), centre(frameOf(m, entryKey("tab", m.id.c))), onDot);
  assert.equal(read.drop.type, "profile");
  m.c.end(true);
  await D.settle();
  assert.deepEqual([m.id.a, m.id.c].map(profileOf), [m.work, m.work]);
  const moved = S().windows[m.w].tabIds.filter((id) => profileOf(id) === m.work);
  assert.ok(moved.indexOf(m.id.a) < moved.indexOf(m.id.c));
  assert.equal(profileOf(m.id.b), m.home);
});

test("a group dragged onto a profile moves with its tabs and stays a group", async () => {
  const m = scene();
  const read = await D.drag(m.c, entryKey("group", m.G), centre(frameOf(m, entryKey("group", m.G)), -1000), onDot);
  assert.deepEqual(read.drop, { type: "profile", profileId: m.work, groupId: m.G });
  m.c.end(true);
  await D.settle();
  assert.deepEqual([m.id.g1, m.id.h1, m.id.g2].map(profileOf), [m.work, m.work, m.work]);
  const group = Object.values(S().groups).find((g) => g.profileId === m.work && !g.parentId);
  assert.deepEqual(group?.tabIds, [m.id.g1, m.id.h1, m.id.g2]);
  assert.equal(group?.name, "G");
});

test("a split row dragged onto a profile moves both panes together", async () => {
  const m = scene();
  const read = await D.drag(m.c, entryKey("split", m.SP), centre(frameOf(m, entryKey("split", m.SP))), onDot);
  assert.equal(read.drop.type, "profile");
  m.c.end(true);
  await D.settle();
  assert.deepEqual([m.id.s1, m.id.s2].map(profileOf), [m.work, m.work]);
  assert.equal(splitOf(S(), m.id.s1)?.id, splitOf(S(), m.id.s2)?.id);
  assert.ok(splitOf(S(), m.id.s1));
});

test("the list does not scroll while the pointer rests on a profile mark below it", async () => {
  const m = scene();
  await D.drag(m.c, entryKey("tab", m.id.b), centre(frameOf(m, entryKey("tab", m.id.b))), onDot);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(m.c.scroll.scrolled, []);
  m.c.end(false);
});
