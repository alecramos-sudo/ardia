import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("./webviewHandles.ts");
const { openInIncognito, openLittleArdiaInIncognito, canOpenInIncognito } = await import("./openInIncognito.ts");
const { tabMenuItems, openTabMenu } = await import("../sidebar/tabMenu.ts");
const { littleArdiaProfileMenu, openLittleArdiaProfileMenu } = await import("../littleArdia/actions.ts");
const { finishAnimatedCloses } = await import("../windows/closeAnimated.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();
const SHOP = "https://shop.example.com/collections/gifts";
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

function mainWindowAt(url) {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  const w = S().createWindow({ url, profileId: "default" });
  return { w, tabId: S().windows[w].tabIds[0] };
}

const privateWindows = () => S().windowOrder.filter((id) => S().windows[id]?.kind === "private");
const urlsIn = (windowId) => S().windows[windowId].tabIds.map((id) => S().tabs[id].url);

function pageAnswers(tabId, answer) {
  const calls = [];
  webviews.set(tabId, {
    evaluate: (code) => {
      calls.push(code);
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  });
  return calls;
}

async function pick(menus, id, run) {
  const real = menus.showMenu;
  menus.showMenu = (items) => {
    const flat = (list) => list.flatMap((it) => [it, ...flat(it.children ?? [])]);
    return Promise.resolve(flat(items).some((it) => it.id === id) ? id : null);
  };
  try {
    await run();
  } finally {
    menus.showMenu = real;
  }
}

test("Open in Incognito › a URL that names its preview theme opens in a new private window as it is, without asking the page", async () => {
  const url = `${SHOP}?preview_theme_id=190737055972`;
  const { w, tabId } = mainWindowAt(url);
  const calls = pageAnswers(tabId, { id: "1", role: "main" });
  const opened = await openInIncognito(tabId, "tabMenu");
  assert.deepEqual(privateWindows(), [opened]);
  assert.deepEqual(urlsIn(opened), [url]);
  assert.equal(calls.length, 0);
  assert.ok(S().windows[w]);
  assert.equal(S().tabs[tabId].url, url);
  assert.equal(S().windows[opened].profileId.startsWith("incognito:"), true);
});

test("Open in Incognito › a page showing a preview theme after Shopify dropped the param opens with it added back", async () => {
  const { tabId } = mainWindowAt(`${SHOP}?sort_by=price`);
  pageAnswers(tabId, { id: 190737055972, role: "unpublished" });
  const opened = await openInIncognito(tabId, "tabMenu");
  assert.deepEqual(urlsIn(opened), [`${SHOP}?sort_by=price&preview_theme_id=190737055972`]);
});

test("Open in Incognito › the live theme, a page without Shopify, an error or a timeout opens the plain URL", async () => {
  for (const answer of [{ id: "5", role: "main" }, null, () => Promise.reject(new Error("gone")), () => new Promise(() => {})]) {
    const { tabId } = mainWindowAt(SHOP);
    pageAnswers(tabId, answer);
    const opened = await openInIncognito(tabId, "tabMenu", undefined, 20);
    assert.deepEqual(urlsIn(opened), [SHOP]);
  }
  const { tabId } = mainWindowAt(SHOP);
  webviews.delete(tabId);
  assert.deepEqual(urlsIn(await openInIncognito(tabId, "tabMenu")), [SHOP]);
});

test("Open in Incognito › a page that navigated while the theme was read opens its first URL without the theme", async () => {
  const { tabId } = mainWindowAt(SHOP);
  pageAnswers(tabId, () => {
    S().updateTab(tabId, { url: "https://other.example.com/" });
    return Promise.resolve({ id: "9", role: "unpublished" });
  });
  assert.deepEqual(urlsIn(await openInIncognito(tabId, "tabMenu")), [SHOP]);
});

test("Open in Incognito › only web pages outside private windows can open in incognito", async () => {
  const { tabId } = mainWindowAt("ardia://settings");
  assert.equal(canOpenInIncognito(tabId), false);
  assert.equal(await openInIncognito(tabId, "tabMenu"), null);
  const p = S().createWindow({ kind: "private", url: SHOP });
  const privateTab = S().windows[p].tabIds[0];
  assert.equal(canOpenInIncognito(privateTab), false);
  assert.equal(privateWindows().length, 1);
  assert.equal(
    tabMenuItems(S(), p, S().tabs[privateTab]).some((it) => it.id === "incognito"),
    false,
  );
});

test("Open in Incognito › the tab menu's item opens the page in a private window and keeps the tab", async () => {
  const { w, tabId } = mainWindowAt(SHOP);
  pageAnswers(tabId, { id: "77", role: "unpublished" });
  const item = tabMenuItems(S(), w, S().tabs[tabId]).find((it) => it.id === "incognito");
  assert.equal(item?.title, "Open in Incognito");
  assert.equal(item?.enabled, true);
  await pick(shellNativeModules.ArdiaMenus, "incognito", () => openTabMenu(w, S().tabs[tabId]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [opened] = privateWindows();
  assert.deepEqual(urlsIn(opened), [`${SHOP}?preview_theme_id=77`]);
  assert.equal(S().tabs[tabId].windowId, w);
});

test("Open in Incognito › Little Ardia's Open in menu opens the page in a private window and closes Little Ardia", async () => {
  mainWindowAt("https://home.example/");
  const small = S().createWindow({ kind: "small", url: SHOP, profileId: "default" });
  const tabId = S().windows[small].tabIds[0];
  pageAnswers(tabId, { id: "88", role: "unpublished" });
  const item = littleArdiaProfileMenu(S(), small).find((it) => it.id === "openInIncognito");
  assert.equal(item?.title, "Open in Incognito");
  assert.equal(item?.enabled, true);
  await pick(shellNativeModules.ArdiaMenus, "openInIncognito", () => openLittleArdiaProfileMenu(small));
  finishAnimatedCloses();
  assert.equal(S().windows[small], undefined);
  const [opened] = privateWindows();
  assert.deepEqual(urlsIn(opened), [`${SHOP}?preview_theme_id=88`]);
  assert.equal(S().closedTabs.some((c) => c.tabId === tabId), false);
});

test("Open in Incognito › Little Ardia on a page that can't open in incognito stays open", async () => {
  mainWindowAt("https://home.example/");
  const small = S().createWindow({ kind: "small", profileId: "default" });
  assert.equal(littleArdiaProfileMenu(S(), small).find((it) => it.id === "openInIncognito")?.enabled, false);
  await openLittleArdiaInIncognito(small);
  finishAnimatedCloses();
  assert.ok(S().windows[small]);
  assert.equal(privateWindows().length, 0);
});
