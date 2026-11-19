import type { ProviderSuggestion, Suggestion } from "@ardia/core";

export type ClientSite = { name: string; domain: string | null; shop: string; dev: boolean };
export type ClientSiteGroup = { id: string; name: string; sites: readonly ClientSite[] };

export const CLIENT_SITES_PROVIDER = "client-sites";
export const DEV_STORE_LABEL = "Dev store";
const DEV_WORD = "dev";
export const CLIENT_SITE_ROWS = { idle: 8, typed: 9, total: 10 } as const;

const NAME_MAX = 80;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GROUP_ID = /^[a-z0-9-]{1,32}$/;
const pageOf = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return trimmed && trimmed.length <= NAME_MAX ? trimmed : null;
};

const host = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return HOST.test(lower) ? lower : null;
};

function readSite(value: unknown): ClientSite | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = text(v.name);
  const shop = host(v.shop);
  if (!name || !shop) return null;
  const domain = v.domain === null || v.domain === undefined ? null : host(v.domain);
  if (domain === null && v.domain !== null && v.domain !== undefined) return null;
  return { name, domain, shop, dev: v.dev === true };
}

export function readClientSiteGroups(doc: unknown): ClientSiteGroup[] | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const groups = (doc as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return null;
  const out: ClientSiteGroup[] = [];
  const ids = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g !== "object" || Array.isArray(g)) continue;
    const r = g as Record<string, unknown>;
    const id = typeof r.id === "string" && GROUP_ID.test(r.id) ? r.id : null;
    const name = text(r.name);
    if (!id || !name || ids.has(id) || !Array.isArray(r.sites)) continue;
    ids.add(id);
    const sites = r.sites.map(readSite).filter((s): s is ClientSite => s !== null);
    if (sites.length) out.push({ id, name, sites: sortedSites(sites) });
  }
  return out;
}

const byName = (a: ClientSite, b: ClientSite) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

function sortedSites(sites: readonly ClientSite[]): ClientSite[] {
  return [...sites.filter((s) => !s.dev).sort(byName), ...sites.filter((s) => s.dev).sort(byName)];
}

export const clientSiteUrl = (site: ClientSite): string => `https://${site.domain ?? site.shop}/`;

export function clientSiteRow(group: Pick<ClientSiteGroup, "name">, site: ClientSite): ProviderSuggestion {
  return {
    kind: "provider",
    providerId: CLIENT_SITES_PROVIDER,
    provider: group.name,
    title: site.name,
    url: clientSiteUrl(site),
    icon: null,
    ...(site.dev ? { subtitle: DEV_STORE_LABEL } : {}),
  };
}

function shares(sizes: readonly number[], limit: number): number[] {
  const out = sizes.map(() => 0);
  let left = limit;
  while (left > 0) {
    let gave = false;
    sizes.forEach((size, i) => {
      if (left > 0 && out[i]! < size) {
        out[i]!++;
        left--;
        gave = true;
      }
    });
    if (!gave) break;
  }
  return out;
}

export function idleClientSiteRows(groups: readonly ClientSiteGroup[], limit: number = CLIENT_SITE_ROWS.idle): ProviderSuggestion[] {
  const take = shares(
    groups.map((g) => g.sites.length),
    limit,
  );
  return groups.flatMap((g, i) => g.sites.slice(0, take[i]).map((site) => clientSiteRow(g, site)));
}

const bareToken = (token: string) => token.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

const words = (value: string) => value.split(/[^a-z0-9]+/).filter(Boolean);

const domainWords = (domain: string) =>
  domain
    .split(".")
    .slice(0, -1)
    .filter((label) => label !== "myshopify")
    .flatMap((label) => label.split("-"));

function siteScore(site: ClientSite, group: ClientSiteGroup, tokens: readonly string[], withGroup: boolean): number {
  const name = site.name.toLowerCase();
  const nameWords = words(name);
  const domains = site.domain ? [site.domain, site.shop] : [site.shop];
  const groupWords = withGroup ? [group.id, ...words(group.name.toLowerCase())] : [];
  const inName = (t: string) => nameWords.some((w) => w.startsWith(t)) || name.startsWith(t);
  const inDomain = (t: string) => domains.some((d) => d.startsWith(t) || domainWords(d).some((w) => w.startsWith(t)));
  const inGroup = (t: string) => groupWords.some((w) => w.startsWith(t));
  const isDev = (t: string) => site.dev && DEV_WORD.startsWith(t);
  if (!tokens.every((t) => inName(t) || inDomain(t) || inGroup(t) || isDev(t))) return 0;
  const first = tokens[0]!;
  if (name.startsWith(first)) return 4;
  if (inName(first)) return 3;
  if (inDomain(first)) return 2;
  return 1;
}

const isGroupWord = (group: ClientSiteGroup, token: string) => token === group.id || token === group.name.toLowerCase();

export function typedClientSiteRows(groups: readonly ClientSiteGroup[], typed: string, limit: number = CLIENT_SITE_ROWS.typed): ProviderSuggestion[] {
  const tokens = typed.trim().toLowerCase().split(/\s+/).map(bareToken).filter(Boolean);
  if (!tokens.length) return [];
  const named = groups.find((g) => isGroupWord(g, tokens[0]!));
  const within = named ? [named] : groups;
  const rest = named ? tokens.slice(1) : tokens;
  if (!rest.length) return within.flatMap((g) => g.sites.map((site) => clientSiteRow(g, site))).slice(0, limit);
  const scored: { row: ProviderSuggestion; score: number; at: number }[] = [];
  let at = 0;
  for (const g of within) {
    for (const site of g.sites) {
      const score = siteScore(site, g, rest, !named);
      if (score > 0) scored.push({ row: clientSiteRow(g, site), score, at });
      at++;
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((x) => x.row);
}

export function withClientSiteRows(items: readonly Suggestion[], rows: readonly ProviderSuggestion[], total: number = CLIENT_SITE_ROWS.total): Suggestion[] {
  if (!rows.length) return [...items];
  const [first, ...rest] = items;
  const taken = new Set(rows.map((r) => pageOf(r.url)));
  const others = rest.filter((s) => s.kind === "search" || !("url" in s) || !taken.has(pageOf(s.url)));
  const lead = first && (first.kind === "search" || !("url" in first) || !taken.has(pageOf(first.url))) ? [first] : [];
  return [...lead, ...rows, ...others].slice(0, Math.max(total, lead.length + rows.length));
}
