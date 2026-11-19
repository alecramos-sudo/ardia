import assert from "node:assert/strict";
import { test } from "node:test";
const { incognitoUrl, previewThemeInUrl, readRenderedTheme, withPreviewTheme, isWebPage } = await import("./shopifyPreview.ts");

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
