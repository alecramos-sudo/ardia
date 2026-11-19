import assert from "node:assert/strict";
import { test } from "node:test";
const { CLIENT_SITES_PROVIDER, DEV_STORE_LABEL, idleClientSiteRows, readClientSiteGroups, typedClientSiteRows, withClientSiteRows } = await import("./clientSiteRows.ts");

const site = (name, domain, shop, dev = false) => ({ name, domain, shop, dev });

const DOC = {
  version: 1,
  groups: [
    {
      id: "north",
      name: "North",
      sites: [
        site("Zephyr Goods", "zephyr.example.com", "zephyr-goods.myshopify.com"),
        site("Acorn Dev", null, "acorn-dev.myshopify.com", true),
        site("Acorn Supply", "acorn.example", "acorn-supply.myshopify.com"),
      ],
    },
    {
      id: "south",
      name: "South",
      sites: [
        site("Birch Home", "birch.example.org", "birch-home.myshopify.com"),
        site("Cedar Lab", null, "cedar-lab.myshopify.com"),
        site("North Star Coffee", "northstar.example", "north-star.myshopify.com"),
      ],
    },
  ],
};

const groups = () => readClientSiteGroups(DOC);
const titles = (rows) => rows.map((r) => r.title);

test("client sites › a document reads into groups in order, live stores by name and dev stores last", () => {
  const read = groups();
  assert.deepEqual(
    read.map((g) => [g.id, g.name, titles(g.sites.map((s) => ({ title: s.name })))]),
    [
      ["north", "North", ["Acorn Supply", "Zephyr Goods", "Acorn Dev"]],
      ["south", "South", ["Birch Home", "Cedar Lab", "North Star Coffee"]],
    ],
  );
});

test("client sites › anything that isn't a document of groups reads as nothing", () => {
  for (const doc of [null, "x", [], { groups: "no" }, 3]) assert.equal(readClientSiteGroups(doc), null);
  assert.deepEqual(readClientSiteGroups({ groups: [] }), []);
});

test("client sites › bad rows and duplicate or empty groups are dropped", () => {
  const read = readClientSiteGroups({
    groups: [
      {
        id: "north",
        name: "North",
        sites: [
          site("Good", "good.example", "good.myshopify.com"),
          site("Bad Shop", "bad.example", "not a host"),
          site("Bad Domain", "javascript:alert(1)", "bad-domain.myshopify.com"),
          { name: "", shop: "blank.myshopify.com" },
          "row",
        ],
      },
      { id: "north", name: "Again", sites: [site("Dup", null, "dup.myshopify.com")] },
      { id: "Upper Case", name: "Bad Id", sites: [site("X", null, "x.myshopify.com")] },
      { id: "empty", name: "Empty", sites: [] },
    ],
  });
  assert.deepEqual(
    read.map((g) => [g.id, g.sites.map((s) => s.name)]),
    [["north", ["Good"]]],
  );
});

test("client sites › a row opens the primary domain, or the myshopify domain without one, and marks dev stores", () => {
  const rows = idleClientSiteRows(groups());
  const acorn = rows.find((r) => r.title === "Acorn Supply");
  assert.deepEqual(acorn, { kind: "provider", providerId: CLIENT_SITES_PROVIDER, provider: "North", title: "Acorn Supply", url: "https://acorn.example/", icon: null });
  const dev = rows.find((r) => r.title === "Acorn Dev");
  assert.equal(dev.url, "https://acorn-dev.myshopify.com/");
  assert.equal(dev.subtitle, DEV_STORE_LABEL);
  assert.equal(rows.find((r) => r.title === "Cedar Lab").url, "https://cedar-lab.myshopify.com/");
});

test("client sites › the empty field lists every group in order, eight rows at most", () => {
  const many = [{ id: "big", name: "Big", sites: Array.from({ length: 20 }, (_, i) => site(`Store ${String(i).padStart(2, "0")}`, null, `store-${i}.myshopify.com`)) }];
  assert.equal(idleClientSiteRows(readClientSiteGroups({ groups: many })).length, 8);
  assert.deepEqual(titles(idleClientSiteRows(groups())), ["Acorn Supply", "Zephyr Goods", "Acorn Dev", "Birch Home", "Cedar Lab", "North Star Coffee"]);
});

