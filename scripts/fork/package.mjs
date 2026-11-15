#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "usage: scripts/fork/package.mjs --app <built Release Ardia.app> --out <dir> [--hermesc <path>]";
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const built = arg("--app");
const out = arg("--out");
if (!built || !out) {
  console.error(usage);
  process.exit(64);
}

const NAME = "Ardia Fork";
const BUNDLE_ID = "com.alecramos.ardiafork";
const DATA_DIR = "~/Library/Application Support/Ardia Fork";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = join(repo, "apps/browser");
const run = (cmd, argv, options = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
const git = (...argv) => run("git", ["-C", repo, ...argv]).trim();
if (git("status", "--porcelain")) throw new Error("the checkout has uncommitted changes: commit them so the build names one commit");
const commit = git("rev-parse", "--short", "HEAD");

const work = resolve(out);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "js"), { recursive: true });

const rn = join(repo, "node_modules/react-native-macos");
const js = join(work, "js/main.js");
const hbc = join(work, "js/main.jsbundle");
run(process.execPath, [
  join(rn, "scripts/bundle.js"), "bundle", "--entry-file", "index.js", "--platform", "macos", "--dev", "false", "--minify", "false",
  "--bundle-output", js, "--assets-dest", join(work, "js/assets"), "--config-cmd", `'${process.execPath}' '${join(rn, "cli.js")}' config`,
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
buddy(
  `Set :CFBundleIdentifier ${BUNDLE_ID}`,
  `Set :CFBundleName ${NAME}`,
  `Set :CFBundleDisplayName ${NAME}`,
  "Set :SUEnableAutomaticChecks false",
  "Delete :SUFeedURL",
  "Add :LSEnvironment dict",
  `Add :LSEnvironment:ARDIA_DATA_DIR string ${DATA_DIR}`,
  `Add :ACForkCommit string ${commit}`,
);

const granted = run("codesign", ["-d", "--entitlements", "-", "--xml", resolve(built)], { stdio: ["ignore", "pipe", "ignore"] });
const entitlements = join(work, "entitlements.plist");
writeFileSync(entitlements, granted.replace(/<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\/>/, ""));
run("codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", entitlements, app]);
run("codesign", ["--verify", "--deep", "--strict", app]);

const zip = join(work, `Ardia-Fork-${version}-${commit}.zip`);
run("ditto", ["-c", "-k", "--keepParent", app, zip]);
const sha = run("shasum", ["-a", "256", zip]).split(" ")[0];
writeFileSync(join(work, "build.json"), JSON.stringify({ name: NAME, bundleId: BUNDLE_ID, dataDir: DATA_DIR, version, commit, zip, sha256: sha, bytes: statSync(zip).size, addedAssets: added }, null, 2));
console.log(readFileSync(join(work, "build.json"), "utf8"));
