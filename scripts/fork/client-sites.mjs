#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const USAGE = `usage: scripts/fork/client-sites.mjs [--data-dir <dir>] [--hub <mcp-hub checkout>] [--ref <git ref>] [--fetch] [--file <config.mjs>]

Writes client-sites.json, the client storefronts a private window's URL bar suggests, into an Ardia data directory.
It reads SHOPIFY_ORGS and SHOPIFY_STORES from the hub's src/config.mjs as literals, without running the hub's code.

  --data-dir  the app's data directory (default: the installed Ardia Fork's, ~/Library/Application Support/com.alecramos.ardiafork);
              for a test instance, its ARDIA_DATA_DIR
  --hub       the mcp-hub checkout (default: ~/Projects/mcp-hub)
  --ref       the git ref to read src/config.mjs from (default: origin/main)
  --fetch     git fetch the hub before reading
  --file      read this config file instead of the hub's git ref

It prints only counts. The file stays on this Mac: nothing syncs it, and Time Machine is told to skip it.`;

const DOC = "client-sites.json";
const VERSION = 1;
const FORK_DATA_DIR = join(homedir(), "Library/Application Support/com.alecramos.ardiafork");

function options(argv) {
  const out = { dataDir: FORK_DATA_DIR, hub: join(homedir(), "Projects/mcp-hub"), ref: "origin/main", fetch: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--data-dir") out.dataDir = resolve(value());
    else if (arg === "--hub") out.hub = resolve(value());
    else if (arg === "--ref") out.ref = value();
    else if (arg === "--file") out.file = resolve(value());
    else if (arg === "--fetch") out.fetch = true;
    else fail(`unknown option ${arg}\n\n${USAGE}`);
  }
  return out;
}

function fail(message) {
  console.error(`client-sites: ${message}`);
  process.exit(1);
}

function hubConfig(o) {
  if (o.file) return readFileSync(o.file, "utf8");
  if (o.fetch) execFileSync("git", ["-C", o.hub, "fetch", "--quiet"], { stdio: ["ignore", "ignore", "inherit"] });
  return execFileSync("git", ["-C", o.hub, "show", `${o.ref}:src/config.mjs`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function literalAfter(source, name) {
  const declared = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*`).exec(source);
  if (!declared) fail(`${name} isn't in the config`);
  const reader = literalReader(source, declared.index + declared[0].length);
  return reader.value();
}

function literalReader(src, start) {
  let at = start;
  const broken = (what) => fail(`${what} at offset ${at} of the config`);
  const skip = () => {
    for (;;) {
      while (at < src.length && /\s/.test(src[at])) at++;
      if (src.startsWith("//", at)) at = src.indexOf("\n", at) < 0 ? src.length : src.indexOf("\n", at);
      else if (src.startsWith("/*", at)) {
        const end = src.indexOf("*/", at + 2);
        if (end < 0) broken("an unclosed block comment");
        at = end + 2;
      } else return;
    }
  };
  const string = () => {
    const quote = src[at++];
    let out = "";
    while (at < src.length && src[at] !== quote) {
      if (quote === "`" && src.startsWith("${", at)) broken("a template with a placeholder");
      if (src[at] === "\\") {
        const next = src[at + 1];
        const simple = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`" }[next];
        if (simple === undefined) broken("an escape this reader doesn't take");
        out += simple;
        at += 2;
      } else out += src[at++];
    }
    if (src[at] !== quote) broken("an unclosed string");
    at++;
    return out;
  };
  const word = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(at, at + 64));
    if (!m) broken("an unexpected character");
    at += m[0].length;
    return m[0];
  };
  const value = () => {
    skip();
    const c = src[at];
    if (c === "[") {
      at++;
      const list = [];
      for (;;) {
        skip();
        if (src[at] === "]") return at++, list;
        list.push(value());
        skip();
        if (src[at] === ",") at++;
        else if (src[at] !== "]") broken("a list that isn't closed");
      }
    }
    if (c === "{") {
      at++;
      const object = {};
      for (;;) {
        skip();
        if (src[at] === "}") return at++, object;
        const key = src[at] === '"' || src[at] === "'" ? string() : word();
        skip();
        if (src[at] !== ":") broken("a key without a value");
        at++;
        object[key] = value();
        skip();
        if (src[at] === ",") at++;
        else if (src[at] !== "}") broken("an object that isn't closed");
      }
    }
    if (c === '"' || c === "'" || c === "`") return string();
    const number = /^-?\d+(?:\.\d+)?/.exec(src.slice(at, at + 32));
    if (number) return (at += number[0].length), Number(number[0]);
    const w = word();
    if (w === "null") return null;
    if (w === "true") return true;
    if (w === "false") return false;
    broken("a name where a literal belongs");
  };
  return { value };
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function document(orgs, stores) {
  if (!orgs || typeof orgs !== "object" || Array.isArray(orgs)) fail("SHOPIFY_ORGS isn't an object");
  if (!Array.isArray(stores)) fail("SHOPIFY_STORES isn't a list");
  const groups = Object.entries(orgs).map(([id, org]) => ({ id, name: typeof org?.short === "string" && org.short ? org.short : id, sites: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  let skipped = 0;
  for (const row of stores) {
    const [, title, shop, site, org, kind] = Array.isArray(row) ? row : [];
    const group = byId.get(org);
    const domain = site === null || site === undefined ? null : String(site).toLowerCase();
    if (!group || typeof title !== "string" || !title.trim() || typeof shop !== "string" || !HOST.test(shop.toLowerCase()) || (domain !== null && !HOST.test(domain))) {
      skipped++;
      continue;
    }
    group.sites.push({ name: title.trim(), domain, shop: shop.toLowerCase(), dev: kind === "dev" });
  }
  return { doc: { groups: groups.filter((g) => g.sites.length) }, skipped };
}

function write(dataDir, doc) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DOC);
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify({ ...doc, version: VERSION }, null, 2)}\n`, { mode: 0o600 });
  renameSync(staged, path);
  chmodSync(path, 0o600);
  if (!existsSync("/usr/bin/tmutil")) return false;
  return spawnSync("/usr/bin/tmutil", ["addexclusion", path], { stdio: "ignore" }).status === 0;
}

const o = options(process.argv.slice(2));
const source = hubConfig(o);
const { doc, skipped } = document(literalAfter(source, "SHOPIFY_ORGS"), literalAfter(source, "SHOPIFY_STORES"));
const sites = doc.groups.reduce((n, g) => n + g.sites.length, 0);
const dev = doc.groups.reduce((n, g) => n + g.sites.filter((s) => s.dev).length, 0);
if (!sites) fail("the config lists no client sites; nothing written");
const excluded = write(o.dataDir, doc);
console.log(`client-sites: ${sites} sites in ${doc.groups.length} groups (${dev} dev stores, ${skipped} rows skipped)${excluded ? "" : "; Time Machine exclusion not set"}`);
