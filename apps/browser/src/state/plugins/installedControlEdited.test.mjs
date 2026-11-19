import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");

firstWindowCommitted();

const S = () => useBrowser.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const asked = [];
stub.shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.title);
  return Promise.resolve({ confirmed: false, suppressed: false });
};

const CLI = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }] });

setConsentPeriod(true, "test-epoch");
S().hydrate({});
stub.shellNativeModules.ArdiaDocuments.writeDocument("plugins.json", JSON.stringify({ plugins: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {}, installed: true, controlGranted: true } }, version: 1 }));
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "cli", text: CLI, status: "ok", folderId: "bundled", bundled: true }];
startPlugins();
await settle();

test("a plugins.json edit that marks Command Line installed can't turn control on: the launch asks, and no keeps it off", () => {
  assert.deepEqual(asked, ["Let programs control Ardia?"]);
  assert.equal(S().settings.cliControl, false);
  host.linkResult = null;
});
