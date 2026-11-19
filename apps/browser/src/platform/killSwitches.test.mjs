import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { docs, launch, appInfo } = await import("../test-native/index.ts");
const ks = await import("./killSwitches.ts");
const { reloadLaunchConfigForTests } = await import("./launchConfig.ts");

const names = Object.keys(ks.SWITCHES);
const reset = () => {
  docs.clear();
  launch.switches = {};
  reloadLaunchConfigForTests();
  ks.reloadSwitches();
  ks.resetRefreshForTests();
};
const OFFICIAL_SWITCHES_URL = appInfo.switchesURL;
const withSwitchesURL = async (url, run) => {
  if (url === undefined) delete appInfo.switchesURL;
  else appInfo.switchesURL = url;
  try {
    reset();
    await run();
  } finally {
    appInfo.switchesURL = OFFICIAL_SWITCHES_URL;
    reset();
  }
};
const answer = (body, { ok = true } = {}) => async () => ({ ok, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const file = (switches) => ({ version: 1, switches });

test("at most 8 live switches, each on by default with an owner and a removal date still ahead", () => {
  assert.ok(names.length <= ks.MAX_SWITCHES, `${names.length} switches: delete one before adding another (cap ${ks.MAX_SWITCHES})`);
  const today = new Date().toISOString().slice(0, 10);
  for (const name of names) {
    const def = ks.SWITCHES[name];
    assert.match(def.removeBy, /^\d{4}-\d{2}-\d{2}$/, name);
    assert.ok(def.removeBy >= today, `${name} is past its removal date (${def.removeBy}): delete it and its old path, or move the date with a reason`);
    assert.ok(def.owner.trim() && def.about.trim(), name);
    assert.equal(typeof def.live, "boolean", name);
  }
  reset();
  for (const name of names) assert.equal(ks.switchOn(name), true, `${name} defaults on`);
});

test("the site's switches.json is a version 1 file naming only switches the app knows, as booleans", () => {
  const site = JSON.parse(readFileSync(new URL("../../../site/public/switches.json", import.meta.url), "utf8"));
  assert.equal(site.version, 1);
  for (const [name, value] of Object.entries(site.switches)) {
    assert.ok(names.includes(name), `switches.json names ${name}, which the app doesn't have: remove it`);
    assert.equal(typeof value, "boolean", name);
  }
  assert.ok(JSON.stringify(site).length < 4096);
});

test("a cached value is read synchronously; unknown names and non-booleans are ignored", () => {
  reset();
  docs.set("switches-cache.json", JSON.stringify(file({ sidebarSlide: false, newTabPrewarm: "no", gone: false, lazySidebarRows: 0 })));
  assert.equal(ks.switchOn("sidebarSlide"), false);
  assert.equal(ks.switchOn("newTabPrewarm"), true);
  assert.equal(ks.switchOn("lazySidebarRows"), true);
  reset();
  docs.set("switches-cache.json", "not json");
  assert.equal(ks.switchOn("sidebarSlide"), true);
});

test("an ARDIA_SWITCHES value from the launch config wins over the cache", () => {
  reset();
  docs.set("switches-cache.json", JSON.stringify(file({ sidebarSlide: false, lazySidebarRows: false })));
  launch.switches = { sidebarSlide: true, lazySidebarRows: false, newTabPrewarm: false };
  reloadLaunchConfigForTests();
  assert.equal(ks.switchOn("sidebarSlide"), true);
  assert.equal(ks.switchOn("lazySidebarRows"), false);
  assert.equal(ks.switchOn("newTabPrewarm"), false);
  reset();
});

test("experiments are off unless ARDIA_SWITCHES turns them on, and don't count against the live cap", () => {
  reset();
  const today = new Date().toISOString().slice(0, 10);
  for (const [name, def] of Object.entries(ks.EXPERIMENTS)) {
    assert.ok(!names.includes(name), `${name} is both a kill switch and an experiment`);
    assert.ok(def.owner.trim() && def.about.trim(), name);
    assert.ok(def.removeBy >= today, `${name} is past its removal date (${def.removeBy})`);
    assert.equal(ks.experimentOn(name), false, `${name} defaults off`);
  }
  launch.switches = { webkitSignIn: true };
  reloadLaunchConfigForTests();
  assert.equal(ks.experimentOn("webkitSignIn"), true);
  reset();
});

test("a fetch asks for the plain URL (no cookies, no query), saves the answer, and applies it now only to a live switch", async () => {
  reset();
  let asked;
  const fetchFn = async (url, init) => {
    asked = { url, init };
    return answer(file({ sidebarSlide: false, lazySidebarRows: false }))();
  };
  assert.equal(await ks.refreshSwitches(fetchFn), "updated");
  assert.equal(asked.url, "https://ardia.dev/switches.json");
  assert.equal(asked.init.credentials, "omit");
  assert.equal(asked.init.headers, undefined);
  assert.ok(!asked.url.includes("?"));
  assert.equal(ks.switchOn("sidebarSlide"), false);
  assert.equal(ks.switchOn("lazySidebarRows"), true);
  ks.reloadSwitches();
  assert.equal(ks.switchOn("sidebarSlide"), false);
  assert.equal(ks.switchOn("lazySidebarRows"), false);
});

test("at most one fetch a launch", async () => {
  reset();
  let n = 0;
  const fetchFn = async () => (n++, answer(file({}))());
  assert.equal(await ks.refreshSwitches(fetchFn), "updated");
  assert.equal(await ks.refreshSwitches(fetchFn), "already");
  assert.equal(n, 1);
});

test("a switch the file stops naming goes back on (staleness: the cache follows the file, not the first answer)", async () => {
  reset();
  await ks.refreshSwitches(answer(file({ sidebarSlide: false })));
  assert.equal(ks.switchOn("sidebarSlide"), false);
  ks.resetRefreshForTests();
  await ks.refreshSwitches(answer(file({})));
  assert.equal(ks.switchOn("sidebarSlide"), true);
  ks.reloadSwitches();
  assert.equal(ks.switchOn("sidebarSlide"), true);
});

test("offline, an error, an odd answer or a slow one keeps the cached value (or the default)", async () => {
  for (const [label, fetchFn] of [
    ["offline", async () => Promise.reject(new TypeError("Network request failed"))],
    ["404", answer("", { ok: false })],
    ["html", answer("<html>")],
    ["wrong version", answer({ version: 2, switches: { sidebarSlide: true } })],
    ["no switches", answer({ version: 1 })],
    ["huge", answer(file({ sidebarSlide: true, pad: "x".repeat(5000) }))],
  ]) {
    reset();
    docs.set("switches-cache.json", JSON.stringify(file({ sidebarSlide: false })));
    const before = docs.get("switches-cache.json");
    assert.equal(await ks.refreshSwitches(fetchFn), "failed", label);
    assert.equal(ks.switchOn("sidebarSlide"), false, label);
    assert.equal(docs.get("switches-cache.json"), before, label);
  }
  reset();
  assert.equal(await ks.refreshSwitches(answer("<html>")), "failed");
  assert.equal(ks.switchOn("sidebarSlide"), true);
});

test("a slow answer is dropped after the timeout", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const result = ks.refreshSwitches(slow);
  t.mock.timers.tick(5000);
  assert.equal(await result, "failed");
  assert.equal(ks.switchOn("sidebarSlide"), true);
});

test("the official build's switches URL is ardia.dev/switches.json, the URL the official Info.plist carries", () => {
  assert.equal(OFFICIAL_SWITCHES_URL, "https://ardia.dev/switches.json");
  const plist = readFileSync(new URL("../../macos/Ardia-macOS/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>ACSwitchesURL<\/key>\s*<string>https:\/\/ardia\.dev\/switches\.json<\/string>/);
});

test("the fork's packaging removes the switches URL along with the release notes page", () => {
  const packaging = readFileSync(new URL("../../../../scripts/fork/package.mjs", import.meta.url), "utf8");
  assert.ok(packaging.includes('"Delete :ACSwitchesURL"'));
});

for (const [label, url] of [["no switches URL", undefined], ["an empty switches URL", ""], ["a non-https switches URL", "http://ardia.dev/switches.json"]]) {
  test(`with ${label}, nothing is fetched and every switch stays at its default`, () =>
    withSwitchesURL(url, async () => {
      let asked = 0;
      const fetchFn = async () => (asked++, answer(file({ sidebarSlide: false }))());
      assert.equal(await ks.refreshSwitches(fetchFn), "unconfigured");
      assert.equal(await ks.refreshSwitches(fetchFn), "unconfigured");
      assert.equal(asked, 0);
      assert.equal(docs.has("switches-cache.json"), false);
      for (const name of names) assert.equal(ks.switchOn(name), true, `${name} defaults on`);
    }));
}

test("without a switches URL, a switches file an earlier build cached no longer applies, and stays on disk untouched", () =>
  withSwitchesURL(undefined, async () => {
    const earlier = JSON.stringify(file(Object.fromEntries(names.map((name) => [name, false]))));
    docs.set("switches-cache.json", earlier);
    for (const name of names) assert.equal(ks.switchOn(name), true, `${name} ignores the old cache`);
    assert.equal(await ks.refreshSwitches(async () => assert.fail("no fetch without a URL")), "unconfigured");
    for (const name of names) assert.equal(ks.switchOn(name), true, `${name} still ignores the old cache`);
    assert.equal(docs.get("switches-cache.json"), earlier);
  }));

test("without a switches URL, ARDIA_SWITCHES still sets a launch's values", () =>
  withSwitchesURL(undefined, async () => {
    docs.set("switches-cache.json", JSON.stringify(file({ newTabPrewarm: false })));
    launch.switches = { sidebarSlide: false };
    reloadLaunchConfigForTests();
    assert.equal(ks.switchOn("sidebarSlide"), false);
    assert.equal(ks.switchOn("newTabPrewarm"), true);
  }));

test("a switches URL other than ardia.dev's is the one fetched", () =>
  withSwitchesURL("https://switches.example/ardia.json", async () => {
    let askedFor;
    assert.equal(await ks.refreshSwitches(async (url) => ((askedFor = url), answer(file({ sidebarSlide: false }))())), "updated");
    assert.equal(askedFor, "https://switches.example/ardia.json");
    assert.equal(ks.switchOn("sidebarSlide"), false);
  }));

test("every switch and experiment native and engine code read by name is in the registry", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = new URL("../../../../", import.meta.url).pathname;
  const pattern = String.raw`(switchOn|experimentOn|SwitchOn|ExperimentOn)\("[A-Za-z]+"\)`;
  const hits = execFileSync("git", ["grep", "-hoE", pattern, "--", ":(glob)packages/*/ios/**", "engine", "apps/browser/macos"], { cwd: root, encoding: "utf8" });
  const read = hits.trim().split("\n").map((hit) => hit.match(/^(\w+)\("(\w+)"\)$/));
  assert.ok(read.length >= 4, "found the native reads");
  for (const [, kind, name] of read) {
    const registry = /^[sS]witchOn$/.test(kind) ? ks.SWITCHES : ks.EXPERIMENTS;
    assert.ok(Object.hasOwn(registry, name), `${kind}("${name}") reads a name the registry in platform/killSwitches.ts doesn't have`);
  }
});
