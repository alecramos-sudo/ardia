import { useBrowser } from "../browser/store";
import { sharingProfiles } from "../profiles/profiles";
import { crawlerBaseProfile, crawlerEngineProfile, isCrawlerEngineIn, useCrawler, type CrawlerProfile } from "./crawler";

export function useIsCrawlerProfile(profileId: string): boolean {
  const engine = useBrowser((s) => crawlerEngineProfile(s, crawlerBaseProfile(profileId)));
  return useCrawler((c) => isCrawlerEngineIn(c.state, engine));
}

export function useCrawlerProfile(profileId: string): CrawlerProfile | undefined {
  const engine = useBrowser((s) => crawlerEngineProfile(s, profileId));
  return useCrawler((c) => c.state?.profiles.find((p) => p.profileId === engine));
}

export const useCrawlerInstanceMode = () => useCrawler((c) => !!c.state?.instanceMode);

export const useSharesProfileData = (profileId: string) => useBrowser((s) => sharingProfiles(s, profileId).length > 0);

export const useIsOriginalProfile = (profileId: string) => useBrowser((s) => crawlerEngineProfile(s, profileId) === "");
