import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startDecideHooks } = await import("../automation/decideHooks.ts");
const { linkGate } = await import("../littleArdia/linkGate.ts");
const { currentAirTraffic, resetAirTrafficForTests, tryAddAirTrafficRule } = await import("../airTraffic/store.ts");
const { alwaysOpenRule, siteOfUrl, toggleAlwaysOpen } = await import("./linkRouting.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };
const SLACK = { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" };

function fresh() {
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [] }));
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  resetAirTrafficForTests();
  startDecideHooks();
}

const rules = () => currentAirTraffic().rules.map(({ from, when, profileId, open }) => ({ from, when, profileId, open }));
const site = (host, profileId, open) => ({ from: null, when: { kind: "site", host }, profileId, open });

test("the site of a page is its host without www, and pages that aren't websites have none", () => {
  assert.equal(siteOfUrl("https://www.github.com/acme/app"), "github.com");
  assert.equal(siteOfUrl("https://Docs.Example.com/x"), "docs.example.com");
  assert.equal(siteOfUrl("ardia://settings"), null);
  assert.equal(siteOfUrl(undefined), null);
});

test('"Always Open" adds one site rule for a profile, replaces another profile\'s, and turns off again', async () => {
  fresh();
  toggleAlwaysOpen("github.com", "work");
  assert.ok(alwaysOpenRule("github.com", "work"));
  assert.deepEqual(rules(), [site("github.com", "work", "littleArdia")]);
  toggleAlwaysOpen("github.com", "default");
  assert.equal(alwaysOpenRule("github.com", "work"), undefined);
  assert.deepEqual(rules(), [site("github.com", "default", "littleArdia")]);
  const routed = await linkGate()("https://github.com/acme", SLACK);
  assert.equal(routed.route.profileId, "default");
  assert.equal(routed.route.open, "littleArdia");
  toggleAlwaysOpen("github.com", "default");
  assert.deepEqual(rules(), []);
});

test('"Always Open" leaves rules for other sites, rules from one app and turned-off rules alone', () => {
  fresh();
  tryAddAirTrafficRule({ enabled: true, from: { bundleId: SLACK.bundleId, name: "Slack" }, when: { kind: "site", host: "github.com" }, profileId: "default", open: "tab" });
  tryAddAirTrafficRule({ enabled: false, from: null, when: { kind: "site", host: "github.com" }, profileId: "default", open: "window" });
  tryAddAirTrafficRule({ enabled: true, from: null, when: { kind: "site", host: "linear.app" }, profileId: "default", open: "tab" });
  toggleAlwaysOpen("github.com", "work");
  assert.equal(currentAirTraffic().rules.length, 4);
  assert.ok(alwaysOpenRule("github.com", "work"));
});

test('"Always Open" does nothing for a profile that is gone', () => {
  fresh();
  toggleAlwaysOpen("github.com", "nobody");
  assert.deepEqual(rules(), []);
});
