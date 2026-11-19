import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildRules,
  DNR_LIMITS,
  extensionIdFromKey,
  GENERATED_PATHS,
  loadCrawlerRules,
  readJson,
  readSources,
  regexProblem,
  RULESET_ID,
  staleGeneratedFiles,
  createCrawlerMatcher,
} from "./crawler-rules.mjs";
import { createMatcher, RESOURCE_TYPES, ruleMatches } from "./dnr-matcher.mjs";
import {
  buildSessionRules,
  NAVIGATION_HEADER,
  SHOPIFY_SIGNATURE_AGENT,
  signatureExpiresAt,
} from "../extensions/ardia-crawler/session-rules.js";

const CRAWLER_EXTENSION_ID = "jphbnffonbejilmcbfhnpjfmblejpcgc";
const SUBRESOURCE_TYPES = RESOURCE_TYPES.filter((type) => type !== "main_frame");

const sources = readSources();
const { rules, vendors, rulesVersion } = loadCrawlerRules();
const crawler = createCrawlerMatcher();

describe("crawler ruleset (T1)", () => {
  test("committed generated files equal a fresh generation", () => {
    assert.deepEqual(staleGeneratedFiles(), [], "run node packages/ardiacore/scripts/crawler-rules.mjs");
  });

  test("manifest has the fixed id, the permissions and the trackers ruleset", () => {
    const manifest = readJson(GENERATED_PATHS.manifest);
    assert.equal(extensionIdFromKey(manifest.key), CRAWLER_EXTENSION_ID);
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["declarativeNetRequest", "declarativeNetRequestFeedback"]);
    assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
    assert.deepEqual(manifest.declarative_net_request.rule_resources, [{ id: RULESET_ID, enabled: true, path: "rules/trackers.json" }]);
    assert.equal(manifest.version_name, rulesVersion);
    assert.equal(sources.rulesVersion, rulesVersion);
  });

  test("every fixture is blocked on every type it lists, main frame included, only by rules of its own vendor", () => {
    for (const group of sources.vendors) {
      for (const entry of group.rules) {
        const types = entry.resourceTypes ?? RESOURCE_TYPES;
        for (const url of entry.fixtures) {
          for (const type of types) {
            const matches = crawler.allMatches(url, type);
            assert.ok(matches.length > 0, `${group.vendor}: ${url} (${type}) is not blocked`);
            for (const match of matches) assert.equal(match.vendor, group.vendor, `${url} (${type}) also matches rule ${match.ruleId} of ${match.vendor}`);
          }
        }
      }
    }
  });

  test("tracker rules block every resource type, top-level navigations included", () => {
    for (const rule of rules) {
      assert.equal(rule.condition.excludedResourceTypes, undefined, `rule ${rule.id}`);
      const expected = vendors[rule.id] === "selftest" ? ["main_frame"] : RESOURCE_TYPES;
      assert.deepEqual(rule.condition.resourceTypes, [...expected], `rule ${rule.id}`);
    }
    for (const url of [
      "https://www.google-analytics.com/g/collect?v=2&tid=G-X&en=page_view",
      "https://shop.example.com/.well-known/shopify/monorail/v1/produce",
      "https://www.facebook.com/tr?id=1&ev=PageView",
      "https://shop.example.com/g/collect?v=2&tid=G-X",
    ]) {
      assert.notEqual(crawler.blockedBy(url, "main_frame"), null, `${url} leaks as a top-level navigation`);
    }
  });

  test("the self-test host is blocked as a main frame and nothing else", () => {
    assert.deepEqual(crawler.blockedBy("https://ardia-crawler-selftest.invalid/", "main_frame")?.vendor, "selftest");
    for (const type of SUBRESOURCE_TYPES) assert.equal(crawler.blockedBy("https://ardia-crawler-selftest.invalid/", type), null, type);
  });

  test("no must-not-block URL is blocked, for any resource type", () => {
    for (const { url, what } of sources.mustNotBlock) {
      for (const type of RESOURCE_TYPES) {
        assert.deepEqual(crawler.allMatches(url, type), [], `${what}: ${url} (${type}) is blocked`);
      }
    }
  });

  test("every regexFilter compiles and is RE2-safe", () => {
    const regexes = rules.map((rule) => rule.condition.regexFilter).filter((source) => source !== undefined);
    assert.ok(regexes.length > 0);
    for (const source of regexes) assert.equal(regexProblem(source), null, source);
    assert.match(regexProblem("(?=x)tid"), /RE2/);
    assert.match(regexProblem("(a)\\1"), /RE2/);
  });

  test("within DNR's static and regex limits, with every rule mapped to a vendor", () => {
    const regexRules = rules.filter((rule) => rule.condition.regexFilter !== undefined).length;
    assert.ok(rules.length <= DNR_LIMITS.staticRules);
    assert.ok(regexRules <= DNR_LIMITS.regexRules);
    assert.deepEqual(rules.map((rule) => rule.id), rules.map((_, index) => index + 1));
    for (const rule of rules) {
      assert.equal(rule.action.type, "block");
      assert.ok(vendors[rule.id], `rule ${rule.id} has no vendor`);
    }
  });

  test("the generator refuses bad sources", () => {
    const withEntry = (entry) => ({ rulesVersion: "2026-11-18.1", vendors: [{ vendor: "v", what: "w", rules: [entry] }] });
    assert.throws(() => buildRules(withEntry({ urlFilter: "/x", fixtures: [] })), /fixture/);
    assert.throws(() => buildRules(withEntry({ regexFilter: "(?!a)b", fixtures: ["https://a.test/"] })), /RE2/);
    assert.throws(() => buildRules(withEntry({ requestDomains: ["Bad.Example"], fixtures: ["https://a.test/"] })), /lowercase/);
    assert.throws(() => buildRules(withEntry({ urlFilter: "/x", regexFilter: "x", fixtures: ["https://a.test/"] })), /not both/);
    assert.throws(() => buildRules(withEntry({ urlfilter: "/x", fixtures: ["https://a.test/"] })), /unknown key/);
  });
});

