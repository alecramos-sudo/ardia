#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMatcher, RESOURCE_TYPES } from "./dnr-matcher.mjs";

export const EXTENSION_DIR = fileURLToPath(new URL("../extensions/ardia-crawler/", import.meta.url));
export const SOURCE_PATH = `${EXTENSION_DIR}trackers.source.json`;
export const GENERATED_PATHS = Object.freeze({
  trackers: `${EXTENSION_DIR}rules/trackers.json`,
  vendors: `${EXTENSION_DIR}rules/vendors.json`,
  manifest: `${EXTENSION_DIR}manifest.json`,
});
export const RULESET_ID = "trackers";
export const DNR_LIMITS = Object.freeze({ staticRules: 30000, regexRules: 1000 });

const RULES_VERSION = /^(\d{4})-(\d{2})-(\d{2})\.(\d{1,4})$/;
const VENDOR_NAME = /^[a-z][a-z0-9]*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const RE2_UNSUPPORTED = /\(\?[=!<>]|\\[1-9]|\\k<|[*+?}]\+/;
const ENTRY_KEYS = new Set(["requestDomains", "urlFilter", "regexFilter", "resourceTypes", "fixtures"]);
const VENDOR_KEYS = new Set(["vendor", "what", "rules"]);

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const readSources = () => readJson(SOURCE_PATH);
const asJsonFile = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function extensionIdFromKey(base64Key) {
  const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join("");
}

export function regexProblem(source) {
  if (RE2_UNSUPPORTED.test(source)) return "uses a lookaround, backreference or possessive quantifier RE2 rejects";
  try {
    new RegExp(source, "i");
  } catch (error) {
    return `does not compile: ${error.message}`;
  }
  return null;
}

function rejectUnknownKeys(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`${where}: unknown key ${key}`);
}

function conditionOf(entry, where) {
  rejectUnknownKeys(entry, ENTRY_KEYS, where);
  const condition = {};
  if (entry.requestDomains !== undefined) {
    if (!Array.isArray(entry.requestDomains) || entry.requestDomains.length === 0) throw new Error(`${where}: requestDomains must be a non-empty array`);
    for (const domain of entry.requestDomains) {
      if (typeof domain !== "string" || !DOMAIN.test(domain)) throw new Error(`${where}: ${domain} is not a lowercase ASCII domain`);
    }
    condition.requestDomains = [...entry.requestDomains];
  }
  if (entry.urlFilter !== undefined && entry.regexFilter !== undefined) throw new Error(`${where}: use urlFilter or regexFilter, not both`);
  if (entry.urlFilter !== undefined) {
    if (typeof entry.urlFilter !== "string" || !PRINTABLE_ASCII.test(entry.urlFilter) || entry.urlFilter.startsWith("||*")) {
      throw new Error(`${where}: urlFilter must be printable ASCII and must not start with ||*`);
    }
    condition.urlFilter = entry.urlFilter;
  }
  if (entry.regexFilter !== undefined) {
    const problem = typeof entry.regexFilter === "string" ? regexProblem(entry.regexFilter) : "is not a string";
    if (problem) throw new Error(`${where}: regexFilter ${problem}`);
    condition.regexFilter = entry.regexFilter;
  }
  if (!condition.requestDomains && condition.urlFilter === undefined && condition.regexFilter === undefined) {
    throw new Error(`${where}: needs requestDomains, urlFilter or regexFilter`);
  }
  if (entry.resourceTypes !== undefined) {
    if (!Array.isArray(entry.resourceTypes) || entry.resourceTypes.length === 0) throw new Error(`${where}: resourceTypes must be a non-empty array`);
    for (const type of entry.resourceTypes) if (!RESOURCE_TYPES.includes(type)) throw new Error(`${where}: unknown resource type ${type}`);
    condition.resourceTypes = [...entry.resourceTypes];
  } else {
    condition.resourceTypes = [...RESOURCE_TYPES];
  }
  if (!Array.isArray(entry.fixtures) || entry.fixtures.length === 0) throw new Error(`${where}: needs at least one fixture URL`);
  for (const fixture of entry.fixtures) new URL(fixture);
  return condition;
}

