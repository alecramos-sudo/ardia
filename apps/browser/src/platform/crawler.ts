import { call, on, type CrawlerProfile, type CrawlerReason, type CrawlerShopifySignature, type CrawlerState } from "@ardia/ardiacore";

export type { CrawlerProfile, CrawlerShopifySignature, CrawlerState };

export type CrawlerNotReadyReason = CrawlerReason;

export type CrawlerSignatureInput = { domain: string; signatureInput: string; signature: string };

export const getCrawlerState = () => call("crawler.state", {});
export const setCrawlerProfileEnabled = (profileId: string, enabled: boolean, name: string | null) =>
  call("crawler.setProfile", name === null ? { profileId, enabled } : { profileId, enabled, name });
export const setCrawlerHeader = (profileId: string, value: string | null) => call("crawler.setHeader", { profileId, value });
export const setCrawlerShopifySignature = (profileId: string, signature: CrawlerSignatureInput) => call("crawler.setShopifySignature", { profileId, ...signature });
export const removeCrawlerShopifySignature = (profileId: string, domain: string) => call("crawler.removeShopifySignature", { profileId, domain });
export const resetCrawlerProfile = (profileId: string) => call("crawler.reset", { profileId });
export const onCrawlerChange = (listener: (state: CrawlerState) => void) => on("crawler.changed", listener);
