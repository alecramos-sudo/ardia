import { isFields, isString } from "../../lib/decode";
import {
  MAX_AIR_TRAFFIC_RULES,
  cleanRule,
  patternProblem,
  sameTarget,
  siteHost,
  type AirTrafficConfig,
  type AirTrafficRule,
  type LinkCondition,
  type OpenAs,
  type SourceApp,
} from "./rules";

const LEGACY_OPENS = ["littleArdia", "tab", "window"] as const;
const MAX_LEGACY_LINK_RULES = 200;
const BUNDLE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

type LegacyOpen = (typeof LEGACY_OPENS)[number];
export type LegacyLinkRule = { id: string; site: string; app: string | null; profileId: string; open: LegacyOpen | null };
export type LegacyContext = { littleArdiaOn: boolean; recentApps: readonly SourceApp[] };

const isLegacyRule = (v: unknown): v is LegacyLinkRule =>
  isFields(v) &&
  isString(v.id) &&
  isString(v.site) &&
  isString(v.profileId) &&
  (v.app === null || isString(v.app)) &&
  (v.open === null || LEGACY_OPENS.includes(v.open as LegacyOpen));

export const isLegacyLinkRuleList = (v: unknown): v is LegacyLinkRule[] => Array.isArray(v) && v.length <= MAX_LEGACY_LINK_RULES && v.every(isLegacyRule);

function siteCondition(host: string): LinkCondition | null {
  const site = siteHost(host);
  return site ? { kind: "site", host: site } : null;
}

function patternCondition(pattern: string): LinkCondition | null {
  return patternProblem(pattern) ? null : { kind: "pattern", pattern };
}

export function legacySiteCondition(given: string): LinkCondition | null {
  const site = given.trim();
  if (!site || /\s/.test(site)) return null;
  if (site.includes("://")) return patternCondition(site);
  const slash = site.indexOf("/");
  const host = (slash < 0 ? site : site.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? "/*" : site.slice(slash);
  if (!host) return null;
  if (path === "/*") return siteCondition(host);
  const exactHost = host.startsWith("*.") || host.startsWith("www.");
  return patternCondition(`*://${exactHost ? host : `*.${host}`}${path}`);
}

export function legacySourceApp(app: string | null, recentApps: readonly SourceApp[]): SourceApp | null {
  const name = app?.trim();
  if (!name) return null;
  const known = recentApps.find((a) => a.bundleId?.toLowerCase() === name.toLowerCase());
  if (known) return known;
  return { bundleId: BUNDLE_ID.test(name) ? name : null, name };
}

const legacyOpenAs = (open: LegacyOpen | null, littleArdiaOn: boolean): OpenAs & LegacyOpen => open ?? (littleArdiaOn ? "littleArdia" : "tab");

export const withSettledLegacyOpens = (legacy: unknown, littleArdiaOn: boolean): unknown =>
  isLegacyLinkRuleList(legacy) ? legacy.map((rule) => ({ ...rule, open: legacyOpenAs(rule.open, littleArdiaOn) })) : legacy;

export function airTrafficRuleOf(legacy: LegacyLinkRule, context: LegacyContext): Omit<AirTrafficRule, "id"> | null {
  const when = legacySiteCondition(legacy.site);
  if (!when || !legacy.profileId) return null;
  return { enabled: true, from: legacySourceApp(legacy.app, context.recentApps), when, profileId: legacy.profileId, open: legacyOpenAs(legacy.open, context.littleArdiaOn) };
}

const sourceKey = (from: SourceApp | null) => (from ? (from.bundleId ?? from.name).toLowerCase() : null);

const sameCondition = (a: LinkCondition, b: LinkCondition) => JSON.stringify(a) === JSON.stringify(b);

const sameRouting = (a: Omit<AirTrafficRule, "id">, b: Omit<AirTrafficRule, "id">) =>
  sourceKey(a.from) === sourceKey(b.from) && sameCondition(a.when, b.when) && sameTarget(a, b);

function freeId(wanted: string, taken: ReadonlySet<string>): string {
  const base = wanted || "link";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export type LegacyCarry = { config: AirTrafficConfig; left: LegacyLinkRule[] };

const movedReceipt = (rule: LegacyLinkRule) => JSON.stringify([rule.id, rule.site, rule.app, rule.profileId, rule.open]);

export function withLegacyLinkRules(config: AirTrafficConfig, legacy: unknown, context: LegacyContext): LegacyCarry {
  if (!isLegacyLinkRuleList(legacy)) return { config, left: [] };
  const rules = [...config.rules];
  const movedBefore = new Set(config.movedLinkRules ?? []);
  const moved = new Set(movedBefore);
  const taken = new Set(rules.map((r) => r.id));
  const left: LegacyLinkRule[] = [];
  for (const old of legacy) {
    const receipt = movedReceipt(old);
    if (movedBefore.has(receipt)) continue;
    const draft = airTrafficRuleOf(old, context);
    if (!draft) continue;
    if (rules.some((r) => sameRouting(r, draft))) {
      moved.add(receipt);
      continue;
    }
    if (rules.length >= MAX_AIR_TRAFFIC_RULES) {
      left.push(old);
      continue;
    }
    const id = freeId(old.id, taken);
    taken.add(id);
    rules.push(cleanRule({ ...draft, id }));
    moved.add(receipt);
  }
  const changed = rules.length !== config.rules.length || moved.size !== movedBefore.size;
  return { config: changed ? { ...config, rules, movedLinkRules: [...moved] } : config, left };
}
