import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = read("../ios/page_script.js");
const worlds = read("../../../engine/ardiacore/src/ardia/core/ac_page_worlds.h");
const renderer = read("../../../engine/ardiacore/src/ardia/core/renderer/ac_content_renderer_client.cc");
const listed = (name) => {
  const body = worlds.match(new RegExp(`${name}\\[\\] = \\{([^}]*)\\}`))?.[1];
  assert.ok(body, `ac_page_worlds.h lists ${name}`);
  return new Set([...body.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
};
const split = script.indexOf("  if (!observes) return receive;\n");
const pageWorld = script.slice(0, split);
const ardiaWorld = script.slice(split);
const collect = (source, pattern) => new Set([...source.matchAll(pattern)].map((m) => m[1]));

test("the page script ends its page-world part before every observer", () => {
  assert.ok(split > 0, "page_script.js returns before its observers in the page's world");
  assert.match(script, /^\(function \(post, world\) \{\n/);
  assert.match(pageWorld, /const wraps = world !== "ardia";\n\s*const observes = world !== "page";\n/);
  for (const observer of ["const typedByUser = new WeakSet();", "let peekKey = null;", "const getterOf = (proto, name) =>", 'send("hello"', "let contextMenuAt = null;", "const parse = (css) =>", "const scrollDirection = () =>", '"dragstart"'])
    assert.ok(ardiaWorld.includes(observer), `${observer} runs in Ardia's world, not the page's`);
});

test("what the page's world sends is exactly what the renderer lets it post", () => {
  assert.deepEqual([...collect(pageWorld, /\bsend\("([A-Za-z]+)"/g)].sort(), [...listed("kPageWorldPosts")].sort());
});

test("what the page's world handles is exactly what the renderer calls it with", () => {
  assert.deepEqual([...collect(pageWorld, /\bhandlers\.([A-Za-z]+) =/g)].sort(), [...listed("kPageWorldCalls")].sort());
});

test("the observers wrap nothing of the page's", () => {
  assert.doesNotMatch(ardiaWorld, /\.prototype\.[A-Za-z]+ = |defineProperty\((?:window|navigator|[A-Za-z]+\.prototype|proto)/);
});

test("every page-world API wrapper runs only in the world that wraps", () => {
  for (const wrapper of ["HTMLMediaElement.prototype.play = asNative(", "installDisplayMedia();\n", "!installNotifications()", "isTop && window.isSecureContext && window.Navigator", "const NavigatorType = window.Navigator;", 'Object.getOwnPropertyDescriptor(window, "open")'])
    assert.ok(pageWorld.includes(wrapper), `${wrapper} is in the page's world`);
  assert.match(pageWorld, /if \(wraps\) installDisplayMedia\(\);/);
  assert.match(pageWorld, /if \(wraps\) HTMLMediaElement\.prototype\.play = asNative\(/);
  assert.match(pageWorld, /if \(wraps && proto\) \{/);
  assert.match(pageWorld, /if \(wraps && !installNotifications\(\)\)/);
  assert.match(pageWorld, /if \(wraps && isTop && window\.isSecureContext && window\.Navigator\) \{/);
  assert.match(pageWorld, /if \(wraps\) try \{\n {4}const NavigatorType = window\.Navigator;/);
  assert.match(pageWorld, /if \(wraps\) try \{\n {4}const baseURIOf = /);
});

test("the renderer runs the script once in the page's world and once in Ardia's own", () => {
  assert.match(renderer, /ExecuteScriptInIsolatedWorldAndReturnValue\(\n\s*ISOLATED_WORLD_ID_ARDIA_PAGE, PageScriptSource\(\)/);
  assert.match(renderer, /world == PageWorld::kPage \? "page" : "ardia"/);
  assert.match(renderer, /if \(!posted \|\| !PageWorldMayPost\(world, \*posted\)\) \{/);
  assert.match(renderer, /if \(alive && PageWorldReceives\(world, kind\)\) \{/);
  assert.match(renderer, /info\.content_security_policy =\n\s*blink::WebString::FromUtf8\(kArdiaPageWorldPolicy\);/);
  assert.match(read("../../../engine/patches/chromium-ardia-page-world.patch"), /^\+ {2}ISOLATED_WORLD_ID_ARDIA_PAGE,$/m);
});
