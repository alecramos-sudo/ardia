import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const posted = [];
const removed = [];
globalThis.acTestNativeModules = {
  ArdiaNotifications: {
    notificationPermission: () => Promise.resolve("granted"),
    requestNotificationPermission: () => Promise.resolve(true),
    removeNotifications: (ids) => (removed.push(...ids), Promise.resolve()),
    openNotificationSettings: () => Promise.resolve(),
    addListener: () => ({ remove() {} }),
    postNotification: (options) => (posted.push(options), Promise.resolve({ id: options.id, icon: "none" })),
  },
};
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { closeWebNotification, handleWebNotificationResponse, showWebNotification } = await import("./webNotifications.ts");

const S = () => useBrowser.getState();
const note = (tabId, id, origin, tag = "") => ({ id, title: "Hello", body: "", icon: null, tag, silent: false, requireInteraction: false, origin, tabId, isMainFrame: true });

async function untilPosted(count) {
  for (let i = 0; i < 200 && posted.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(posted.length, count);
}

S().hydrate({});
const tabIn = (url) => {
  const windowId = S().createWindow({ url });
  return model.activeTabId(S(), windowId);
};
const tabA = tabIn("https://a.example/");
const tabB = tabIn("https://b.example/");

test("two tabs whose pages pick the same notification id get separate notifications", async () => {
  const base = posted.length;
  showWebNotification(tabA, note(tabA, "same:1", "https://a.example"));
  showWebNotification(tabB, note(tabB, "same:1", "https://b.example"));
  await untilPosted(base + 2);
  const ids = posted.slice(base).map((p) => p.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(posted.slice(base).map((p) => p.tabId).sort(), [tabA, tabB].sort());
});

test("a tab can close only its own notification, even with another tab's id", () => {
  const before = removed.length;
  closeWebNotification(tabB, "same:1");
  const gone = removed.slice(before);
  assert.equal(gone.length, 1);
  assert.ok(gone[0].includes(tabB) && !gone[0].includes(tabA));
  closeWebNotification(tabB, "same:1");
  assert.equal(removed.length, before + 1);
  closeWebNotification(tabA, "same:1");
  assert.equal(removed.length, before + 2);
  assert.ok(removed.at(-1).includes(tabA));
});

test("a response that names another tab leaves the shown notification in place", async () => {
  const base = posted.length;
  showWebNotification(tabA, note(tabA, "kept:1", "https://a.example"));
  await untilPosted(base + 1);
  const shownId = posted.at(-1).id;
  assert.equal(handleWebNotificationResponse({ id: shownId, action: "close", tabId: tabB, windowId: null, data: { engineId: "kept:1" } }), true);
  const before = removed.length;
  closeWebNotification(tabA, "kept:1");
  assert.deepEqual(removed.slice(before), [shownId]);
});

test("a tagged notification stays one per site, as the web's tag rule says", async () => {
  const base = posted.length;
  showWebNotification(tabA, note(tabA, "t:1", "https://a.example", "chat"));
  await untilPosted(base + 1);
  const tagged = posted.at(-1).id;
  assert.ok(tagged.includes("https://a.example") && tagged.includes("chat"));
  const before = removed.length;
  closeWebNotification(tabB, "t:1");
  assert.equal(removed.length, before);
  closeWebNotification(tabA, "t:1");
  assert.deepEqual(removed.slice(before), [tagged]);
});
