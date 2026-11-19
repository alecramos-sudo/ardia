export const RESOURCE_TYPES = Object.freeze([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
]);

const SUPPORTED_CONDITION_KEYS = new Set([
  "urlFilter",
  "regexFilter",
  "requestDomains",
  "resourceTypes",
  "excludedResourceTypes",
  "isUrlFilterCaseSensitive",
]);

const SEPARATOR = "(?:[^A-Za-z0-9_\\-.%]|$)";
const SCHEME_AND_SUBDOMAINS = "^[a-z][a-z0-9+.\\-]*://(?:[^/?#@]*@)?(?:[^/?#:@]*\\.)?";

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function urlFilterToRegExp(urlFilter, caseSensitive = false) {
  let rest = urlFilter;
  let prefix = "";
  let suffix = "";
  if (rest.startsWith("||")) {
    prefix = SCHEME_AND_SUBDOMAINS;
    rest = rest.slice(2);
  } else if (rest.startsWith("|")) {
    prefix = "^";
    rest = rest.slice(1);
  }
  if (rest.endsWith("|")) {
    suffix = "$";
    rest = rest.slice(0, -1);
  }
  const body = [...rest]
    .map((char) => (char === "*" ? ".*" : char === "^" ? SEPARATOR : escapeRegex(char)))
    .join("");
  return new RegExp(prefix + body + suffix, caseSensitive ? "" : "i");
}

export function canonicalUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return { href: parsed.href, host: parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase() };
}

const hostIsWithin = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function checkResourceTypes(list, key, ruleId) {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`rule ${ruleId}: ${key} must be a non-empty array`);
  for (const type of list) if (!RESOURCE_TYPES.includes(type)) throw new Error(`rule ${ruleId}: unknown resource type ${type}`);
}

export function compileRule(rule) {
  const condition = rule.condition ?? {};
  for (const key of Object.keys(condition)) {
    if (!SUPPORTED_CONDITION_KEYS.has(key)) throw new Error(`rule ${rule.id}: condition key ${key} is not supported by this matcher`);
  }
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
    throw new Error(`rule ${rule.id}: urlFilter and regexFilter are mutually exclusive`);
  }
  checkResourceTypes(condition.resourceTypes, "resourceTypes", rule.id);
  checkResourceTypes(condition.excludedResourceTypes, "excludedResourceTypes", rule.id);
  if (condition.resourceTypes && condition.excludedResourceTypes) {
    throw new Error(`rule ${rule.id}: resourceTypes and excludedResourceTypes are mutually exclusive`);
  }
  const caseSensitive = condition.isUrlFilterCaseSensitive === true;
  const pattern =
    condition.urlFilter !== undefined
      ? urlFilterToRegExp(condition.urlFilter, caseSensitive)
      : condition.regexFilter !== undefined
        ? new RegExp(condition.regexFilter, caseSensitive ? "" : "i")
        : null;
  const domains = condition.requestDomains?.map((domain) => domain.toLowerCase()) ?? null;
  const appliesToType = condition.resourceTypes
    ? (type) => condition.resourceTypes.includes(type)
    : condition.excludedResourceTypes
      ? (type) => !condition.excludedResourceTypes.includes(type)
      : (type) => type !== "main_frame";
  return {
    rule,
    matches(url, resourceType) {
      if (!RESOURCE_TYPES.includes(resourceType)) throw new Error(`unknown resource type ${resourceType}`);
      if (!appliesToType(resourceType)) return false;
      const { href, host } = canonicalUrl(url);
      if (domains && !domains.some((domain) => hostIsWithin(host, domain))) return false;
      return pattern ? pattern.test(href) : true;
    },
  };
}

export function ruleMatches(rule, url, resourceType) {
  return compileRule(rule).matches(url, resourceType);
}

export function createMatcher(rules) {
  const compiled = rules.map(compileRule);
  return {
    matchingRules(url, resourceType) {
      return compiled.filter((entry) => entry.matches(url, resourceType)).map((entry) => entry.rule);
    },
    blockingRule(url, resourceType) {
      return compiled.find((entry) => entry.rule.action?.type === "block" && entry.matches(url, resourceType))?.rule ?? null;
    },
  };
}
