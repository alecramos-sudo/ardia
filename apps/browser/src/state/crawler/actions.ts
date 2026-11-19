import {
  getCrawlerState,
  onCrawlerChange,
  removeCrawlerShopifySignature,
  resetCrawlerProfile,
  setCrawlerHeader,
  setCrawlerProfileEnabled,
  setCrawlerShopifySignature,
  type CrawlerNotReadyReason,
  type CrawlerSignatureInput,
  type CrawlerState,
} from "../../platform/crawler";
import { useBrowser } from "../browser/store";
import { createProfile } from "../profiles/actions";
import { captureCrawlerNotReady } from "../telemetry/errors";
import { orWarn } from "../../lib/fallback";
import { crawlerEngineProfile, signatureDomain, useCrawler } from "./crawler";

function newlyNotReady(before: CrawlerState | null, after: CrawlerState): CrawlerNotReadyReason[] {
  return after.profiles.flatMap((p) => {
    if (p.ready || !p.reason) return [];
    const was = before?.profiles.find((b) => b.profileId === p.profileId);
    return was && !was.ready && was.reason === p.reason ? [] : [p.reason];
  });
}

export function applyCrawlerState(state: CrawlerState) {
  const before = useCrawler.getState().state;
  useCrawler.setState({ state });
  for (const reason of newlyNotReady(before, state)) captureCrawlerNotReady(reason);
}

export const refreshCrawler = () => getCrawlerState().then(applyCrawlerState).catch(orWarn(undefined));

let subscription: ReturnType<typeof onCrawlerChange> | null = null;

export function startCrawler() {
  if (subscription) return;
  subscription = onCrawlerChange(applyCrawlerState);
  void refreshCrawler();
}

async function thenRefresh<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } finally {
    await refreshCrawler();
  }
}

const engineOf = (profileId: string) => crawlerEngineProfile(useBrowser.getState(), profileId);

export const DEFAULT_CRAWLER_PROFILE_NAME = "Crawler";

export async function createCrawlerProfile(typed: string): Promise<{ profileId: string | null; problem: string | null }> {
  const name = typed.trim() || DEFAULT_CRAWLER_PROFILE_NAME;
  const profileId = createProfile({ name });
  const problem = await thenRefresh(setCrawlerProfileEnabled(engineOf(profileId), true, name)).catch((e: Error) => e.message);
  if (!problem) return { profileId, problem: null };
  useBrowser.getState().deleteProfile(profileId);
  return { profileId: null, problem };
}
export const setCrawlerProfile = (profileId: string, enabled: boolean) =>
  thenRefresh(setCrawlerProfileEnabled(engineOf(profileId), enabled, useBrowser.getState().profiles[profileId]?.name ?? null));
export const setCrawlerHeaderValue = (profileId: string, value: string | null) => thenRefresh(setCrawlerHeader(engineOf(profileId), value?.trim() || null));
export const addCrawlerShopifySignature = (profileId: string, signature: CrawlerSignatureInput) =>
  thenRefresh(setCrawlerShopifySignature(engineOf(profileId), { domain: signatureDomain(signature.domain), signatureInput: signature.signatureInput.trim(), signature: signature.signature.trim() }));
export const removeCrawlerSignature = (profileId: string, domain: string) => thenRefresh(removeCrawlerShopifySignature(engineOf(profileId), domain));
export const clearCrawlerData = (profileId: string) => thenRefresh(resetCrawlerProfile(engineOf(profileId)));
