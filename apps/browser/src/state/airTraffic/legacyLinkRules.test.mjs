import assert from "node:assert/strict";
import { test } from "node:test";

const setTimeoutHoldingExit = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { linkMatches, appMatches, parseAirTraffic, airTrafficJson, NO_AIR_TRAFFIC, AIR_TRAFFIC_DOC } = await import("./rules.ts");
const { withLegacyLinkRules, isLegacyLinkRuleList } = await import("./legacyLinkRules.ts");
const store = await import("./store.ts");
const { flushPersistence, startPersistence } = await import("../session/persist.ts");

const S = () => useBrowser.getState();
const SLACK_APP = { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };
const ON = { littleArdiaOn: true, recentApps: [] };
const OFF = { littleArdiaOn: false, recentApps: [] };

let next = 0;
const legacy = (over = {}) => ({ id: `link-${++next}`, site: "github.com", app: null, profileId: "work", open: "tab", ...over });
const carried = (list, context = ON, config = NO_AIR_TRAFFIC) => withLegacyLinkRules(config, list, context).config.rules;
const one = (over, context) => {
  const [rule] = carried([legacy(over)], context);
  return rule;
};

test("each legacy open mode becomes the same Air Traffic open; the usual way follows Little Ardia at the move", () => {
  assert.equal(one({ open: "tab" }).open, "tab");
  assert.equal(one({ open: "window" }).open, "window");
  assert.equal(one({ open: "littleArdia" }).open, "littleArdia");
  assert.equal(one({ open: null }, ON).open, "littleArdia");
  assert.equal(one({ open: null }, OFF).open, "tab");
  for (const open of ["tab", "window", "littleArdia"]) assert.equal(one({ open }, OFF).open, open);
});

test("each legacy site form becomes a condition that matches what it matched", () => {
  const cases = [
    ["github.com", { kind: "site", host: "github.com" }, ["https://github.com/a", "http://www.github.com/"], ["https://notgithub.com/"]],
    ["GitHub.com", { kind: "site", host: "github.com" }, ["https://github.com/"], []],
    ["github.com/*", { kind: "site", host: "github.com" }, ["https://github.com/x?y=1"], []],
    ["*.example.com", { kind: "site", host: "example.com" }, ["https://example.com/", "https://docs.example.com/a"], ["https://example.org/"]],
    ["www.example.com", { kind: "site", host: "www.example.com" }, ["https://www.example.com/a"], ["https://example.com/a"]],
    ["github.com/team/*", { kind: "pattern", pattern: "*://*.github.com/team/*" }, ["https://github.com/team/x", "https://www.github.com/team/"], ["https://github.com/other"]],
    ["Example.com/Docs", { kind: "pattern", pattern: "*://*.example.com/Docs" }, ["https://example.com/Docs"], ["https://example.com/Docs/more"]],
    ["www.example.com/docs/*", { kind: "pattern", pattern: "*://www.example.com/docs/*" }, ["https://www.example.com/docs/a"], ["https://example.com/docs/a"]],
    ["*.example.com/docs/*", { kind: "pattern", pattern: "*://*.example.com/docs/*" }, ["https://a.example.com/docs/x"], ["https://a.example.com/blog"]],
    ["https://example.com/team/*", { kind: "pattern", pattern: "https://example.com/team/*" }, ["https://example.com/team/a"], ["http://example.com/team/a"]],
    ["  https://*.corp.example/*  ", { kind: "pattern", pattern: "https://*.corp.example/*" }, ["https://wiki.corp.example/"], []],
  ];
  for (const [site, when, matches, misses] of cases) {
    const rule = one({ site });
    assert.deepEqual(rule.when, when, site);
    for (const url of matches) assert.ok(linkMatches(rule.when, url), `${site} matches ${url}`);
    for (const url of misses) assert.ok(!linkMatches(rule.when, url), `${site} misses ${url}`);
  }
});

