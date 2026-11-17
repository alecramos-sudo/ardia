#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notarize, signForDistribution } from "./sign.mjs";

const usage =
  "usage: scripts/fork/package.mjs --app <built Release Ardia.app> --out <dir> [--hermesc <path>]\n" +
  "       [--feed <https URL of the folder the updates are served from> --ed-key <Sparkle private key file> --sparkle <Sparkle bin dir>] [--base <ref>]\n" +
  "       [--identity <Developer ID Application identity> --notary-profile <notarytool keychain profile>]";
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const built = arg("--app");
const out = arg("--out");
const feed = arg("--feed");
const edKey = arg("--ed-key");
const sparkle = arg("--sparkle");
const identity = arg("--identity");
const notaryProfile = arg("--notary-profile");
const updating = !!(feed || edKey || sparkle);
if (!built || !out || (updating && !(feed?.endsWith("/") && edKey && sparkle)) || !identity !== !notaryProfile) {
  console.error(usage);
  process.exit(64);
}

const NAME = "Ardia Fork";
const BUNDLE_ID = "com.alecramos.ardiafork";
const DATA_DIR = identity ? null : "~/Library/Application Support/Ardia Fork";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = join(repo, "apps/browser");
const run = (cmd, argv, options = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
const git = (...argv) => run("git", ["-C", repo, ...argv]).trim();
if (git("status", "--porcelain")) throw new Error("the checkout has uncommitted changes: commit them so the build names one commit");
const commit = git("rev-parse", "--short", "HEAD");
const ahead = git("rev-list", "--count", `${arg("--base") ?? "origin/main"}..HEAD`);

function publicKeyOf(file) {
  const seed = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (seed.length !== 32) throw new Error(`${file} is not a 32-byte Ed25519 seed in base64`);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
}

const work = resolve(out);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "js"), { recursive: true });

const rn = join(repo, "node_modules/react-native-macos");
const js = join(work, "js/main.js");
const hbc = join(work, "js/main.jsbundle");
run(process.execPath, [
  join(rn, "scripts/bundle.js"), "bundle", "--entry-file", "index.js", "--platform", "macos", "--dev", "false", "--minify", "false",
  "--bundle-output", js, "--assets-dest", join(work, "js"), "--config-cmd", `'${process.execPath}' '${join(rn, "cli.js")}' config`,
], { cwd: appDir });
const hermesc = arg("--hermesc") ?? join(appDir, "macos/Pods/hermes-engine/destroot/bin/hermesc");
if (!existsSync(hermesc)) throw new Error(`no hermesc at ${hermesc}: pass --hermesc`);
run(hermesc, ["-emit-binary", "-O", "-out", hbc, js]);

const app = join(work, `${NAME}.app`);
run("cp", ["-cR", resolve(built), app]);
const resources = join(app, "Contents/Resources");
cpSync(hbc, join(resources, "main.jsbundle"));
const files = (dir, base = dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)])) : []);
const shipped = new Set(files(join(resources, "assets")));
const added = files(join(work, "js/assets")).filter((f) => !shipped.has(f));
for (const f of added) cpSync(join(work, "js/assets", f), join(resources, "assets", f), { recursive: true });

const plist = join(app, "Contents/Info.plist");
const buddy = (...commands) => run("/usr/libexec/PlistBuddy", [...commands.flatMap((c) => ["-c", c]), plist]);
const version = buddy("Print :CFBundleShortVersionString").trim();
const build = `${buddy("Print :CFBundleVersion").trim()}.${ahead}`;
buddy(
  `Set :CFBundleIdentifier ${BUNDLE_ID}`,
  `Set :CFBundleName ${NAME}`,
  `Set :CFBundleDisplayName ${NAME}`,
  `Set :CFBundleVersion ${build}`,
  "Add :LSEnvironment dict",
  ...(DATA_DIR ? [`Add :LSEnvironment:ARDIA_DATA_DIR string ${DATA_DIR}`] : []),
  `Add :ACForkCommit string ${commit}`,
  ...(updating
    ? [
        `Set :SUFeedURL ${feed}appcast.xml`,
        `Set :SUPublicEDKey ${publicKeyOf(edKey)}`,
        "Set :SUEnableAutomaticChecks true",
        "Set :SUScheduledCheckInterval 3600",
        `Add :LSEnvironment:ARDIA_INSTANCE string updateFeed=${feed}appcast.xml`,
      ]
    : ["Set :SUEnableAutomaticChecks false", "Delete :SUFeedURL"]),
);

const granted = run("codesign", ["-d", "--entitlements", "-", "--xml", resolve(built)], { stdio: ["ignore", "pipe", "ignore"] });
const entitlements = join(work, "entitlements.plist");
writeFileSync(entitlements, granted.replace(/<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\/>/, ""));
if (identity) {
  signForDistribution({ app, identity, entitlements, signing: join(repo, "packages/ardiacore/scripts/signing"), bundleId: BUNDLE_ID });
  notarize({ app, profile: notaryProfile, work });
} else {
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", entitlements, app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
}

const site = join(work, "site");
mkdirSync(site, { recursive: true });
const archive = `Ardia-Fork-${version}-${build}.zip`;
const zip = join(site, archive);
run("ditto", ["-c", "-k", "--keepParent", app, zip]);
const sha = run("shasum", ["-a", "256", zip]).split(" ")[0];
if (updating) {
  const changes = git("log", "--no-merges", "--format=- %s", `${arg("--base") ?? "origin/main"}..HEAD`);
  writeFileSync(join(site, archive.replace(/\.zip$/, ".md")), `**${NAME} ${version} (${build})**\n\n${changes}\n`);
  run(join(sparkle, "generate_appcast"), ["--ed-key-file", resolve(edKey), "--download-url-prefix", feed, "--embed-release-notes", "--maximum-deltas", "0", "-o", join(site, "appcast.xml"), site]);
  if (!readFileSync(join(site, "appcast.xml"), "utf8").includes(`<sparkle:version>${build}</sparkle:version>`)) throw new Error(`appcast.xml has no item for build ${build}`);
}
cpSync(zip, join(site, "Ardia-Fork.zip"));
const info = { name: NAME, bundleId: BUNDLE_ID, dataDir: DATA_DIR ?? `~/Library/Application Support/${BUNDLE_ID}`, signed: identity ? "developer-id" : "ad-hoc", version, build, commit, feed: updating ? `${feed}appcast.xml` : null, archive, sha256: sha, bytes: statSync(zip).size, addedAssets: added };
writeFileSync(join(site, "build.json"), JSON.stringify(info, null, 2));
console.log(JSON.stringify({ ...info, site }, null, 2));
