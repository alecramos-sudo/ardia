import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const guarded = await import("./guardedSettings.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");

firstWindowCommitted();

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const asked = [];
stub.shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.title);
  return Promise.resolve({ confirmed: false, suppressed: false });
};
await stub.shellNativeModules.ArdiaKeychain.set(guarded.SETTING_GRANTS_ACCOUNT, JSON.stringify({ cliControl: true, allowJavaScriptFromAppleEvents: "yes" }));

test("a setting turned on in Ardia comes back on at launch without a question; one the keychain doesn't grant is asked about", async () => {
  S().hydrate({ settings: { cliControl: true, allowJavaScriptFromAppleEvents: true }, settingsMeta: { chosen: ["cliControl"], inferred: [] } });
  guarded.startGuardedSettings();
  assert.equal(S().settings.cliControl, false, "held off until the keychain answers");
  await settle();
  assert.equal(S().settings.cliControl, true);
  assert.deepEqual(S().settingsMeta, { chosen: ["cliControl", "allowJavaScriptFromAppleEvents"], inferred: [] }, "restoring control isn't a new choice; Keep Off is");
  assert.deepEqual(asked, ["Allow JavaScript from Apple Events?"], "only a grant of exactly true counts");
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, false);
});
