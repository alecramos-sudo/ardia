import { create } from "zustand";
import type { CrawlerNotReadyReason, CrawlerProfile, CrawlerShopifySignature, CrawlerState } from "../../platform/crawler";
import type { BrowserState } from "../browser/store";
import { useBrowser } from "../browser/store";
import { engineProfile, incognitoOriginal, isIncognitoProfile } from "../browser/model";
import { UI_LOCALE } from "../../lib/uiLocale";

export type { CrawlerNotReadyReason, CrawlerProfile, CrawlerShopifySignature, CrawlerSignatureInput, CrawlerState } from "../../platform/crawler";

export const useCrawler = create<{ state: CrawlerState | null }>()(() => ({ state: null }));

type ProfilesOf = Pick<BrowserState, "profiles">;

export const crawlerEngineProfile = (s: ProfilesOf, profileId: string) => engineProfile(s, profileId);

export const crawlerProfileIn = (crawler: CrawlerState | null, s: ProfilesOf, profileId: string): CrawlerProfile | undefined => {
  const engine = crawlerEngineProfile(s, profileId);
  return crawler?.profiles.find((p) => p.profileId === engine);
};

export const crawlerBaseProfile = (profileId: string) => (isIncognitoProfile(profileId) ? incognitoOriginal(profileId) : profileId);

export const isCrawlerEngineIn = (crawler: CrawlerState | null, engine: string) => !!crawler && (crawler.instanceMode || crawler.profiles.some((p) => p.profileId === engine));

export const isCrawlerProfileIn = (crawler: CrawlerState | null, s: ProfilesOf, profileId: string) => isCrawlerEngineIn(crawler, crawlerEngineProfile(s, crawlerBaseProfile(profileId)));

export const isCrawlerReadyIn = (crawler: CrawlerState | null, s: ProfilesOf, profileId: string) => !!crawlerProfileIn(crawler, s, profileId)?.ready;

export const isCrawlerProfile = (profileId: string) => isCrawlerProfileIn(useCrawler.getState().state, useBrowser.getState(), profileId);
export const isCrawlerReady = (profileId: string) => isCrawlerReadyIn(useCrawler.getState().state, useBrowser.getState(), profileId);
export const currentCrawlerProfile = (profileId: string) => crawlerProfileIn(useCrawler.getState().state, useBrowser.getState(), profileId);
export const crawlerProfileCount = () => useCrawler.getState().state?.profiles.length ?? 0;

const NOT_READY_TEXT: Record<CrawlerNotReadyReason, string> = {
  selftest_failed: "Its tracker blocking didn't pass the self-test.",
  configure_failed: "Its request labels couldn't be set.",
  timeout: "Its tracker blocking didn't load in time.",
  refused_not_scratch: "Crawler mode needs a scratch data folder.",
  other: "Something stopped it from getting ready.",
};

export const crawlerNotReadyText = (reason: CrawlerNotReadyReason | null) => (reason ? NOT_READY_TEXT[reason] : "Getting ready…");

export const DEFAULT_CRAWLER_HEADER = "qa; run=<run id>";

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(UI_LOCALE, { year: "numeric", month: "short", day: "numeric" });

export function crawlerSignatureStatus(signature: CrawlerShopifySignature, now = Date.now()): string {
  const expires = signature.expires ? Date.parse(signature.expires) : NaN;
  if ((Number.isFinite(expires) && expires <= now) || signature.detail === "expired") return "Expired, not sent";
  if (!signature.sent) return signature.detail ? `Not sent: ${signature.detail}` : "Not sent";
  return Number.isFinite(expires) ? `Expires ${shortDate(expires)}` : "Sent";
}
export const signatureDomain = (typed: string) => typed.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
