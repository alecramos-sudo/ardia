import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const run = (cmd, argv) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SIGN_TRIES = 5;
const HELPER = "restrict,library,kill,runtime";
const PAGE_HELPER = "restrict,kill,runtime";

function sign(identity, target, ...options) {
  let failure = "";
  for (let attempt = 1; attempt <= SIGN_TRIES; attempt++) {
    try {
      return run("codesign", ["--force", "--timestamp", "--sign", identity, ...options, target]);
    } catch (error) {
      failure = String(error.stderr || error.message).trim();
      if (attempt < SIGN_TRIES) pause(5000);
    }
  }
  throw new Error(`couldn't sign ${target}: ${failure}`);
}

function signEngine(identity, framework, signing, bundleId) {
  const current = realpathSync(join(framework, "Versions/Current"));
  const libraries = join(current, "Libraries");
  for (const lib of readdirSync(libraries).filter((f) => f.endsWith(".dylib"))) sign(identity, join(libraries, lib));
  const helpers = join(current, "Helpers");
  for (const helper of readdirSync(helpers).filter((f) => f.endsWith(".app"))) {
    const path = join(helpers, helper);
    if (helper.endsWith("Renderer).app")) sign(identity, path, "--options", PAGE_HELPER, "--entitlements", join(signing, "renderer.entitlements"));
    else if (helper.endsWith("GPU).app")) sign(identity, path, "--options", PAGE_HELPER, "--entitlements", join(signing, "gpu.entitlements"));
    else sign(identity, path, "--options", HELPER);
  }
  for (const tool of ["chrome_crashpad_handler", "app_mode_loader"]) sign(identity, join(helpers, tool), "--options", HELPER);
  const copier = join(helpers, "web_app_shortcut_copier");
  if (existsSync(copier)) sign(identity, copier, "--options", HELPER, "--identifier", `${bundleId}.web_app_shortcut_copier`);
  sign(identity, framework);
}

function signSparkle(identity, framework) {
  const current = realpathSync(join(framework, "Versions/Current"));
  for (const part of ["XPCServices/Downloader.xpc", "XPCServices/Installer.xpc", "Updater.app", "Autoupdate"])
    sign(identity, join(current, part), "--options", "runtime", "--preserve-metadata=entitlements");
  sign(identity, framework, "--options", "runtime");
}

export function signForDistribution({ app, identity, entitlements, signing, bundleId }) {
  const frameworks = join(app, "Contents/Frameworks");
  signEngine(identity, join(frameworks, "Chromium Framework.framework"), signing, bundleId);
  signSparkle(identity, join(frameworks, "Sparkle.framework"));
  sign(identity, join(frameworks, "hermes.framework"), "--options", "runtime");
  const plugins = join(app, "Contents/PlugIns");
  for (const plugin of existsSync(plugins) ? readdirSync(plugins) : []) sign(identity, join(plugins, plugin), "--options", "runtime");
  sign(identity, app, "--options", "runtime", "--entitlements", entitlements);
  run("codesign", ["--verify", "--deep", "--strict", app]);
}

export function notarize({ app, profile, work }) {
  const upload = join(work, "notarize.zip");
  run("ditto", ["-c", "-k", "--keepParent", app, upload]);
  const answer = run("xcrun", ["notarytool", "submit", upload, "--keychain-profile", profile, "--wait", "--timeout", "1h"]);
  rmSync(upload);
  const id = /^\s*id: (\S+)/m.exec(answer)?.[1] ?? "unknown";
  if (!/status: Accepted/.test(answer)) throw new Error(`Apple did not accept the build (xcrun notarytool log ${id} --keychain-profile "${profile}"):\n${answer}`);
  run("xcrun", ["stapler", "staple", app]);
  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["--assess", "--type", "execute", app]);
  return id;
}
