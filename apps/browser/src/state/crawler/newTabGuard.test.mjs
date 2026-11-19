import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
globalThis.crawlerGuardRefusals = 0;
const stubs = {
  "/state/crawler/actions.ts": { "../telemetry/errors": "export const captureCrawlerNotReady = () => {};" },
  "/state/crawler/newTabGuard.ts": { "../telemetry/crawlerTabsRefused": "export const noteCrawlerTabRefused = () => globalThis.crawlerGuardRefusals++;" },
};
registerHooks({
  resolve(specifier, context, next) {
    const owner = Object.keys(stubs).find((file) => context.parentURL?.endsWith(file));
    const source = owner && stubs[owner][specifier];
    if (!source) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { useToasts } = await import("../app/toasts.ts");
const { crawlerEngineProfile } = await import("./crawler.ts");
const { applyCrawlerState } = await import("./actions.ts");
const { CRAWLER_NOT_READY_TOAST } = await import("./newTabGuard.ts");

const S = () => useBrowser.getState();
const entry = (profileId, ready, reason = null) => ({ profileId, name: "Crawler", source: "profile", ready, reason, detail: null, readySince: null, navigationHeader: true, shopify: [], blocked: {} });

function crawlerWindow(ready, reason = null) {
  S().hydrate({});
  const crawlerId = S().createProfile({ name: "Crawler" });
  applyCrawlerState({ instanceMode: false, rulesVersion: "1", profiles: [entry(crawlerEngineProfile(S(), crawlerId), ready, reason)] });
  const w = S().createWindow({ profileId: crawlerId });
  useToasts.setState({ toasts: {} });
  globalThis.crawlerGuardRefusals = 0;
  return { crawlerId, w };
}

const tabsIn = (w) => S().windows[w].tabIds.length;

test("a new tab in a crawler profile that isn't ready is refused, with the reason in a toast", () => {
  const { w } = crawlerWindow(false, "selftest_failed");
  const before = tabsIn(w);
  assert.equal(S().newTab(w, { url: "https://shop.example/" }), "");
  assert.equal(S().newTab(w), "");
  assert.equal(tabsIn(w), before);
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast.title, "Crawler profile isn't ready");
  assert.match(toast.message, /self-test/);
  assert.equal(toast.key, CRAWLER_NOT_READY_TOAST);
  assert.equal(globalThis.crawlerGuardRefusals, 2);
});

test("while it is still getting ready the toast says so", () => {
  const { w } = crawlerWindow(false);
  assert.equal(S().newTab(w), "");
  assert.match(useToasts.getState().toasts[w].message, /Getting ready/);
});

test("once the crawler profile is ready, new tabs open as usual and nothing is shown", () => {
  const { w } = crawlerWindow(true);
  const id = S().newTab(w, { url: "https://shop.example/" });
  assert.ok(id && S().tabs[id]);
  assert.equal(activeTabId(S(), w), id);
  assert.equal(useToasts.getState().toasts[w], undefined);
  assert.equal(globalThis.crawlerGuardRefusals, 0);
});

test("the guard looks at the profile the tab opens in, not the window's", () => {
  const { crawlerId, w } = crawlerWindow(false, "timeout");
  const other = S().createWindow({ profileId: "default" });
  assert.ok(S().newTab(other, { url: "https://example.com/" }));
  assert.equal(S().newTab(other, { url: "https://example.com/", profileId: crawlerId }), "");
  assert.equal(useToasts.getState().toasts[other].title, "Crawler profile isn't ready");
  assert.ok(S().newTab(w, { profileId: "default" }));
});

test("a page the engine already opened (a popup) is still adopted", () => {
  const { w } = crawlerWindow(false, "timeout");
  const id = S().newTab(w, { url: "https://shop.example/popup", adoptId: "adopt-1" });
  assert.ok(id && S().tabs[id]);
  assert.equal(globalThis.crawlerGuardRefusals, 0);
});

test("a ready crawler profile has no private windows: a tab in one is refused", () => {
  const { crawlerId } = crawlerWindow(true);
  const priv = S().createWindow({ kind: "private", profileId: crawlerId });
  assert.equal(S().newTab(priv, { url: "https://shop.example/" }), "");
  assert.equal(useToasts.getState().toasts[priv].title, "No private windows in a crawler profile");
});

test("NetLog pages are refused in every profile whenever a crawler profile exists, under any spelling", async () => {
  const { isNetLogPage } = await import("./newTabGuard.ts");
  for (const url of ["chrome://net-export/", "CHROME://NET-EXPORT", "chrome-untrusted://net-export/", "view-source:VIEW-SOURCE:chrome://net-internals/?x#events", "ardia://net%2Dexport/", "about:net-export", "chrome://net-export./x"])
    assert.ok(isNetLogPage(url), url);
  for (const url of ["chrome://settings/", "https://net-export.example/", "chrome://net-exporter/"]) assert.ok(!isNetLogPage(url), url);
  applyCrawlerState({ instanceMode: false, rulesVersion: "1", profiles: [] });
  const other = S().createWindow({ profileId: "default" });
  assert.ok(S().newTab(other, { url: "chrome://net-export/" }));
  const { w } = crawlerWindow(true);
  assert.equal(S().newTab(other, { url: "chrome://net-export/" }), "");
  assert.equal(S().newTab(w, { url: "chrome://net-export/" }), "");
  assert.equal(S().newTab(w, { url: "chrome://net-internals/#events" }), "");
  assert.equal(useToasts.getState().toasts[w].title, "NetLog pages are off");
  const id = S().newTab(w, { url: "https://shop.example/" });
  assert.ok(id);
  S().navigate(id, "chrome://net-export/");
  assert.notEqual(S().tabs[id].url, "chrome://net-export/");
});
