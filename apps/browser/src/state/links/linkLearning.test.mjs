import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startDecideHooks } = await import("../automation/decideHooks.ts");
const { linkGate } = await import("../littleArdia/linkGate.ts");
const { littleArdiaProfileMenu, openExternalUrls, openInMainWindow, openInProfileMainWindow, moveLittleArdiaToProfile } = await import("../littleArdia/actions.ts");
const { finishAnimatedCloses } = await import("../windows/closeAnimated.ts");
const { toggleAlwaysOpen } = await import("./linkRouting.ts");
const { countedSend, forgetLinkHabits, LEARN_AFTER } = await import("./linkHabits.ts");
const { useToasts } = await import("../app/toasts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };
const SLACK = { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" };
const PR = "https://github.com/acme/app/pull/1";

function fresh() {
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [] }));
  stub.docs.delete("link-habits.json");
  forgetLinkHabits();
  useToasts.setState({ toasts: {} });
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  S().updateSettings({ linkRules: [], learnLinkRoutes: true, openLinksInLittleArdia: true });
  startDecideHooks();
  return S().createWindow({ url: "https://home.example/", profileId: "default" });
}

const smallWindows = () => S().windowOrder.filter((id) => S().windows[id]?.kind === "small");

async function linkFromSlack(url = PR) {
  const before = smallWindows().length;
  openExternalUrls([url], undefined, SLACK);
  for (let i = 0; i < 50 && smallWindows().length === before; i++) await new Promise((r) => setTimeout(r, 1));
  const small = smallWindows().at(-1);
  assert.ok(small && smallWindows().length === before + 1, "the link opened a Little Ardia window");
  return small;
}

async function sendTo(profileId, url = PR) {
  const small = await linkFromSlack(url);
  openInProfileMainWindow(small, profileId);
  finishAnimatedCloses();
}

const rules = () => S().settings.linkRules.map(({ site, app, profileId, open }) => ({ site, app, profileId, open }));
const toastIn = (windowId) => useToasts.getState().toasts[windowId];

test("a site's count restarts when the profile changes, and the second send in a row to one profile is learned", () => {
  assert.equal(LEARN_AFTER, 2);
  const once = countedSend({}, "github.com", "work");
  assert.deepEqual(once, { habits: { "github.com": { profileId: "work", times: 1 } }, learned: false });
  const elsewhere = countedSend(once.habits, "github.com", "default");
  assert.deepEqual(elsewhere, { habits: { "github.com": { profileId: "default", times: 1 } }, learned: false });
  assert.deepEqual(countedSend(once.habits, "github.com", "work"), { habits: {}, learned: true });
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`s${i}.example`, { profileId: "work", times: 1 }]));
  const capped = countedSend(many, "new.example", "work").habits;
  assert.equal(Object.keys(capped).length, 200);
  assert.equal("s0.example" in capped, false);
  assert.equal(Object.keys(capped).at(-1), "new.example");
});

test("sending a site's link from Little Ardia to the same profile twice adds a rule, says so with an Undo, and the next link opens there as a tab", async () => {
  const main = fresh();
  await sendTo("work");
  assert.deepEqual(rules(), []);
  assert.equal(toastIn(main), undefined);
  await sendTo("work", "https://github.com/acme/app/issues/2");
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "work", open: "tab" }]);
  const toast = toastIn(main);
  assert.equal(toast.title, "Links to github.com now open in Work");
  assert.equal(toast.action.title, "Undo");
  assert.deepEqual(await linkGate()(PR, SLACK), { url: PR, route: { profileId: "work", open: "tab", windowId: null }, decided: true });
  openExternalUrls(["https://github.com/acme/app/pull/3"], undefined, SLACK);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(smallWindows().length, 0);
  assert.ok(S().windows[main].tabIds.some((id) => S().tabs[id].url === "https://github.com/acme/app/pull/3" && S().tabs[id].profileId === "work"));
  toast.action.run();
  assert.deepEqual(rules(), []);
});

test("Open in Ardia in the window's own profile counts too, and it survives switching the Little Ardia window's profile first", async () => {
  fresh();
  for (const url of [PR, "https://github.com/acme"]) {
    const small = await linkFromSlack(url);
    moveLittleArdiaToProfile(small, "work");
    finishAnimatedCloses();
    openInMainWindow(smallWindows().at(-1));
    finishAnimatedCloses();
  }
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "work", open: "tab" }]);
});

test("a send to another profile in between starts the count again, and other sites are counted apart", async () => {
  fresh();
  await sendTo("work");
  await sendTo("default");
  await sendTo("work");
  await sendTo("work", "https://linear.app/acme/issue/1");
  assert.deepEqual(rules(), []);
  await sendTo("work");
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "work", open: "tab" }]);
});

test("nothing is learned from a Little Ardia window a page opened, or with learning off", async () => {
  fresh();
  for (let i = 0; i < 2; i++) {
    openInProfileMainWindow(S().createWindow({ kind: "small", url: PR, profileId: "default" }), "work");
    finishAnimatedCloses();
  }
  assert.deepEqual(rules(), []);
  S().updateSettings({ learnLinkRoutes: false });
  await sendTo("work");
  await sendTo("work");
  assert.deepEqual(rules(), []);
});

test("a learned rule replaces the site's Always Open rule, and Undo puts that one back", async () => {
  const main = fresh();
  toggleAlwaysOpen("github.com", "default");
  await sendTo("work");
  await sendTo("work");
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "work", open: "tab" }]);
  toastIn(main).action.run();
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "default", open: null }]);
});

test("the count is kept in a document, so it carries over a relaunch", async () => {
  fresh();
  await sendTo("work");
  assert.deepEqual(JSON.parse(stub.docs.get("link-habits.json")), { sites: { "github.com": { profileId: "work", times: 1 } }, version: 1 });
  forgetLinkHabits();
  await sendTo("work");
  assert.deepEqual(rules(), [{ site: "github.com", app: null, profileId: "work", open: "tab" }]);
});

test("the profile button's menu is one level: Open in each profile, the window's own first, then switching and Always Open", async () => {
  fresh();
  const small = await linkFromSlack();
  const lines = littleArdiaProfileMenu(S(), small).map((it) => (it.separator ? "---" : `${it.title}${it.checked ? " ✓" : ""}${it.children ? " ›" : ""}`));
  assert.deepEqual(lines, ["Open in Personal", "Open in Work", "Open in Incognito", "---", "Switch This Window to Work", "---", "Always Open github.com in Personal"]);
  moveLittleArdiaToProfile(small, "work");
  finishAnimatedCloses();
  const moved = littleArdiaProfileMenu(S(), smallWindows().at(-1)).map((it) => it.title ?? "---");
  assert.deepEqual(moved.slice(0, 5), ["Open in Work", "Open in Personal", "Open in Incognito", "---", "Switch This Window to Personal"]);
});
