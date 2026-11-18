import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const { tabMenuItems, openTabMenu } = await import("./tabMenu.ts");
const { arrangeTabMenu, DEFAULT_TAB_MENU_SHOWN, TAB_MENU_PLACE_IDS, isTabMenuShown, withTabMenuPlace } = await import("./tabMenuLayout.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();

function lines(items, depth = 0) {
  return items.flatMap((it) => {
    const pad = "  ".repeat(depth);
    if (it.separator) return [`${pad}---`];
    const marks = `${it.alternate ? " (alt)" : ""}${it.checked ? " ✓" : ""}${it.enabled === false ? " (off)" : ""}`;
    return [`${pad}${it.title}${marks}`, ...lines(it.children ?? [], depth + 1)];
  });
}

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

const menuOf = (w, id, shown = S().settings.tabMenuShown) => arrangeTabMenu(tabMenuItems(S(), w, S().tabs[id]), { shown, pinned: !!S().tabs[id].pin });

async function choose(w, id, pick) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(pick(shown));
  try {
    await openTabMenu(w, S().tabs[id]);
  } finally {
    shell.showMenu = real;
  }
}

test("a tab's menu is ten commands, with every destination in Move to and the rest under More", () => {
  const { w, ids } = windowWith("a", "b", "c");
  assert.deepEqual(lines(menuOf(w, ids[1])), [
    "Copy Link",
    "Rename…",
    "Duplicate",
    "Open as Split",
    "Move to Pinned in Personal",
    "Move to",
    "  New Group with Tab",
    "  ---",
    "  Profiles (off)",
    "  Personal ✓ (off)",
    "  New Profile…",
    "  ---",
    "  Windows (off)",
    "  New Window",
    "Mute Tab",
    "---",
    "Close",
    "Close Other Tabs",
    "Close Tabs Below",
    "---",
    "More",
    "  Copy Link as Markdown",
    "  Change Icon…",
    "  Open in WebKit",
    "  Move to Top Apps",
    "  Add to Bookmarks…",
    "  Add Bookmark to Folder",
    "    Bookmarks Bar",
    "    Other Bookmarks",
    "    ---",
    "    New Folder…",
    "  Mute Site",
    "  ---",
    "  Close Tabs Above",
  ]);
});

test("a command that was an ⌥ alternate is always visible, and keeps a key only when it has its own", () => {
  const { w, ids } = windowWith("a", "b");
  const more = (id) => menuOf(w, id).find((it) => it.id === "more").children;
  const behind = more(ids[0]).find((it) => it.id === "copyMd");
  assert.deepEqual([behind.alternate, behind.key, behind.modifiers], [undefined, undefined, undefined]);
  const front = more(ids[1]).find((it) => it.id === "copyMd");
  assert.deepEqual([front.alternate, front.key, [...front.modifiers].sort()], [undefined, "c", ["command", "option", "shift"]]);
});

test("a Top App leads with Back to Pinned URL, unpins from the menu, and has no close section", () => {
  const { w, ids } = windowWith("a", "b");
  S().pinTabs([ids[0]], true);
  const menu = menuOf(w, ids[0]);
  assert.deepEqual(lines(menu).filter((l) => !l.startsWith(" ")), [
    "Back to Pinned URL (off)",
    "---",
    "Copy Link",
    "Rename…",
    "Duplicate",
    "Unpin from Top Apps",
    "Move to",
    "Mute Tab",
    "---",
    "More",
  ]);
  const more = menu.find((it) => it.id === "more").children;
  assert.deepEqual(lines(more.filter((it) => it.id === "pinnedPage")), ["Edit Pinned Page", "  Replace Pinned URL with Current (off)", "  ---", "  Edit Pinned URL…"]);
  assert.ok(lines(more).includes("Move to Pinned in Personal"));
});

