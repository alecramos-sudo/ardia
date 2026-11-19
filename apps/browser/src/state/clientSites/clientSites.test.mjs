import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { readClientSites, forgetClientSitesLog, CLIENT_SITES_DOC } = await import("./clientSites.ts");

const DOC = JSON.stringify({
  groups: [{ id: "north", name: "North", sites: [{ name: "Acorn Supply", domain: "acorn.example", shop: "acorn-supply.myshopify.com", dev: false }] }],
  version: 1,
});

function watchConsole(run) {
  const seen = { log: [], warn: [] };
  const real = { log: console.log, warn: console.warn };
  console.log = (...args) => seen.log.push(args.join(" "));
  console.warn = (...args) => seen.warn.push(args.join(" "));
  try {
    run();
  } finally {
    Object.assign(console, real);
  }
  return seen;
}

test("client sites › the document in the data folder reads into groups", () => {
  forgetClientSitesLog();
  const asked = [];
  const groups = readClientSites((name) => (asked.push(name), DOC));
  assert.deepEqual(asked, [CLIENT_SITES_DOC]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.sites.map((s) => s.name)]),
    [["North", ["Acorn Supply"]]],
  );
});

test("client sites › a missing document lists nothing and logs once", () => {
  forgetClientSitesLog();
  const seen = watchConsole(() => {
    assert.deepEqual(readClientSites(() => null), []);
    assert.deepEqual(readClientSites(() => null), []);
  });
  assert.equal(seen.log.length, 1);
  assert.equal(seen.warn.length, 0);
});

test("client sites › an unreadable or newer document lists nothing and warns once, naming no site", () => {
  for (const bad of ["{not json", JSON.stringify({ groups: "x", version: 1 }), JSON.stringify({ groups: [], version: 99 }), "[]"]) {
    forgetClientSitesLog();
    const seen = watchConsole(() => {
      assert.deepEqual(readClientSites(() => bad), []);
      assert.deepEqual(readClientSites(() => bad), []);
    });
    assert.equal(seen.warn.length, 1);
    assert.doesNotMatch(seen.warn[0], /acorn|north|example/i);
  }
});

test("client sites › a good read after a bad one logs again the next time it breaks", () => {
  forgetClientSitesLog();
  const seen = watchConsole(() => {
    readClientSites(() => "{bad");
    readClientSites(() => DOC);
    readClientSites(() => "{bad");
  });
  assert.equal(seen.warn.length, 2);
});