test("client sites › a short empty list shares its rows fairly between groups", () => {
  assert.deepEqual(titles(idleClientSiteRows(groups(), 4)), ["Acorn Supply", "Zephyr Goods", "Birch Home", "Cedar Lab"]);
  assert.deepEqual(titles(idleClientSiteRows(groups(), 5)), ["Acorn Supply", "Zephyr Goods", "Acorn Dev", "Birch Home", "Cedar Lab"]);
  const lopsided = [groups()[0], { id: "tiny", name: "Tiny", sites: [site("Solo", null, "solo.myshopify.com")] }];
  assert.deepEqual(titles(idleClientSiteRows(lopsided, 3)), ["Acorn Supply", "Zephyr Goods", "Solo"]);
});

test("client sites › a group's name narrows to that group, dev stores last", () => {
  assert.deepEqual(titles(typedClientSiteRows(groups(), "north")), ["Acorn Supply", "Zephyr Goods", "Acorn Dev"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "SOUTH ")), ["Birch Home", "Cedar Lab", "North Star Coffee"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "north acorn")), ["Acorn Supply", "Acorn Dev"]);
});

test("client sites › typing matches a name, the primary domain or the myshopify domain", () => {
  assert.deepEqual(titles(typedClientSiteRows(groups(), "birch")), ["Birch Home"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "zephyr.exam")), ["Zephyr Goods"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "cedar-lab.mysh")), ["Cedar Lab"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "https://www.birch.example.org/")), ["Birch Home"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "star")), ["North Star Coffee"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "nothing-like-it")), []);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "   ")), []);
});

test("client sites › a name that starts with the text ranks above one that only contains it", () => {
  assert.deepEqual(titles(typedClientSiteRows(groups(), "co")), ["North Star Coffee"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "a")).slice(0, 2), ["Acorn Supply", "Acorn Dev"]);
});

test("client sites › the word dev finds dev stores, alone or after a group's name", () => {
  assert.deepEqual(titles(typedClientSiteRows(groups(), "dev")), ["Acorn Dev"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "north dev")), ["Acorn Dev"]);
  assert.deepEqual(titles(typedClientSiteRows(groups(), "south dev")), []);
});

test("client sites › a partial group name matches that group's stores", () => {
  assert.deepEqual(titles(typedClientSiteRows(groups(), "sou")), ["Birch Home", "Cedar Lab", "North Star Coffee"]);
});

test("client sites › rows go after the first suggestion, and the rest fill the list up to its size", () => {
  const typed = { kind: "search", query: "acorn", url: "https://search.example/?q=acorn", engine: "Search" };
  const rest = Array.from({ length: 12 }, (_, i) => ({ kind: "search", query: `acorn ${i}`, url: `https://search.example/?q=acorn+${i}`, engine: "Search", suggested: true }));
  const rows = typedClientSiteRows(groups(), "acorn");
  const merged = withClientSiteRows([typed, ...rest], rows);
  assert.equal(merged[0], typed);
  assert.deepEqual(merged.slice(1, 3), rows);
  assert.equal(merged.length, 10);
  assert.deepEqual(merged.slice(3), rest.slice(0, 7));
  assert.equal(withClientSiteRows([typed], rows, 2).length, 3);
  assert.deepEqual(withClientSiteRows([typed, ...rest], []), [typed, ...rest]);
});

test("client sites › a suggestion for the same page as a row gives way to the row", () => {
  const rows = typedClientSiteRows(groups(), "acorn.example");
  const typedUrl = { kind: "page", url: "https://acorn.example/", title: "", favicon: null };
  const search = { kind: "search", query: "acorn.example", url: "https://search.example/?q=acorn.example", engine: "Search" };
  const merged = withClientSiteRows([typedUrl, search], rows);
  assert.deepEqual(merged, [...rows, search]);
});
