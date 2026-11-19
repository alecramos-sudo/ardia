import { keychainGet, keychainSet } from "../../platform/keychain";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { isFields } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { backgroundInstance } from "../app/appSettings";
import { confirm } from "../app/system";
import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { warnFor } from "../telemetry/consoleConsent";
import { focusedWindowOf } from "../windows/ui";
import type { Settings } from "./settings";

export const GUARDED_SETTINGS = ["cliControl", "allowJavaScriptFromAppleEvents"] as const;
export type GuardedSetting = (typeof GUARDED_SETTINGS)[number];

type Grants = Record<GuardedSetting, boolean>;

export const SETTING_GRANTS_ACCOUNT = "settingGrants";

const NO_GRANTS: Grants = { cliControl: false, allowJavaScriptFromAppleEvents: false };

const ASKS: Record<GuardedSetting, { title: string; message: string; confirmTitle: string }> = {
  cliControl: {
    title: "Let programs control Ardia?",
    message:
      "Command-line control is set to come on, but it wasn't turned on in Ardia on this Mac. While it's on, any program you run can drive your tabs and pages, with your logins, and your user scripts run in every page.",
    confirmTitle: "Turn On",
  },
  allowJavaScriptFromAppleEvents: {
    title: "Allow JavaScript from Apple Events?",
    message:
      "It's set to be allowed, but it wasn't turned on in Ardia on this Mac. While it's allowed, AppleScript and the apps you let control Ardia can run JavaScript in your pages.",
    confirmTitle: "Allow",
  },
};

const guarded = () => PLATFORM_FEATURES.guardedSettings;

const isGuarded = (key: string): key is GuardedSetting => (GUARDED_SETTINGS as readonly string[]).includes(key);

function patchOf(keys: readonly GuardedSetting[], on: boolean): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of keys) patch[key] = on;
  return patch;
}

function grantsOf(text: string | null): Grants {
  if (!text) return NO_GRANTS;
  try {
    const saved: unknown = JSON.parse(text);
    if (!isFields(saved)) return NO_GRANTS;
    return { cliControl: saved.cliControl === true, allowJavaScriptFromAppleEvents: saved.allowJavaScriptFromAppleEvents === true };
  } catch {
    return NO_GRANTS;
  }
}

let grants: Promise<Grants> | null = null;

function readGrants(consent: ConsentToken | null): Promise<Grants> {
  return keychainGet(SETTING_GRANTS_ACCOUNT).then(grantsOf, (error: unknown) => {
    warnFor(consent, "[settings] couldn't read which guarded settings were turned on in Ardia", error);
    return NO_GRANTS;
  });
}

const currentGrants = (consent: ConsentToken | null) => (grants ??= readGrants(consent));

function recordGrant(key: GuardedSetting, on: boolean, consent: ConsentToken | null) {
  const failed = (error?: unknown) => warnFor(consent, `[settings] couldn't save that ${key} was turned ${on ? "on" : "off"} in Ardia`, error ?? "");
  grants = currentGrants(consent).then((known) => {
    if (known[key] === on) return known;
    const next = { ...known, [key]: on };
    void keychainSet(SETTING_GRANTS_ACCOUNT, JSON.stringify(next)).then((saved) => saved || failed(), failed);
    return next;
  });
}

const restoring = new Set<GuardedSetting>();
const declined = new Set<GuardedSetting>();
const asking = new Map<GuardedSetting, Promise<void>>();
const choices = new Map<GuardedSetting, number>();
let choiceCount = 0;

function recordChoices(patch: Partial<Settings>, consent: ConsentToken | null) {
  for (const key of Object.keys(patch).filter(isGuarded)) {
    choices.set(key, ++choiceCount);
    restoring.delete(key);
    declined.delete(key);
    if (guarded()) recordGrant(key, patch[key] === true, consent);
  }
}

export function noteSettingsChosenInArdia(patch: Partial<Settings>) {
  recordChoices(patch, consentToken());
}

export function grantGuardedSetting(key: GuardedSetting) {
  recordChoices(patchOf([key], true), consentToken());
}

const firstWindowShown = () => new Promise<void>((resolve) => afterFirstWindow(resolve));

async function ask(key: GuardedSetting, consent: ConsentToken | null) {
  if (backgroundInstance) {
    warnFor(consent, `[settings] ${key} was set to come on but wasn't turned on in Ardia, so it stays off`);
    return;
  }
  const before = choices.get(key);
  await firstWindowShown();
  const windowId = focusedWindowOf(useBrowser.getState()) ?? undefined;
  const { confirmed } = await confirm({ ...ASKS[key], cancelTitle: "Keep Off", windowId });
  if (choices.get(key) !== before) return;
  recordChoices(patchOf([key], confirmed), consent);
  if (!confirmed) declined.add(key);
  useBrowser.getState().updateSettings(patchOf([key], confirmed));
}

function askOnce(key: GuardedSetting, consent: ConsentToken | null): Promise<void> {
  if (declined.has(key)) return Promise.resolve();
  const pending = asking.get(key);
  if (pending) return pending;
  const asked = ask(key, consent).finally(() => asking.delete(key));
  asking.set(key, asked);
  return asked;
}

async function turnOnIfGranted(key: GuardedSetting, consent: ConsentToken | null) {
  const before = choices.get(key);
  const known = await currentGrants(consent);
  if (choices.get(key) !== before) return;
  if (!known[key]) return askOnce(key, consent);
  useBrowser.getState().updateSettings(patchOf([key], true));
}

export function turnOnGuardedSetting(key: GuardedSetting) {
  if (!guarded()) return useBrowser.getState().updateSettings(patchOf([key], true));
  void turnOnIfGranted(key, consentToken());
}

async function restoreIfGranted(key: GuardedSetting, consent: ConsentToken | null) {
  const known = await currentGrants(consent);
  if (!restoring.has(key)) return;
  if (!known[key]) return askOnce(key, consent);
  restoring.delete(key);
  useBrowser.getState().updateSettings(patchOf([key], true), { fromSync: true });
}

export function startGuardedSettings() {
  if (!guarded()) return;
  const { settings, updateSettings } = useBrowser.getState();
  const restored = GUARDED_SETTINGS.filter((key) => settings[key]);
  if (!restored.length) return;
  const consent = consentToken();
  for (const key of restored) restoring.add(key);
  updateSettings(patchOf(restored, false), { fromSync: true });
  for (const key of restored) void restoreIfGranted(key, consent);
}
