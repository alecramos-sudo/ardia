import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest, needsReview, reviewReason } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { manifestHash } = await import("./appChecks.ts");
const { consentLines } = await import("./consent.ts");
const { parsePluginRecords, pluginRecordsJson } = await import("./savedState.ts");
const { pluginSocketMethod } = await import("./socketMethods.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const docs = stub.shellNativeModules.ArdiaDocuments;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const program = (name) => JSON.stringify({ manifest: 1, name, title: name, version: "1.0.0", programs: [{ name: `${name}-x`, path: "bin/x" }] });
const TOOL = program("tool");
const KEPT = program("kept");
const OLDER = program("older");
const APPROVED = "a".repeat(64);
const EDITED = "b".repeat(64);
const entry = (name, text, folderId, extra = {}) => ({ name, status: "ok", text, folderId, ...extra });
const kept = entry("kept", KEPT, "2:20", { files: APPROVED });
const older = entry("older", OLDER, "3:30", { files: APPROVED });
const tool = (files) => entry("tool", TOOL, "1:10", files ? { files } : {});
const pins = () => host.links.map((l) => [l.name, l.files]);

async function scan(folders) {
  host.folders = folders;
  await lifecycle.rescanPlugins(consentToken());
  await settle();
}

setConsentPeriod(true, "test-epoch");
S().hydrate({});
docs.writeDocument(
  "plugins.json",
  JSON.stringify({
    plugins: {
      kept: { enabled: true, approved: manifestHash(KEPT, "2:20"), files: APPROVED, values: {}, applied: {} },
      older: { enabled: true, approved: manifestHash(OLDER, "3:30"), values: {}, applied: {} },
    },
    version: 1,
  }),
);
host.folders = [kept, older, tool(APPROVED)];
startPlugins();
await settle();
const launch = { consent: P().consent, links: pins(), sweeps: host.sweeps.map((s) => [...s]) };

test("an unchanged plugin relaunches without a prompt and links with the files it was approved with", () => {
  assert.equal(launch.consent, null);
  assert.ok(activeManifest(P(), "kept"));
  assert.equal(needsReview(P(), "kept"), false);
  assert.deepEqual(launch.links, [["kept", APPROVED]]);
  assert.deepEqual(launch.sweeps, [["kept"]]);
  assert.equal(P().programs.kept.state, "linked");
});

test("a plugin approved before its files were pinned asks once before its commands go back on PATH", () => {
  assert.equal(activeManifest(P(), "older"), null);
  assert.equal(reviewReason(P(), "older"), "files");
  assert.ok(!launch.links.some(([name]) => name === "older"));
});

test("turning one on approves its files as the scan read them, saves them and pins them on the link", async () => {
  host.links.length = 0;
  assert.ok(lifecycle.requestPluginConsent("tool"));
  assert.equal(P().consent.files, APPROVED);
  assert.ok(lifecycle.enablePlugin("tool", P().consent.hash));
  await settle();
  assert.equal(P().records.tool.files, APPROVED);
  assert.equal(parsePluginRecords(docs.readDocument("plugins.json")).tool.files, APPROVED);
  assert.deepEqual(pins(), [["tool", APPROVED]]);
  assert.deepEqual(P().programs.tool, { state: "linked", hash: P().listings.tool.hash, files: APPROVED, linked: ["tool-x"], refused: {}, binDir: "/home/.local/bin" });
});

test("an edited program file stops the plugin and takes its commands off PATH until it is approved again", async () => {
  host.links.length = 0;
  host.unlinks.length = 0;
  await scan([kept, older, tool(EDITED)]);
  assert.equal(activeManifest(P(), "tool"), null);
  assert.equal(reviewReason(P(), "tool"), "files");
  assert.equal(P().consent, null, "nothing asks by itself");
  assert.deepEqual(host.unlinks, [{ name: "tool", programs: ["tool-x"], remove: false }]);
  assert.deepEqual(pins(), []);
  assert.equal(P().records.tool.enabled, true, "it is still meant to be on");
  assert.equal(pluginSocketMethod("plugins", {}).result.find((p) => p.name === "tool").needsReview, true);

  assert.ok(lifecycle.requestPluginConsent("tool"));
  assert.equal(P().consent.files, EDITED);
  assert.ok(lifecycle.enablePlugin("tool", P().consent.hash));
  await settle();
  assert.ok(activeManifest(P(), "tool"));
  assert.equal(P().records.tool.files, EDITED);
  assert.deepEqual(pins(), [["tool", EDITED]]);
});

test("a sheet can't approve files other than the ones it was opened for", async () => {
  assert.ok(lifecycle.disablePlugin("tool", consentToken()));
  await settle();
  assert.ok(lifecycle.requestPluginConsent("tool"));
  const asked = P().consent;
  usePlugins.setState((s) => ({ listings: { ...s.listings, tool: { ...s.listings.tool, files: APPROVED } } }));
  assert.equal(lifecycle.enablePlugin("tool", asked.hash), false, "the files changed under the open sheet");
  await scan([kept, older, tool(APPROVED)]);
  assert.equal(P().consent, null, "the next scan closes the sheet");
  assert.equal(activeManifest(P(), "tool"), null);
});

test("a plugin with programs whose files can't be read can't be turned on, and says why", async () => {
  await scan([kept, older, entry("tool", TOOL, "1:10", { filesProblem: "bin/x is a link; a plugin's programs may not contain links" })]);
  assert.deepEqual(P().listings.tool.problems, ["Its files can't be approved: bin/x is a link; a plugin's programs may not contain links"]);
  assert.equal(lifecycle.requestPluginConsent("tool"), false);
  await scan([kept, older, tool(null)]);
  assert.deepEqual(P().listings.tool.problems, ["Its files can't be approved: they couldn't be read"]);
  await scan([kept, older, tool("not a digest")]);
  assert.equal(P().listings.tool.manifest, null);
});

test("only a plugin you installed that puts programs on PATH pins its files", async () => {
  const page = JSON.stringify({ manifest: 1, name: "pager", title: "Pager", page: { title: "Pager", icon: "doc", file: "index.html" } });
  await scan([kept, older, entry("pager", page, "4:40", { files: APPROVED }), tool(APPROVED)]);
  assert.equal(P().listings.pager.files, null);
  assert.ok(lifecycle.requestPluginConsent("pager"));
  assert.equal(P().consent.files, null);
  assert.ok(lifecycle.enablePlugin("pager", P().consent.hash));
  assert.equal(P().records.pager.files, undefined);
  assert.ok(activeManifest(P(), "pager"));
  const cli = JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", alwaysOn: true, programs: [{ name: "ardia", path: "bin/ardia" }] });
  await scan([{ name: "cli", status: "ok", text: cli, folderId: "bundled", bundled: true, files: APPROVED }, kept, older, tool(APPROVED)]);
  assert.equal(P().listings.cli.files, null, "a built-in is checked against the digest it was signed with");
});

test("the sheet says the files are approved as they are, only for a plugin that pins them", () => {
  const manifest = P().listings.tool.manifest;
  const line = "Approves its files as they are now. If any of them changes, it turns off until you approve it again";
  assert.ok(consentLines(manifest, true).some((l) => l.text === line));
  assert.ok(!consentLines(manifest).some((l) => l.text === line));
});

test("plugins.json keeps a well-formed files digest and drops anything else", () => {
  const base = { enabled: true, approved: APPROVED, values: {}, applied: {} };
  const read = parsePluginRecords(pluginRecordsJson({ good: { ...base, files: EDITED }, bad: { ...base, files: "../x" } }));
  assert.equal(read.good.files, EDITED);
  assert.equal("files" in read.bad, false);
});