test("the source app, profile and id carry over; a bundle ID takes its name from the apps links came from", () => {
  const recentApps = [SLACK_APP];
  const [slack, mail, bundle, any, blank] = carried(
    [legacy({ app: "com.tinyspeck.slackmacgap" }), legacy({ app: " Mail " }), legacy({ app: "com.apple.Notes" }), legacy({ app: null }), legacy({ site: "blank.com", app: "  " })],
    { littleArdiaOn: true, recentApps },
  );
  assert.deepEqual(slack.from, SLACK_APP);
  assert.deepEqual(mail.from, { bundleId: null, name: "Mail" });
  assert.deepEqual(bundle.from, { bundleId: "com.apple.Notes", name: "com.apple.Notes" });
  assert.equal(any.from, null);
  assert.equal(blank.from, null);
  assert.ok(appMatches(mail.from, { bundleId: "com.apple.mail", appName: "Mail" }));
  assert.ok(appMatches(bundle.from, { bundleId: "com.apple.notes", appName: "Notes" }));
  assert.ok(!appMatches(mail.from, { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" }));
  assert.equal(slack.profileId, "work");
  assert.equal(slack.enabled, true);
  assert.match(slack.id, /^link-/);
});

test("the rules keep their order and land after the Air Traffic rules already there", () => {
  const existing = { id: "r1", enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "window" };
  const list = [legacy({ site: "a.com" }), legacy({ site: "b.com", open: "window" }), legacy({ site: "c.com/x" })];
  const rules = carried(list, ON, { rules: [existing], fallback: null });
  assert.deepEqual(rules.map((r) => r.id), ["r1", ...list.map((r) => r.id)]);
  assert.deepEqual(rules.slice(1).map((r) => r.when.host ?? r.when.pattern), ["a.com", "b.com", "*://*.c.com/x"]);
});

test("rules that duplicate an Air Traffic rule, or each other, are skipped; a taken id gets a new one", () => {
  const existing = { id: "link-dupe", enabled: false, from: SLACK_APP, when: { kind: "site", host: "github.com" }, profileId: "work", open: "littleArdia" };
  const list = [
    legacy({ id: "link-dupe", site: "*.github.com", app: "com.tinyspeck.slackmacgap", open: null }),
    legacy({ id: "link-dupe", site: "github.com", app: "com.tinyspeck.slackmacgap", open: "tab" }),
    legacy({ site: "github.com", open: "tab" }),
    legacy({ site: "GITHUB.com/*", open: "tab" }),
  ];
  const rules = carried(list, ON, { rules: [existing], fallback: null });
  assert.equal(rules.length, 3);
  assert.equal(rules[1].id, "link-dupe-2");
  assert.deepEqual(rules[1].from, { bundleId: "com.tinyspeck.slackmacgap", name: "com.tinyspeck.slackmacgap" });
  assert.equal(rules[2].from, null);
});

test("running the move twice adds nothing", () => {
  const list = [legacy({ site: "a.com" }), legacy({ site: "b.com/x", app: "Mail", open: null })];
  const once = withLegacyLinkRules(NO_AIR_TRAFFIC, list, ON).config;
  assert.equal(once.rules.length, 2);
  assert.deepEqual(withLegacyLinkRules(once, list, ON), { config: once, left: [] });
});

test("an invalid legacy value is ignored, and a rule whose site never matched is left out", () => {
  const config = { rules: [{ id: "r1", enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab" }], fallback: null };
  const tooMany = Array.from({ length: 201 }, (_, i) => legacy({ site: `s${i}.com` }));
  for (const bad of [undefined, null, "github.com", {}, [legacy({ open: "popup" })], [legacy({ profileId: 3 })], [{ ...legacy(), app: undefined }], [legacy(), "x"], tooMany]) {
    assert.deepEqual(withLegacyLinkRules(config, bad, ON), { config, left: [] }, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(isLegacyLinkRuleList(tooMany.slice(0, 200)), true);
  const rules = carried([legacy({ site: "" }), legacy({ site: "git hub.com" }), legacy({ site: "*" }), legacy({ site: "ftp:/x" }), legacy({ profileId: "" }), legacy({ site: "kept.com" })]);
  assert.deepEqual(rules.map((r) => r.when.host), ["kept.com"]);
});

test("the move stops at the Air Traffic rule limit and hands back the rules that didn't fit", () => {
  const list = Array.from({ length: 150 }, (_, i) => legacy({ site: `s${i}.com` }));
  const { config, left } = withLegacyLinkRules(NO_AIR_TRAFFIC, list, ON);
  assert.equal(config.rules.length, 100);
  assert.deepEqual(left, list.slice(100));
});

const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 0 };

async function relaunch({ change } = {}) {
  store.useAirTraffic.setState({ loaded: false, config: NO_AIR_TRAFFIC, recentApps: [] });
  const stop = startPersistence();
  await new Promise((resolve) => setImmediate(resolve));
  change?.();
  flushPersistence();
  stop();
}

async function launchWith(settings, options) {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify({ version: 11, profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], settings, settingsMeta: { chosen: [], inferred: [] } }));
  await relaunch(options);
}

const savedSettings = () => JSON.parse(stub.docs.get("session.json")).settings;
const savedAirTraffic = () => parseAirTraffic(stub.docs.get(AIR_TRAFFIC_DOC) ?? null);

test("at launch the saved linkRules move into air-traffic.json and leave session.json", async () => {
  const list = [legacy({ site: "github.com", open: null }), legacy({ site: "*.slack.com", app: "Mail", open: "window" })];
  await launchWith({ linkRules: list, openLinksInLittleArdia: false });
  const rules = savedAirTraffic().rules;
  assert.deepEqual(
    rules.map(({ when, from, profileId, open }) => ({ when, from, profileId, open })),
    [
      { when: { kind: "site", host: "github.com" }, from: null, profileId: "work", open: "tab" },
      { when: { kind: "site", host: "slack.com" }, from: { bundleId: null, name: "Mail" }, profileId: "work", open: "window" },
    ],
  );
  assert.deepEqual(store.currentAirTraffic().rules, rules);
  assert.equal("linkRules" in savedSettings(), false, "the legacy key is gone once the session saves");
  assert.equal(S().settings.openLinksInLittleArdia, false);

  const airTraffic = stub.docs.get(AIR_TRAFFIC_DOC);
  await relaunch();
  assert.equal(stub.docs.get(AIR_TRAFFIC_DOC), airTraffic, "a second launch moves nothing");
  assert.equal(store.currentAirTraffic().rules.length, 2);
});

test("a session without linkRules, or with a broken value, leaves Air Traffic alone", async () => {
  await launchWith({ openLinksInLittleArdia: true });
  assert.equal(stub.docs.has(AIR_TRAFFIC_DOC), false);
  await launchWith({ linkRules: "github.com" });
  assert.equal(stub.docs.has(AIR_TRAFFIC_DOC), false);
  assert.equal("linkRules" in savedSettings(), false);
});

test("rules past the Air Traffic limit stay in session.json until there's room", async () => {
  const list = Array.from({ length: 150 }, (_, i) => legacy({ site: `room${i}.com` }));
  await launchWith({ linkRules: list });
  assert.equal(savedAirTraffic().rules.length, 100);
  assert.deepEqual(savedSettings().linkRules, list.slice(100));
});

test("a failed air-traffic.json save keeps linkRules in session.json through later saves, and the next launch moves them", async () => {
  const list = [legacy({ site: "kept-a.com" }), legacy({ site: "kept-b.com", open: "window" })];
  for (const failure of ["returnsFalse", "landingFails"]) {
    stub.refusedWrites[failure] = true;
    try {
      await launchWith({ linkRules: list }, { change: () => S().updateSettings({ openLinksInLittleArdia: !S().settings.openLinksInLittleArdia }) });
    } finally {
      stub.refusedWrites[failure] = false;
    }
    assert.deepEqual(savedSettings().linkRules, list, failure);
  }
  await relaunch();
  assert.deepEqual(savedAirTraffic().rules.map((r) => r.when.host), ["kept-a.com", "kept-b.com"]);
  assert.equal("linkRules" in savedSettings(), false);
});

test("a retry after an unconfirmed save imports nothing twice, even when Little Ardia's setting changed in between", async () => {
  const native = stub.shellNativeModules.ArdiaDocuments;
  const { writeDocument, documentSaved } = native;
  let landedLater;
  native.writeDocument = (name, text) => (name === AIR_TRAFFIC_DOC ? void (landedLater = text) : writeDocument(name, text));
  native.documentSaved = (name) => (name === AIR_TRAFFIC_DOC ? Promise.reject(new Error("first landing failed")) : documentSaved(name));
  try {
    await launchWith({ linkRules: [legacy({ id: "old", site: "github.com", open: null })], openLinksInLittleArdia: true }, { change: () => S().updateSettings({ openLinksInLittleArdia: false }) });
  } finally {
    native.writeDocument = writeDocument;
    native.documentSaved = documentSaved;
  }
  assert.deepEqual(savedSettings().linkRules.map((r) => r.open), ["littleArdia"], "the kept rule carries the open mode settled at the first move");
  stub.docs.set(AIR_TRAFFIC_DOC, landedLater);
  await relaunch();
  assert.deepEqual(savedAirTraffic().rules.map(({ id, open }) => ({ id, open })), [{ id: "old", open: "littleArdia" }]);
  assert.equal("linkRules" in savedSettings(), false);
});

test("air-traffic.json keeps a receipt for every rule moved or matched, so a retry skips it whatever happened to it since", () => {
  const first = withLegacyLinkRules(NO_AIR_TRAFFIC, [legacy({ id: "old", site: "github.com", open: "tab" }), legacy({ id: "same", site: "github.com", open: "tab" })], ON);
  assert.equal(first.config.movedLinkRules.length, 2);
  assert.deepEqual(parseAirTraffic(airTrafficJson(first.config)).movedLinkRules, first.config.movedLinkRules, "the receipts survive a save");
  const edited = { ...first.config, rules: [{ ...first.config.rules[0], when: { kind: "site", host: "gitlab.com" }, open: "window" }] };
  assert.deepEqual(withLegacyLinkRules(edited, [legacy({ id: "old", site: "github.com", open: "tab" })], ON), { config: edited, left: [] });
  const deleted = { ...first.config, rules: [] };
  assert.deepEqual(withLegacyLinkRules(deleted, [legacy({ id: "old", site: "github.com", open: "tab" })], ON), { config: deleted, left: [] });
});

async function launchWithUnconfirmedMoves(settings, afterMove) {
  const native = stub.shellNativeModules.ArdiaDocuments;
  const { writeDocument, documentSaved } = native;
  let staged;
  native.writeDocument = (name, text) => (name === AIR_TRAFFIC_DOC ? void (staged = text) : writeDocument(name, text));
  native.documentSaved = (name) => (name === AIR_TRAFFIC_DOC ? Promise.reject(new Error("landing unconfirmed")) : documentSaved(name));
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify({ version: 11, profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], settings, settingsMeta: { chosen: [], inferred: [] } }));
  store.useAirTraffic.setState({ loaded: false, config: NO_AIR_TRAFFIC, recentApps: [] });
  const stop = startPersistence();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    afterMove();
    await new Promise((resolve) => setImmediate(resolve));
    flushPersistence();
  } finally {
    stop();
    native.writeDocument = writeDocument;
    native.documentSaved = documentSaved;
  }
  stub.docs.set(AIR_TRAFFIC_DOC, staged);
}

for (const [what, change, expected] of [
  ["deleting a moved rule sticks", () => store.removeAirTrafficRule("old"), []],
  ["editing a moved rule's site doesn't bring the old one back", () => assert.equal(store.updateAirTrafficRule("old", { when: { kind: "site", host: "gitlab.com" } }), true), [["old", "gitlab.com"]]],
  ["editing a moved rule's open mode doesn't import it again", () => assert.equal(store.updateAirTrafficRule("old", { open: "window" }), true), [["old", "github.com"]]],
]) {
  test(`after unconfirmed saves that the native store lands later, ${what}`, async () => {
    await launchWithUnconfirmedMoves({ linkRules: [legacy({ id: "old", site: "github.com", profileId: "default", open: null })], openLinksInLittleArdia: true }, change);
    assert.deepEqual(savedSettings().linkRules.map((r) => r.id), ["old"], "session.json keeps the list until a move is confirmed");
    await relaunch();
    assert.deepEqual(savedAirTraffic().rules.map((r) => [r.id, r.when.host]), expected);
    assert.equal("linkRules" in savedSettings(), false, "a confirmed launch that moves nothing ends the move");
  });
}

test("a move that settles after persistence stopped changes nothing", async () => {
  const native = stub.shellNativeModules.ArdiaDocuments;
  const { documentSaved } = native;
  let settle;
  native.documentSaved = (name) => (name === AIR_TRAFFIC_DOC ? new Promise((resolve) => (settle = resolve)) : documentSaved(name));
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify({ version: 11, profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"], settings: { linkRules: [legacy({ id: "late", site: "late.example" })] }, settingsMeta: { chosen: [], inferred: [] } }));
  store.useAirTraffic.setState({ loaded: false, config: NO_AIR_TRAFFIC, recentApps: [] });
  try {
    const stop = startPersistence();
    flushPersistence();
    stop();
    const session = stub.docs.get("session.json");
    settle();
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(stub.docs.get("session.json"), session);
  } finally {
    native.documentSaved = documentSaved;
  }
});

test("rules that share an id keep their own receipts, so one waiting past the limit still moves once there's room", async () => {
  const rule = (id, host) => ({ id, enabled: true, from: null, when: { kind: "site", host }, profileId: "default", open: "tab" });
  const shared = (site) => ({ id: "shared", site, app: null, profileId: "default", open: "tab" });
  stub.docs.clear();
  stub.docs.set(AIR_TRAFFIC_DOC, airTrafficJson({ rules: Array.from({ length: 99 }, (_, i) => rule(`r${i}`, `s${i}.com`)), fallback: null }));
  stub.docs.set("session.json", JSON.stringify({ version: 11, profiles: { default: PERSONAL }, profileOrder: ["default"], settings: { linkRules: [shared("github.com"), shared("gitlab.com")] }, settingsMeta: { chosen: [], inferred: [] } }));
  await relaunch();
  assert.deepEqual(savedSettings().linkRules.map((r) => r.site), ["gitlab.com"]);
  store.removeAirTrafficRule("r0");
  await relaunch();
  const hosts = savedAirTraffic().rules.map((r) => r.when.host);
  assert.equal(hosts.length, 100);
  assert.ok(hosts.includes("github.com") && hosts.includes("gitlab.com"));
  assert.equal("linkRules" in savedSettings(), false);
});