describe("DNR matcher semantics", () => {
  const block = (condition) => ({ id: 1, priority: 1, action: { type: "block" }, condition });

  test("|| anchors on a domain label, ^ on a separator or the end", () => {
    const rule = block({ urlFilter: "||facebook.com/tr^" });
    assert.ok(ruleMatches(rule, "https://www.facebook.com/tr?id=1", "image"));
    assert.ok(ruleMatches(rule, "https://facebook.com/tr", "image"));
    assert.ok(!ruleMatches(rule, "https://notfacebook.com/tr?id=1", "image"));
    assert.ok(!ruleMatches(rule, "https://www.facebook.com/trending", "image"));
    assert.ok(!ruleMatches(rule, "https://www.facebook.com/tr", "main_frame"));
  });

  test("| anchors the start and the end", () => {
    assert.ok(ruleMatches(block({ urlFilter: "|https://a.test/" }), "https://a.test/x", "script"));
    assert.ok(!ruleMatches(block({ urlFilter: "|https://a.test/" }), "https://b.a.test/x", "script"));
    assert.ok(ruleMatches(block({ urlFilter: ".js|" }), "https://a.test/x.js", "script"));
    assert.ok(!ruleMatches(block({ urlFilter: ".js|" }), "https://a.test/x.js?v=1", "script"));
  });

  test("requestDomains matches subdomains, case-insensitively, and ignores the fragment", () => {
    const rule = block({ requestDomains: ["clarity.ms"] });
    assert.ok(ruleMatches(rule, "https://K.Clarity.MS/collect", "ping"));
    assert.ok(!ruleMatches(rule, "https://clarity.ms.evil.test/", "ping"));
    assert.ok(ruleMatches(block({ urlFilter: "collect|" }), "https://a.test/collect#x", "ping"));
  });

  test("resource type defaults and lists", () => {
    assert.ok(!ruleMatches(block({ urlFilter: "x" }), "https://a.test/x", "main_frame"));
    assert.ok(ruleMatches(block({ urlFilter: "x", resourceTypes: ["main_frame"] }), "https://a.test/x", "main_frame"));
    assert.ok(!ruleMatches(block({ urlFilter: "x", resourceTypes: ["main_frame"] }), "https://a.test/x", "script"));
    assert.ok(!ruleMatches(block({ urlFilter: "x", excludedResourceTypes: ["image"] }), "https://a.test/x", "image"));
    assert.throws(() => ruleMatches(block({ initiatorDomains: ["a.test"] }), "https://a.test/", "script"), /not supported/);
  });

  test("createMatcher returns the first blocking rule", () => {
    const matcher = createMatcher([block({ urlFilter: "a" }), { ...block({ urlFilter: "b" }), id: 2 }]);
    assert.equal(matcher.blockingRule("https://x.test/b", "script")?.id, 2);
    assert.equal(matcher.blockingRule("https://x.test/c", "script"), null);
  });
});

