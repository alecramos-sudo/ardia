import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startDecideHooks } = await import("../automation/decideHooks.ts");
const { linkGate } = await import("../littleArdia/linkGate.ts");
const { addLinkRule, alwaysOpenRule, removeLinkRule, toggleAlwaysOpen } = await import("./linkRouting.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };
const SLACK = { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" };

function fresh() {
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [] }));
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  S().updateSettings({ linkRules: [] });
  startDecideHooks();
}

const gate = (url, source = SLACK) => linkGate()(url, source);

test("a link from another app that matches a rule goes to the rule's profile, and others stay undecided", () => {
  fresh();
  assert.equal(addLinkRule({ site: "github.com", app: "", profileId: "work", open: "window" }), null);
  assert.deepEqual(gate("https://github.com/acme/app"), { url: "https://github.com/acme/app", route: { profileId: "work", open: "window", windowId: null }, decided: true });
  assert.deepEqual(gate("https://example.com/"), { url: "https://example.com/", route: null, decided: true });
});

test("a rule whose profile was deleted is skipped", () => {
  fresh();
  addLinkRule({ site: "github.com", app: "", profileId: "work", open: null });
  const { work: _, ...rest } = S().profiles;
  useBrowser.setState({ profiles: rest, profileOrder: ["default"] });
  assert.equal(S().settings.linkRules.length, 1, "the rule is kept, in case the profile comes back from sync");
  assert.equal(gate("https://github.com/").route, null);
});

test("native holds incoming links while any rule exists, so a link that launches Ardia waits for the rules", () => {
  fresh();
  assert.equal(stub.systemSignals.holdsIncomingLinks, false);
  addLinkRule({ site: "github.com", app: "", profileId: "work", open: null });
  assert.equal(stub.systemSignals.holdsIncomingLinks, true);
  removeLinkRule(S().settings.linkRules[0].id);
  assert.equal(stub.systemSignals.holdsIncomingLinks, false);
});

test("adding a rule needs a site that can match and a profile that exists", () => {
  fresh();
  assert.match(addLinkRule({ site: "", app: "", profileId: "work", open: null }), /add a site/);
  assert.match(addLinkRule({ site: "github.com", app: "", profileId: "nobody", open: null }), /profile/);
  assert.deepEqual(S().settings.linkRules, []);
});

test('"Always open" toggles one plain rule per site and replaces another profile\'s plain rule for it', () => {
  fresh();
  toggleAlwaysOpen("github.com", "work");
  assert.ok(alwaysOpenRule("github.com", "work"));
  toggleAlwaysOpen("github.com", "default");
  assert.equal(alwaysOpenRule("github.com", "work"), undefined);
  assert.equal(S().settings.linkRules.length, 1);
  assert.equal(gate("https://github.com/").route.profileId, "default");
  toggleAlwaysOpen("github.com", "default");
  assert.deepEqual(S().settings.linkRules, []);
});
