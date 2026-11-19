import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = read("../ios/page_script.js");
const ubo = read("../scripts/ubo.sh");
const menu = read("../../../engine/ardiacore/src/ardia/core/ac_context_menu.mm");
const contextMenu = read("../ios/ArdiaWebView+ContextMenu.mm");
const messages = read("../ios/ArdiaWebView+PageMessages.mm");
const extensions = read("../../../engine/ardiacore/src/ardia/core/ac_bundled_extensions.h");
const ardiaWorld = script.slice(script.indexOf("  if (!observes) return receive;\n"));

test("no DOM event a page can dispatch reaches the element picker", () => {
  assert.doesNotMatch(script, /ardia-hide-element/);
  assert.doesNotMatch(ubo, /dispatchEvent|ardia-hide-element-in-frame|executeScript/);
  assert.match(ubo, /"    if \( details\.menuItemId === 'ardia-hideElement' \) \{ return; \}\\n"/);
});

test("the engine takes the click on uBlock Origin's Hide Element item itself, and uBlock never sees it", () => {
  assert.match(extensions, /kBundledContentBlockerId\[\] =\s*"fajbdaomknpkicfjcpipdmcpoamdmilh";/);
  assert.match(extensions, /kBundledHideElementMenuItem\[\] = "ardia-hideElement";/);
  assert.ok(ubo.includes(`id: 'ardia-hideElement',`), "ubo.sh's menu item id is the one the engine looks for");
  const execute = menu.slice(menu.indexOf("  void ExecuteCommand(int command_id, int event_flags) override {"));
  assert.match(execute, /^ {2}void ExecuteCommand\(int command_id, int event_flags\) override \{\n {4}if \(IsHideElementItem\(command_id\)\) \{\n {6}HideElement\(\);\n {6}return;\n {4}\}/);
  assert.match(menu, /item->second\.extension_key\.extension_id == kBundledContentBlockerId &&\s*item->second\.string_uid == kBundledHideElementMenuItem;/);
  assert.match(menu, /hideElementFromContextMenuInMainFrame:frame->IsInPrimaryMainFrame\(\)/);
});

test("the app asks the main frame's Ardia-world script for the point only after that click, and takes one answer", () => {
  assert.match(contextMenu, /_requests\.hideElementAsked = YES;\n\s*\[self callFrame:@"" kind:@"hideElement" json:@"\{\}"\];/);
  assert.match(messages, /\[kind isEqualToString:@"hideElement"\] && main && dict && _requests\.hideElementAsked\) \{\n\s*_requests\.hideElementAsked = NO;/);
  assert.match(messages, /if \(main\) _requests\.hideElementAsked = NO;/);
});

test("the right-click point is kept and answered in Ardia's world, from trusted input only", () => {
  assert.ok(ardiaWorld.includes("handlers.hideElement = () => {"), "the hideElement handler runs in Ardia's world");
  assert.match(ardiaWorld, /"contextmenu",\n\s*\(e\) => \{\n\s*if \(e\.isTrusted\) contextMenuAt = /);
  assert.match(ardiaWorld, /send\("hideElement", fresh \? \{ x: asked\.x, y: asked\.y \} : \{ x: -1, y: -1 \}\);/);
});
