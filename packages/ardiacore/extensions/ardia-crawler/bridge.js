import { buildSessionRules, redact, secretValuesOf } from "./session-rules.js";

const dnr = chrome.declarativeNetRequest;
const TRACKERS_RULESET = "trackers";

let vendorTable = null;
const loadVendorTable = () => {
  vendorTable ??= fetch(chrome.runtime.getURL("rules/vendors.json")).then((response) => {
    if (!response.ok) throw new Error(`rules/vendors.json: HTTP ${response.status}`);
    return response.json();
  });
  return vendorTable;
};

let pending = Promise.resolve();
const oneAtATime = (task) => {
  const run = pending.then(task, task);
  pending = run.catch(() => undefined);
  return run;
};

async function replaceSessionRules(rules) {
  const existing = await dnr.getSessionRules();
  await dnr.updateSessionRules({ removeRuleIds: existing.map((rule) => rule.id), addRules: rules });
  return (await dnr.getSessionRules()).length;
}

function configure(config) {
  return oneAtATime(async () => {
    const secrets = secretValuesOf(config);
    try {
      const rules = buildSessionRules(config);
      const sessionRules = await replaceSessionRules(rules);
      if (sessionRules !== rules.length) throw new Error(`session rules: expected ${rules.length}, found ${sessionRules}`);
      return { ok: true, sessionRules };
    } catch (error) {
      throw new Error(redact(error?.message ?? error, secrets));
    }
  });
}

async function stats() {
  const [{ rulesVersion, vendors }, { rulesMatchedInfo }] = await Promise.all([loadVendorTable(), dnr.getMatchedRules({})]);
  const counts = new Map();
  for (const { rule } of rulesMatchedInfo) {
    if (rule.rulesetId !== TRACKERS_RULESET) continue;
    const vendor = vendors[String(rule.ruleId)];
    if (vendor) counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
  }
  const blocked = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  return { blocked, rulesVersion };
}

globalThis.ardiaCrawler = Object.freeze({ configure, stats });
