import assert from "node:assert/strict";
import { test } from "node:test";
const { linkRuleFor, siteProblem, isLinkRuleList } = await import("./linkRules.ts");

const rule = (site, extra = {}) => ({ id: site, site, app: null, profileId: "work", open: null, ...extra });
const match = (site, url, source = null) => linkRuleFor([rule(site)], url, source) !== null;

test("a bare host matches itself and www, but not other subdomains", () => {
  assert.ok(match("github.com", "https://github.com/acme/app"));
  assert.ok(match("github.com", "https://www.github.com/"));
  assert.ok(match("github.com", "http://github.com/"));
  assert.ok(!match("github.com", "https://gist.github.com/"));
  assert.ok(!match("github.com", "https://notgithub.com/"));
});

test("*. covers every subdomain, a path narrows a host, and a full pattern is used as written", () => {
  assert.ok(match("*.google.com", "https://docs.google.com/d/1"));
  assert.ok(match("*.google.com", "https://google.com/"));
  assert.ok(match("github.com/acme/*", "https://github.com/acme/app/pull/1"));
  assert.ok(!match("github.com/acme/*", "https://github.com/other/app"));
  assert.ok(match("https://*.atlassian.net/*", "https://team.atlassian.net/browse/X-1"));
  assert.ok(!match("https://*.atlassian.net/*", "http://team.atlassian.net/browse/X-1"));
});

test("sites that can't match say why", () => {
  assert.equal(siteProblem("github.com"), null);
  assert.match(siteProblem(""), /add a site/);
  assert.match(siteProblem("git hub.com"), /no spaces/);
  assert.ok(siteProblem("gi*thub.com"));
  assert.ok(siteProblem("mailto://x"));
});

test("a rule with an app only takes links from that app, by name or bundle ID, ignoring case", () => {
  const slack = [rule("github.com", { app: "slack" })];
  assert.ok(linkRuleFor(slack, "https://github.com/", { bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" }));
  assert.ok(linkRuleFor([rule("github.com", { app: "com.tinyspeck.slackmacgap" })], "https://github.com/", { bundleId: "com.tinyspeck.slackmacgap", appName: null }));
  assert.equal(linkRuleFor(slack, "https://github.com/", { bundleId: "com.apple.mail", appName: "Mail" }), null);
  assert.equal(linkRuleFor(slack, "https://github.com/", null), null);
});

test("the first matching rule wins, and rules the caller can't use are skipped", () => {
  const rules = [rule("github.com/acme/*", { id: "acme", profileId: "gone" }), rule("github.com", { id: "all" })];
  assert.equal(linkRuleFor(rules, "https://github.com/acme/x", null).id, "acme");
  assert.equal(linkRuleFor(rules, "https://github.com/acme/x", null, (r) => r.profileId !== "gone").id, "all");
});

test("saved rule lists are checked field by field", () => {
  assert.ok(isLinkRuleList([rule("github.com"), rule("x.com", { open: "littleArdia", app: "Mail" })]));
  assert.ok(!isLinkRuleList([{ ...rule("github.com"), open: "sideways" }]));
  assert.ok(!isLinkRuleList([{ site: "github.com" }]));
  assert.ok(!isLinkRuleList("github.com"));
});
