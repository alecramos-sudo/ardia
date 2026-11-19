import { hostOf } from "@ardia/core";
import { isWebPageUrl } from "../../lib/url";
import { useBrowser } from "../browser/store";
import { siteHost, type AirTrafficRule, type OpenAs } from "../airTraffic/rules";
import { currentAirTraffic, removeAirTrafficRule, targetUsableNow, tryAddAirTrafficRule, type RuleDraft } from "../airTraffic/store";
import { noteLinkSent } from "./linkHabits";

const ALWAYS_OPEN_AS: OpenAs = "littleArdia";
const LEARNED_OPEN_AS: OpenAs = "tab";

export const siteOfUrl = (url: string | undefined): string | null => (url && isWebPageUrl(url) ? siteHost(hostOf(url)) : null);

const siteRule = (site: string, profileId: string, open: OpenAs): RuleDraft => ({ enabled: true, from: null, when: { kind: "site", host: site }, profileId, open });

const plainSiteRules = (site: string): AirTrafficRule[] =>
  currentAirTraffic().rules.filter((r) => r.enabled && !r.from && !r.groupKey && r.when.kind === "site" && r.when.host === site);

const opensAs = (rule: AirTrafficRule, profileId: string, open: OpenAs) => rule.profileId === profileId && rule.open === open;

function replaceSiteRules(site: string, profileId: string, open: OpenAs): { id: string; replaced: AirTrafficRule[] } | null {
  const replaced = plainSiteRules(site);
  const added = tryAddAirTrafficRule(siteRule(site, profileId, open));
  if (!("id" in added)) return null;
  for (const rule of replaced) removeAirTrafficRule(rule.id);
  return { id: added.id, replaced };
}

export const alwaysOpenRule = (site: string, profileId: string): AirTrafficRule | undefined => plainSiteRules(site).find((r) => opensAs(r, profileId, ALWAYS_OPEN_AS));

export function toggleAlwaysOpen(site: string, profileId: string) {
  const existing = alwaysOpenRule(site, profileId);
  if (existing) return removeAirTrafficRule(existing.id);
  if (targetUsableNow(profileId, null)) replaceSiteRules(site, profileId, ALWAYS_OPEN_AS);
}

export type LearnedLinkRoute = { site: string; profileId: string; undo(): void };

export function learnLinkRoute(url: string | undefined, profileId: string): LearnedLinkRoute | null {
  const site = siteOfUrl(url);
  if (!site || !useBrowser.getState().settings.learnLinkRoutes || !targetUsableNow(profileId, null)) return null;
  if (plainSiteRules(site).some((r) => opensAs(r, profileId, LEARNED_OPEN_AS))) return null;
  if (!noteLinkSent(site, profileId)) return null;
  const learned = replaceSiteRules(site, profileId, LEARNED_OPEN_AS);
  if (!learned) return null;
  const undo = () => {
    removeAirTrafficRule(learned.id);
    for (const { id, ...draft } of learned.replaced) tryAddAirTrafficRule(draft, id);
  };
  return { site, profileId, undo };
}
