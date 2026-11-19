import assert from "node:assert/strict";
import { test } from "node:test";
const { incognitoUrl, previewThemeInUrl, readRenderedTheme, withPreviewTheme, isWebPage, THEME_PROBE } = await import("./shopifyPreview.ts");

const SHOP = "https://shop.example.com/collections/gifts";

test("Shopify preview › a URL that names its preview theme opens as it is, query and fragment kept", () => {
  const url = `${SHOP}?sort_by=price&preview_theme_id=111222333#top`;
  assert.deepEqual(incognitoUrl(url, null), { url, preview: "url" });
  assert.deepEqual(incognitoUrl(url, { id: "999", role: "unpublished" }), { url, preview: "url" });
  assert.equal(previewThemeInUrl(url), "111222333");
});

test("Shopify preview › a page showing an unpublished theme without the param gets it added, other params kept", () => {
  assert.deepEqual(incognitoUrl(SHOP, { id: "190000000001", role: "unpublished" }), { url: `${SHOP}?preview_theme_id=190000000001`, preview: "theme" });
  assert.deepEqual(incognitoUrl(`${SHOP}?page=2&sort_by=price#grid`, { id: "42", role: "development" }), {
    url: `${SHOP}?page=2&sort_by=price&preview_theme_id=42#grid`,
    preview: "theme",
  });
});

test("Shopify preview › the live theme, no theme or a page that isn't on the web opens the plain URL", () => {
  assert.deepEqual(incognitoUrl(`${SHOP}?page=2`, { id: "42", role: "main" }), { url: `${SHOP}?page=2`, preview: "none" });
  assert.deepEqual(incognitoUrl(SHOP, null), { url: SHOP, preview: "none" });
  assert.deepEqual(incognitoUrl("ardia://newtab", { id: "42", role: "unpublished" }), { url: "ardia://newtab", preview: "none" });
});

test("Shopify preview › an empty preview param counts as none, and adding the theme replaces it", () => {
  const url = `${SHOP}?preview_theme_id=&page=2`;
  assert.equal(previewThemeInUrl(url), null);
  assert.equal(withPreviewTheme(url, "7"), `${SHOP}?page=2&preview_theme_id=7`);
  assert.equal(previewThemeInUrl(`${SHOP}?xpreview_theme_id=5`), null);
});

test("Shopify preview › only a numeric theme id with a role is read from the page", () => {
  assert.deepEqual(readRenderedTheme({ id: 190737055972, role: "unpublished" }), { id: "190737055972", role: "unpublished" });
  assert.deepEqual(readRenderedTheme({ id: "12", role: "main" }), { id: "12", role: "main" });
  for (const bad of [null, undefined, "x", [], { id: "12" }, { id: "1&evil=1", role: "unpublished" }, { id: 1.5, role: "unpublished" }, { id: "12", role: "" }, { id: "undefined", role: "undefined" }])
    assert.equal(readRenderedTheme(bad), null);
});

test("Shopify preview › only http and https pages count as web pages", () => {
  assert.equal(isWebPage("https://shop.example.com/"), true);
  assert.equal(isWebPage("http://localhost:3000/x"), true);
  for (const url of ["", "ardia://settings", "file:///tmp/a.html", "about:blank", "javascript:alert(1)"]) assert.equal(isWebPage(url), false);
});

function probePage(scripts) {
  const posts = [];
  const document = { querySelectorAll: (selector) => (selector === "script:not([src])" ? scripts.map((textContent) => ({ textContent })) : []) };
  new Function("post", "document", "window", `'use strict';\n${THEME_PROBE}`)((kind, json) => posts.push([kind, json]), document, {});
  return posts;
}

test("Shopify preview › the probe reads the theme Shopify writes into the page's own script, not a page global", () => {
  const header = [
    "var Shopify = Shopify || {};",
    'Shopify.shop = "shop.myshopify.com";',
    'Shopify.theme = {"name":"Dawn; copy {1}","id":190737055972,"schema_name":"Dawn","theme_store_id":887,"role":"unpublished"};',
    'Shopify.theme.handle = "null";',
  ].join("\n");
  assert.deepEqual(probePage(["window.dataLayer = [];", header]), [["result", JSON.stringify({ id: "190737055972", role: "unpublished" })]]);
  assert.deepEqual(readRenderedTheme(JSON.parse(probePage([header])[0][1])), { id: "190737055972", role: "unpublished" });
  for (const scripts of [[], ["var Shopify = {};"], ['Shopify.theme = {"id": 5, "role":'], ['Shopify.theme.handle = "null";']]) assert.deepEqual(probePage(scripts), [["result", "null"]]);
});
