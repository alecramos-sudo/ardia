import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const guarded = await import("./guardedSettings.ts");
const { updateSettings } = await import("./actions.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");

firstWindowCommitted();

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const keychain = stub.shellNativeModules.ArdiaKeychain;
const asked = [];
stub.shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.title);
  return Promise.resolve({ confirmed: false, suppressed: false });
};
let releaseRead;
keychain.get = () => new Promise((resolve) => (releaseRead = resolve));
const writes = [];
keychain.set = (account, secret) => {
  writes.push(JSON.parse(secret));
  return Promise.resolve(true);
};

test("a launch-time turn-on whose keychain answer arrives after a newer choice in Ardia drops that answer", async () => {
  S().hydrate({});
  guarded.turnOnGuardedSetting("cliControl");
  updateSettings({ cliControl: true });
  updateSettings({ cliControl: false });
  assert.equal(S().settings.cliControl, false);
  releaseRead(JSON.stringify({ cliControl: true, allowJavaScriptFromAppleEvents: false }));
  await settle();
  assert.equal(S().settings.cliControl, false, "the old grant read doesn't override turning it off");
  assert.deepEqual(asked, []);
  assert.equal(writes.at(-1).cliControl, false);
});