describe("crawler session rules (bridge configure)", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
  const signatureInput = (expires) =>
    `sig1=("@authority" "signature-agent");created=${seconds("2026-11-18T00:00:00Z")};expires=${expires};keyid="k-SECRET-INPUT";tag="web-bot-auth"`;
  const shop = (domain, expires = seconds("2027-02-16T00:00:00Z")) => ({ domain, signatureInput: signatureInput(expires), signature: "sig1=:SECRETSIGNATURE==:" });
  const matcher = (config) => createMatcher(buildSessionRules(config, now));
  const headersFor = (config, url, type) =>
    matcher(config)
      .matchingRules(url, type)
      .flatMap((rule) => rule.action.requestHeaders.map((header) => header.header));

  test("the navigation header goes on top-level and iframe navigations only", () => {
    const config = { navigationHeader: "qa; run=abc", shopify: [] };
    assert.deepEqual(headersFor(config, "https://any.test/", "main_frame"), [NAVIGATION_HEADER]);
    assert.deepEqual(headersFor(config, "https://any.test/frame", "sub_frame"), [NAVIGATION_HEADER]);
    for (const type of ["script", "xmlhttprequest", "image", "ping", "stylesheet", "font"]) assert.deepEqual(headersFor(config, "https://any.test/x", type), []);
    assert.equal(buildSessionRules({ navigationHeader: null, shopify: [] }, now).length, 0);
  });

  test("Shopify signatures go to the exact domain on every request type and nowhere else", () => {
    const config = { navigationHeader: null, shopify: [shop("signed-store.example.com")] };
    const signed = ["Signature-Input", "Signature", "Signature-Agent"];
    for (const type of RESOURCE_TYPES) assert.deepEqual(headersFor(config, "https://signed-store.example.com/products/x.js", type), signed);
    assert.deepEqual(headersFor(config, "https://SIGNED-STORE.example.com/", "main_frame"), signed);
    for (const url of [
      "https://sub.signed-store.example.com/",
      "https://signed-store.example.com.evil.test/",
      "https://signed-store.example.com@evil.test/",
      "http://signed-store.example.com/",
      "https://cdn.shopify.com/s/files/1/x.png",
      "https://other.myshopify.com/",
    ]) {
      assert.deepEqual(headersFor(config, url, "xmlhttprequest"), [], url);
    }
    const [rule] = buildSessionRules(config, now);
    assert.equal(rule.action.requestHeaders.find((header) => header.header === "Signature-Agent").value, SHOPIFY_SIGNATURE_AGENT);
    assert.equal(SHOPIFY_SIGNATURE_AGENT, '"https://shopify.com"');
  });

  test("an expired signature is skipped, a live one kept", () => {
    const config = {
      navigationHeader: "qa",
      shopify: [shop("old.example.com", seconds("2026-11-01T00:00:00Z")), shop("new.example.com")],
    };
    const built = buildSessionRules(config, now);
    assert.equal(built.length, 2);
    assert.deepEqual(built[1].condition.requestDomains, ["new.example.com"]);
    assert.equal(signatureExpiresAt('sig1=();keyid="x;expires=1"'), null);
    assert.equal(signatureExpiresAt("sig1=();expires=1795000000"), 1795000000000);
  });

  test("bad input is refused without echoing a signature value", () => {
    const secretInput = "k-SECRET-INPUT";
    const secretSignature = "SECRETSIGNATURE";
    const refused = [
      { navigationHeader: "qa\r\nX-Evil: 1", shopify: [] },
      { navigationHeader: 1, shopify: [] },
      { shopify: [] },
      { navigationHeader: null },
      { navigationHeader: null, shopify: [{ ...shop("a.example.com"), signature: `${secretSignature}\n` }] },
      { navigationHeader: null, shopify: [{ ...shop("a.example.com"), signatureInput: `${secretInput}\r` }] },
      { navigationHeader: null, shopify: [{ ...shop("a.example.com"), signatureInput: `sig1=();expires=soon;keyid="${secretInput}"` }] },
      { navigationHeader: null, shopify: [shop("a.example.com/path")] },
      { navigationHeader: null, shopify: [shop("a.example.com:443")] },
      { navigationHeader: null, shopify: [shop("a.example.com"), shop("A.example.com")] },
      { navigationHeader: null, shopify: [{ ...shop("a.example.com"), extra: 1 }] },
      { navigationHeader: null, shopify: [{ ...shop("a.example.com"), signature: "x".repeat(5000) }] },
    ];
    for (const config of refused) {
      assert.throws(
        () => buildSessionRules(config, now),
        (error) => error instanceof Error && !error.message.includes("SECRET"),
        JSON.stringify(Object.keys(config)),
      );
    }
  });
});
