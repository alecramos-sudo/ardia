import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { parsePluginRecords } = await import("./savedState.ts");
const { applySettingsPatch, planDisable } = await import("./defaults.ts");
const { pluginMaySet } = await import("./appChecks.ts");
const { GUARDED_SETTINGS } = await import("../settings/guardedSettings.ts");

const S = () => useBrowser.getState();
const FORGED = { value: false, previous: true, order: 1, over: null };
const saved = (applied) => JSON.stringify({ plugins: { benign: { enabled: true, approved: "a".repeat(64), values: {}, applied } }, version: 1 });

test("no guarded setting is one a plugin may set", () => {
  for (const key of GUARDED_SETTINGS) assert.equal(pluginMaySet(key), false, key);
  assert.equal(pluginMaySet("launchActions"), false, "settings that need their own approval stay out too");
  assert.equal(pluginMaySet("showFullUrl"), true);
});

test("plugins.json keeps restore steps only for settings a plugin's defaults may set, with valid values", () => {
  const records = parsePluginRecords(
    saved({
      cliControl: FORGED,
      allowJavaScriptFromAppleEvents: FORGED,
      pageEngine: { value: "chromium", previous: "webkit", order: 1, over: null },
      launchActions: { value: [], previous: ["newTab"], order: 1, over: null },
      tidyTabs: { value: true, previous: "yes", order: 1, over: null },
      showFullUrl: { value: true, previous: false, order: 2, over: null },
    }),
  );
  assert.deepEqual(Object.keys(records.benign.applied), ["showFullUrl"]);
});

test("disabling a plugin with forged restore steps brings no guarded setting back", () => {
  S().hydrate({});
  const records = parsePluginRecords(saved({ cliControl: FORGED, allowJavaScriptFromAppleEvents: FORGED }));
  applySettingsPatch(planDisable(records, "benign"));
  assert.equal(S().settings.cliControl, false);
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, false);
});

test("steps that skip the parser are dropped when planned and when applied", () => {
  S().hydrate({});
  const records = { benign: { enabled: true, approved: "a".repeat(64), values: {}, applied: { cliControl: FORGED, allowJavaScriptFromAppleEvents: FORGED } } };
  assert.deepEqual(planDisable(records, "benign"), {});
  applySettingsPatch({ cliControl: true, allowJavaScriptFromAppleEvents: true, launchActions: ["newTab"], showFullUrl: true });
  assert.equal(S().settings.cliControl, false);
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, false);
  assert.deepEqual(S().settings.launchActions, []);
  assert.equal(S().settings.showFullUrl, true, "a setting a plugin may set still applies");
});

test("a real restore step still puts the earlier value back", () => {
  S().hydrate({});
  S().updateSettings({ showFullUrl: true });
  const records = parsePluginRecords(saved({ showFullUrl: { value: true, previous: false, order: 1, over: null } }));
  applySettingsPatch(planDisable(records, "benign"));
  assert.equal(S().settings.showFullUrl, false);
});
