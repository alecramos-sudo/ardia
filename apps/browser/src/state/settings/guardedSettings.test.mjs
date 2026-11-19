import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const guarded = await import("./guardedSettings.ts");
const { updateSettings } = await import("./actions.ts");
const { runCommand } = await import("../commands/commands.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");

firstWindowCommitted();

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const keychain = stub.shellNativeModules.ArdiaKeychain;
const asked = [];
let answer = false;
stub.shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.title);
  return Promise.resolve({ confirmed: answer, suppressed: false });
};
const savedGrants = async () => JSON.parse((await keychain.get(guarded.SETTING_GRANTS_ACCOUNT)) ?? "{}");
const CONTROL = "Let programs control Ardia?";
const APPLE_EVENTS = "Allow JavaScript from Apple Events?";

test("a session.json edit can't turn control or JavaScript from Apple Events on: both are held off, and stay off when the person says no", async () => {
  S().hydrate({ settings: { cliControl: true, allowJavaScriptFromAppleEvents: true }, settingsMeta: { chosen: ["cliControl"], inferred: [] } });
  guarded.startGuardedSettings();
  assert.equal(S().settings.cliControl, false, "held off before control, user scripts or AppleScript can act on it");
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, false);
  assert.deepEqual(S().settingsMeta.chosen, ["cliControl"], "holding it off isn't a choice");
  await settle();
  assert.deepEqual([...asked].sort(), [APPLE_EVENTS, CONTROL]);
  assert.equal(S().settings.cliControl, false);
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, false);
  assert.deepEqual(await savedGrants(), {});
});

test("a launch-time turn-on after a no in the same launch doesn't ask again", async () => {
  asked.length = 0;
  guarded.turnOnGuardedSetting("cliControl");
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(S().settings.cliControl, false);
});

test("turning control on in Ardia is remembered in the keychain, so a later launch-time turn-on needs no question", async () => {
  updateSettings({ cliControl: true });
  assert.equal(S().settings.cliControl, true);
  await settle();
  assert.deepEqual(await savedGrants(), { cliControl: true, allowJavaScriptFromAppleEvents: false });
  S().updateSettings({ cliControl: false });
  guarded.turnOnGuardedSetting("cliControl");
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(S().settings.cliControl, true);
});

test("turning it off in Ardia takes the grant back, and the next turn-on asks; yes turns it on and is remembered", async () => {
  updateSettings({ cliControl: false });
  await settle();
  assert.equal((await savedGrants()).cliControl, false);
  answer = true;
  guarded.turnOnGuardedSetting("cliControl");
  await settle();
  assert.deepEqual(asked, [CONTROL]);
  assert.equal(S().settings.cliControl, true);
  assert.equal((await savedGrants()).cliControl, true);
  answer = false;
});

test("the View menu's Allow JavaScript from Apple Events counts as turning it on in Ardia", async () => {
  asked.length = 0;
  runCommand({ command: "toggleJavaScriptFromAppleEvents", arg: null, windowId: null });
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, true);
  await settle();
  assert.equal((await savedGrants()).allowJavaScriptFromAppleEvents, true);
  S().updateSettings({ allowJavaScriptFromAppleEvents: false });
  guarded.turnOnGuardedSetting("allowJavaScriptFromAppleEvents");
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(S().settings.allowJavaScriptFromAppleEvents, true);
});
