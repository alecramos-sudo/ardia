import { matchesUrl, parseMatchPattern, type MatchSpec } from "../../lib/matchPattern";
import { isFields, isString } from "../../lib/decode";
import type { JsonSchema } from "../../lib/jsonSchema";

export const LINK_OPENS = ["littleArdia", "tab", "window"] as const;
export type LinkOpen = (typeof LINK_OPENS)[number];

export type LinkRule = { id: string; site: string; app: string | null; profileId: string; open: LinkOpen | null };
export type LinkSourceApp = { bundleId: string | null; appName: string | null } | null;

const isRule = (v: unknown): v is LinkRule =>
  isFields(v) &&
  isString(v.id) &&
  isString(v.site) &&
  isString(v.profileId) &&
  (v.app === null || isString(v.app)) &&
  (v.open === null || LINK_OPENS.includes(v.open as LinkOpen));

export const isLinkRuleList = (v: unknown): v is LinkRule[] => Array.isArray(v) && v.length <= 200 && v.every(isRule);

export const LINK_RULES_SCHEMA: JsonSchema = {
  type: "array",
  maxItems: 200,
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      site: { type: "string" },
      app: { type: ["string", "null"] },
      profileId: { type: "string" },
      open: { type: ["string", "null"], enum: [...LINK_OPENS, null] },
    },
    required: ["id", "site", "app", "profileId", "open"],
  },
};

const specCache = new Map<string, MatchSpec[] | string>();

export function siteSpecs(site: string): MatchSpec[] | string {
  const given = site.trim();
  const cached = specCache.get(given);
  if (cached !== undefined) return cached;
  const result = parseSite(given);
  specCache.set(given, result);
  return result;
}

function parseSite(site: string): MatchSpec[] | string {
  if (!site) return "add a site, like github.com";
  if (/\s/.test(site)) return "a site has no spaces";
  if (site.includes("://")) {
    const spec = parseMatchPattern(site);
    return "error" in spec ? spec.error : [spec];
  }
  const slash = site.indexOf("/");
  const host = (slash < 0 ? site : site.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? "/*" : site.slice(slash);
  const hosts = host.startsWith("*.") || host.startsWith("www.") ? [host] : [host, `www.${host}`];
  const specs: MatchSpec[] = [];
  for (const h of hosts) {
    const spec = parseMatchPattern(`*://${h}${path}`);
    if ("error" in spec) return spec.error;
    specs.push(spec);
  }
  return specs;
}

export const siteProblem = (site: string): string | null => {
  const specs = siteSpecs(site);
  return typeof specs === "string" ? specs : null;
};

const appMatches = (app: string | null, source: LinkSourceApp) => {
  if (!app) return true;
  const want = app.trim().toLowerCase();
  return [source?.bundleId, source?.appName].some((name) => !!name && name.toLowerCase() === want);
};

export function linkRuleFor(rules: readonly LinkRule[], url: string, source: LinkSourceApp, usable: (rule: LinkRule) => boolean = () => true): LinkRule | null {
  for (const rule of rules) {
    const specs = siteSpecs(rule.site);
    if (typeof specs === "string" || !appMatches(rule.app, source) || !usable(rule)) continue;
    if (specs.some((spec) => matchesUrl(spec, url))) return rule;
  }
  return null;
}
