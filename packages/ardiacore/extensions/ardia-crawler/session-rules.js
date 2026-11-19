export const NAVIGATION_HEADER = "X-Ardia-Crawler";
export const SHOPIFY_SIGNATURE_AGENT = '"https://shopify.com"';
export const MAX_SHOPIFY_SIGNATURES = 64;
export const MAX_HEADER_VALUE_LENGTH = 4096;

export const ALL_RESOURCE_TYPES = Object.freeze([
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

const NAVIGATION_TYPES = Object.freeze(["main_frame", "sub_frame"]);
const HEADER_VALUE = /^[\x20-\x7e]+$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const QUOTED_STRING = /"(?:[^"\\]|\\.)*"/g;
const EXPIRES_PARAMETER = /;\s*expires=([^;,\s]*)/g;
const SHOPIFY_KEYS = ["domain", "signatureInput", "signature"];

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireHeaderValue(value, where) {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  if (value.length === 0 || value.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE.test(value) || value !== value.trim()) {
    throw new Error(`${where} is not a valid header value (printable ASCII, no CR or LF, no surrounding spaces, 1 to ${MAX_HEADER_VALUE_LENGTH} characters)`);
  }
  return value;
}

function requireHost(value, where) {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  const host = value.toLowerCase();
  if (!HOST.test(host)) throw new Error(`${where} must be a bare host name such as shop.example.com`);
  return host;
}

export function signatureExpiresAt(signatureInput) {
  const outsideQuotes = signatureInput.replace(QUOTED_STRING, '""');
  let earliest = null;
  for (const [, seconds] of outsideQuotes.matchAll(EXPIRES_PARAMETER)) {
    if (!/^\d{1,12}$/.test(seconds)) throw new Error("unreadable expires parameter");
    const at = Number(seconds) * 1000;
    earliest = earliest === null ? at : Math.min(earliest, at);
  }
  return earliest;
}

function readShopifyEntry(entry, index) {
  const where = `shopify[${index}]`;
  if (!isPlainObject(entry)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(entry)) if (!SHOPIFY_KEYS.includes(key)) throw new Error(`${where} has an unknown key ${key}`);
  const domain = requireHost(entry.domain, `${where}.domain`);
  const signatureInput = requireHeaderValue(entry.signatureInput, `${where}.signatureInput`);
  const signature = requireHeaderValue(entry.signature, `${where}.signature`);
  let expiresAt;
  try {
    expiresAt = signatureExpiresAt(signatureInput);
  } catch {
    throw new Error(`${where}.signatureInput has an unreadable expires parameter`);
  }
  return { domain, signatureInput, signature, expiresAt };
}

export function readConfig(config) {
  if (!isPlainObject(config)) throw new Error("configure needs an object");
  for (const key of Object.keys(config)) if (key !== "navigationHeader" && key !== "shopify") throw new Error(`configure got an unknown key ${key}`);
  if (!("navigationHeader" in config)) throw new Error("navigationHeader is required (a string or null)");
  const navigationHeader = config.navigationHeader === null ? null : requireHeaderValue(config.navigationHeader, "navigationHeader");
  if (!Array.isArray(config.shopify)) throw new Error("shopify must be an array");
  if (config.shopify.length > MAX_SHOPIFY_SIGNATURES) throw new Error(`shopify has more than ${MAX_SHOPIFY_SIGNATURES} entries`);
  const shopify = config.shopify.map(readShopifyEntry);
  const domains = new Set();
  for (const { domain } of shopify) {
    if (domains.has(domain)) throw new Error(`shopify lists ${domain} twice`);
    domains.add(domain);
  }
  return { navigationHeader, shopify };
}

const setHeader = (header, value) => ({ header, operation: "set", value });

export function buildSessionRules(config, now = Date.now()) {
  const { navigationHeader, shopify } = readConfig(config);
  const rules = [];
  if (navigationHeader !== null) {
    rules.push({
      id: rules.length + 1,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [setHeader(NAVIGATION_HEADER, navigationHeader)] },
      condition: { resourceTypes: [...NAVIGATION_TYPES] },
    });
  }
  for (const entry of shopify) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
    rules.push({
      id: rules.length + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          setHeader("Signature-Input", entry.signatureInput),
          setHeader("Signature", entry.signature),
          setHeader("Signature-Agent", SHOPIFY_SIGNATURE_AGENT),
        ],
      },
      condition: { requestDomains: [entry.domain], urlFilter: `|https://${entry.domain}/`, resourceTypes: [...ALL_RESOURCE_TYPES] },
    });
  }
  return rules;
}

export function secretValuesOf(config) {
  if (!isPlainObject(config) || !Array.isArray(config.shopify)) return [];
  return config.shopify
    .flatMap((entry) => (isPlainObject(entry) ? [entry.signatureInput, entry.signature] : []))
    .filter((value) => typeof value === "string" && value.length > 0);
}

export function redact(message, secrets) {
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), String(message));
}