export function buildRules(sources) {
  if (!RULES_VERSION.test(sources.rulesVersion ?? "")) throw new Error("rulesVersion must look like 2026-11-18.1");
  const rules = [];
  const vendorByRuleId = {};
  const seenVendors = new Set();
  const seenDomains = new Set();
  for (const group of sources.vendors) {
    rejectUnknownKeys(group, VENDOR_KEYS, `vendor ${group.vendor}`);
    if (!VENDOR_NAME.test(group.vendor ?? "")) throw new Error(`vendor name ${group.vendor} must be lowercase letters and digits`);
    if (seenVendors.has(group.vendor)) throw new Error(`vendor ${group.vendor} is listed twice`);
    seenVendors.add(group.vendor);
    group.rules.forEach((entry, index) => {
      const where = `${group.vendor}.rules[${index}]`;
      const condition = conditionOf(entry, where);
      if (condition.urlFilter === undefined && condition.regexFilter === undefined) {
        for (const domain of condition.requestDomains) {
          if (seenDomains.has(domain)) throw new Error(`${where}: ${domain} is blocked twice`);
          seenDomains.add(domain);
        }
      }
      const id = rules.length + 1;
      rules.push({ id, priority: 1, action: { type: "block" }, condition });
      vendorByRuleId[id] = group.vendor;
    });
  }
  const regexRules = rules.filter((rule) => rule.condition.regexFilter !== undefined).length;
  if (rules.length > DNR_LIMITS.staticRules) throw new Error(`${rules.length} rules is over DNR's ${DNR_LIMITS.staticRules}`);
  if (regexRules > DNR_LIMITS.regexRules) throw new Error(`${regexRules} regex rules is over DNR's ${DNR_LIMITS.regexRules}`);
  return { rules, vendorByRuleId, regexRules };
}

export function chromeVersionOf(rulesVersion) {
  const [, year, month, day, build] = RULES_VERSION.exec(rulesVersion);
  return [year, month, day, build].map(Number).join(".");
}

export function generate(sources = readSources(), manifest = readJson(GENERATED_PATHS.manifest)) {
  const { rules, vendorByRuleId } = buildRules(sources);
  const updatedManifest = { ...manifest, version: chromeVersionOf(sources.rulesVersion), version_name: sources.rulesVersion };
  return {
    trackers: asJsonFile(rules),
    vendors: asJsonFile({ rulesVersion: sources.rulesVersion, ruleset: RULESET_ID, vendors: vendorByRuleId }),
    manifest: asJsonFile(updatedManifest),
  };
}

export function staleGeneratedFiles(generated = generate()) {
  return Object.entries(GENERATED_PATHS)
    .filter(([name, path]) => readFileSync(path, "utf8") !== generated[name])
    .map(([, path]) => path);
}

export function loadCrawlerRules() {
  const rules = readJson(GENERATED_PATHS.trackers);
  const { rulesVersion, vendors } = readJson(GENERATED_PATHS.vendors);
  return { rules, vendors, rulesVersion };
}

export function createCrawlerMatcher({ rules, vendors } = loadCrawlerRules()) {
  const matcher = createMatcher(rules);
  const describe = (rule) => ({ ruleId: rule.id, vendor: vendors[rule.id] });
  return {
    blockedBy(url, resourceType = "other") {
      const rule = matcher.blockingRule(url, resourceType);
      return rule ? describe(rule) : null;
    },
    allMatches(url, resourceType = "other") {
      return matcher.matchingRules(url, resourceType).map(describe);
    },
  };
}

function main(args) {
  if (args.includes("--help")) {
    process.stdout.write(
      "node packages/ardiacore/scripts/crawler-rules.mjs [--check]\n" +
        "  Generates the crawler extension's rules/trackers.json, rules/vendors.json and manifest version from trackers.source.json.\n" +
        "  --check  exit 1 if the committed files differ from a fresh generation\n",
    );
    return 0;
  }
  const generated = generate();
  if (args.includes("--check")) {
    const stale = staleGeneratedFiles(generated);
    for (const path of stale) process.stderr.write(`stale: ${path}\n`);
    return stale.length ? 1 : 0;
  }
  for (const [name, path] of Object.entries(GENERATED_PATHS)) writeFileSync(path, generated[name]);
  const { rules, regexRules } = buildRules(readSources());
  process.stdout.write(`wrote ${rules.length} rules (${regexRules} regex), rulesVersion ${readSources().rulesVersion}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