test("Move to heads unpinned groups with Groups, keeps the Pinned header when there are pinned ones, and lists nothing a private tab can't use", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  S().groupTabs([ids[0]], { name: "Work", pinned: false });
  const moveTo = (id) => lines(menuOf(w, id).find((it) => it.id === "moveTo").children);
  assert.deepEqual(moveTo(ids[3]).slice(0, 5), ["New Group with Tab", "---", "Groups (off)", "Work", "---"]);
  assert.deepEqual(moveTo(ids[0]).slice(0, 3), ["Remove from Group", "---", "Profiles (off)"]);
  S().groupTabs([ids[1]], { name: "Kept" });
  assert.deepEqual(moveTo(ids[3]).slice(0, 7), ["New Group with Tab", "---", "Pinned (off)", "Kept", "---", "Work", "---"]);
  const move = { id: "moveToProfile", title: "Move to Profile", enabled: false, children: [{ value: { kind: "profile", profileId: "p" }, title: "P" }] };
  assert.deepEqual(lines(arrangeTabMenu([{ id: "copy", title: "Copy Link" }, move], { shown: DEFAULT_TAB_MENU_SHOWN, pinned: false })), ["Copy Link"]);
});

test("unticking a command moves it under More, ticking one brings it out, and both keep the menu's order", () => {
  const { w, ids } = windowWith("a", "b");
  const shown = withTabMenuPlace(withTabMenuPlace(DEFAULT_TAB_MENU_SHOWN, "duplicate", false), "closeAbove", true);
  const menu = menuOf(w, ids[1], shown);
  const top = lines(menu).filter((l) => !l.startsWith(" "));
  assert.equal(top.includes("Duplicate"), false);
  assert.deepEqual(top.slice(-6), ["Close", "Close Other Tabs", "Close Tabs Below (off)", "Close Tabs Above", "---", "More"]);
  assert.ok(lines(menu.find((it) => it.id === "more").children).includes("Duplicate"));
  assert.deepEqual(withTabMenuPlace(["close", "copy"], "rename", true), ["copy", "rename", "close"]);
});

test("with every command ticked there is no More, and a command the layout doesn't know still shows under More", () => {
  const { w, ids } = windowWith("a", "b");
  assert.equal(menuOf(w, ids[1], TAB_MENU_PLACE_IDS).some((it) => it.id === "more"), false);
  const extra = arrangeTabMenu([...tabMenuItems(S(), w, S().tabs[ids[1]]), { id: "brandNew", title: "Brand New" }], { shown: TAB_MENU_PLACE_IDS, pinned: false });
  assert.deepEqual(lines(extra.find((it) => it.id === "more").children), ["Brand New"]);
});

test("the setting accepts only known commands", () => {
  assert.equal(isTabMenuShown([...DEFAULT_TAB_MENU_SHOWN]), true);
  assert.equal(isTabMenuShown([]), true);
  assert.equal(isTabMenuShown(["copy", "nope"]), false);
  assert.equal(isTabMenuShown("copy"), false);
  assert.deepEqual(S().settings.tabMenuShown, [...DEFAULT_TAB_MENU_SHOWN]);
});

test("choosing from More and from Move to acts on the tab", async () => {
  const { w, ids } = windowWith("a", "b", "c");
  await choose(w, ids[2], (shown) => shown.find((it) => it.id === "more").children.find((it) => it.id === "closeAbove").id);
  assert.deepEqual(S().windows[w].tabIds, [ids[2]]);
  const { w: w2, ids: ids2 } = windowWith("a", "b");
  await choose(w2, ids2[1], (shown) => shown.find((it) => it.id === "moveTo").children.at(-1).id);
  assert.notEqual(S().tabs[ids2[1]].windowId, w2);
});

test("the menu follows the setting", async () => {
  const { w, ids } = windowWith("a", "b");
  S().updateSettings({ tabMenuShown: ["close"] });
  let top;
  await choose(w, ids[1], (shown) => ((top = shown.map((it) => it.title ?? "---")), null));
  assert.deepEqual(top, ["Close", "---", "More"]);
});
