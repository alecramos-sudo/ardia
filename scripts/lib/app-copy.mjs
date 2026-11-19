import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const NO_METRO = "127.0.0.1:1";
const TEST_COPY_SUFFIX = ".testcopy";
const LIBRARY_VALIDATION_OFF = "com.apple.security.cs.disable-library-validation";

export const INJECTION_ENTITLEMENTS = ["com.apple.security.cs.allow-dyld-environment-variables", LIBRARY_VALIDATION_OFF];

const installed = (path) => path.startsWith("/Applications/");
const infoValue = (app, key) =>
  spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], { encoding: "utf8" }).stdout?.trim() || null;

let removals = null;
function removeAtExit(dir) {
  if (!removals) {
    removals = new Set();
    process.on("exit", () => {
      for (const path of removals) rmSync(path, { recursive: true, force: true });
    });
  }
  removals.add(dir);
}

export function isTestCopy(app) {
  const signature = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr ?? "";
  return (infoValue(app, "CFBundleIdentifier") ?? "").endsWith(TEST_COPY_SUFFIX) && /^Signature=adhoc$/m.test(signature);
}

export function signTestCopy(copy, entitlements = []) {
  if (installed(resolve(copy)) || installed(realpathSync(resolve(copy)))) throw new Error(`${copy} is installed in /Applications: sign a copy of it`);
  const id = infoValue(copy, "CFBundleIdentifier");
  if (!id) throw new Error(`${copy} has no CFBundleIdentifier`);
  if (!id.endsWith(TEST_COPY_SUFFIX)) execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${id}${TEST_COPY_SUFFIX}`, join(copy, "Contents/Info.plist")]);
  const plist = join(dirname(copy), "test-copy.entitlements");
  const keys = [...new Set([LIBRARY_VALIDATION_OFF, ...entitlements])];
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`);
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", plist, copy], { stdio: ["ignore", "ignore", "inherit"] });
  return copy;
}

export function prepareApp(app, dir, { bundle = null, entitlements: extra = [], keep = false } = {}) {
  if (installed(resolve(app))) throw new Error(`${app} is installed in /Applications: pass a build or a copy`);
  const source = realpathSync(resolve(app));
  if (installed(source)) throw new Error(`${app} is installed in /Applications: pass a build or a copy`);
  const copy = join(dir, "Ardia.app");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!keep) removeAtExit(dir);
  execFileSync("cp", ["-cR", source, copy]);
  const shipped = join(copy, "Contents/Resources/main.jsbundle");
  const swapped = !!bundle && !(existsSync(shipped) && readFileSync(bundle).equals(readFileSync(shipped)));
  if (swapped) cpSync(bundle, shipped);
  if (bundle) writeFileSync(join(copy, "Contents/Resources/ip.txt"), `${NO_METRO}\n`);
  const granted = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const missing = extra.filter((key) => !granted.includes(`<key>${key}</key>`));
  if (!bundle && !missing.length) return copy;
  return signTestCopy(copy, extra);
}
