import { hostOf } from "@ardia/core";
import { isWebPageUrl } from "../../lib/url";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile, newId } from "../browser/model";
import type { LinkRouteChoice } from "../littleArdia/linkGate";
import { linkRuleFor, siteProblem, type LinkOpen, type LinkRule, type LinkSourceApp } from "./linkRules";

export type LinkRuleInput = { site: string; app: string; profileId: string; open: LinkOpen | null };

const store = () => useBrowser.getState();
const rules = () => store().settings.linkRules;
const save = (next: LinkRule[]) => store().updateSettings({ linkRules: next });

const usableProfile = (profileId: string) => !!store().profiles[profileId] && !isIncognitoProfile(profileId);

/** The route of the first rule that matches a link from another app and names a profile that still exists. */
export function ruledLinkRoute(url: string, source: LinkSourceApp): LinkRouteChoice | null {
  const rule = linkRuleFor(rules(), url, source, (r) => usableProfile(r.profileId));
  return rule ? { profileId: rule.profileId, open: rule.open, windowId: null } : null;
}

function checked(input: LinkRuleInput): Omit<LinkRule, "id"> | string {
  const site = input.site.trim();
  const problem = siteProblem(site);
  if (problem) return problem;
  if (!usableProfile(input.profileId)) return "choose a profile";
  return { site, app: input.app.trim() || null, profileId: input.profileId, open: input.open };
}

export function addLinkRule(input: LinkRuleInput): string | null {
  const rule = checked(input);
  if (typeof rule === "string") return rule;
  save([...rules(), { id: newId("link"), ...rule }]);
  return null;
}

export function updateLinkRule(id: string, input: LinkRuleInput): string | null {
  const rule = checked(input);
  if (typeof rule === "string") return rule;
  save(rules().map((r) => (r.id === id ? { id, ...rule } : r)));
  return null;
}

export const removeLinkRule = (id: string) => save(rules().filter((r) => r.id !== id));

export function moveLinkRule(id: string, delta: -1 | 1) {
  const list = [...rules()];
  const from = list.findIndex((r) => r.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to]!, list[from]!];
  save(list);
}

/** The site an "Always open" rule for this page would name: its host without www, or null for pages that aren't websites. */
export const siteOfUrl = (url: string | undefined): string | null => (url && isWebPageUrl(url) ? hostOf(url) || null : null);

/** The plain rule that sends this site to this profile, as "Always open" makes it. */
export const alwaysOpenRule = (site: string, profileId: string): LinkRule | undefined =>
  rules().find((r) => r.site === site && r.profileId === profileId && !r.app && r.open === null);

/** Turns "Always open <site> in <profile>" on or off. On replaces any other plain rule for the same site. */
export function toggleAlwaysOpen(site: string, profileId: string) {
  const existing = alwaysOpenRule(site, profileId);
  if (existing) return removeLinkRule(existing.id);
  const others = rules().filter((r) => !(r.site === site && !r.app));
  save([...others, { id: newId("link"), site, app: null, profileId, open: null }]);
}
