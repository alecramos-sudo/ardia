import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { openInProfileMainWindow } = await import("./actions.ts");
const { finishAnimatedCloses } = await import("../windows/closeAnimated.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };

function twoProfiles() {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  const personalMain = S().createWindow({ url: "https://home.example/", profileId: "default" });
  const small = S().createWindow({ kind: "small", url: "https://little.example/", profileId: "default" });
  return { personalMain, small };
}

const urlsOf = (windowId) => S().windows[windowId].tabIds.map((id) => S().tabs[id].url);
const mainWindowsOf = (profileId) => S().windowOrder.filter((id) => S().windows[id]?.kind !== "small" && S().windows[id]?.profileId === profileId);

test("Open in Main Window › another profile opens the page as that profile's tab in the main window, shows that profile and closes Little Ardia", () => {
  const { personalMain, small } = twoProfiles();
  openInProfileMainWindow(small, "work");
  finishAnimatedCloses();
  assert.equal(S().windows[small], undefined);
  const opened = S().windows[personalMain].tabIds.map((id) => S().tabs[id]).find((t) => t.url === "https://little.example/");
  assert.ok(opened);
  assert.equal(opened.profileId, "work");
  assert.equal(S().windows[personalMain].profileId, "work");
  assert.equal(S().windows[personalMain].activeTabIds.work, opened.id);
  assert.equal(S().closedTabs.some((c) => c.url === "https://little.example/"), false);
});

test("Open in Main Window › another profile with no main window open makes one in that profile", () => {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  const small = S().createWindow({ kind: "small", url: "https://little.example/", profileId: "default" });
  openInProfileMainWindow(small, "work");
  finishAnimatedCloses();
  assert.equal(S().windows[small], undefined);
  const [main] = mainWindowsOf("work");
  assert.ok(main);
  assert.deepEqual(urlsOf(main), ["https://little.example/"]);
});

test("Open in Main Window › another profile adds a tab to that profile's open window", () => {
  const { small } = twoProfiles();
  const workMain = S().createWindow({ url: "https://work.example/", profileId: "work" });
  openInProfileMainWindow(small, "work");
  finishAnimatedCloses();
  assert.equal(S().windows[small], undefined);
  assert.deepEqual(urlsOf(workMain), ["https://work.example/", "https://little.example/"]);
  assert.deepEqual(mainWindowsOf("work"), [workMain]);
});

test("Open in Main Window › the same profile moves the tab, as Open in Ardia does", () => {
  const { personalMain, small } = twoProfiles();
  const moved = S().windows[small].tabIds[0];
  openInProfileMainWindow(small, "default");
  assert.equal(S().windows[small], undefined);
  assert.equal(S().tabs[moved].windowId, personalMain);
  assert.deepEqual(urlsOf(personalMain), ["https://home.example/", "https://little.example/"]);
});

test("Open in Main Window ignores an unknown profile and a regular window", () => {
  const { personalMain, small } = twoProfiles();
  openInProfileMainWindow(small, "missing");
  openInProfileMainWindow(personalMain, "work");
  finishAnimatedCloses();
  assert.ok(S().windows[small]);
  assert.deepEqual(mainWindowsOf("work"), []);
});
