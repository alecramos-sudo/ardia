export type CrawlerReason = "selftest_failed" | "configure_failed" | "timeout" | "refused_not_scratch" | "other";

export type CrawlerSource = "instance" | "profile";

export type CrawlerShopifySignature = { domain: string; expires: string | null; sent: boolean; detail?: string | null };

export type CrawlerProfile = {
  profileId: string;
  name: string;
  source: CrawlerSource;
  ready: boolean;
  reason: CrawlerReason | null;
  detail: string | null;
  readySince: string | null;
  navigationHeader: boolean;
  shopify: CrawlerShopifySignature[];
  blocked: Record<string, number>;
};

export type CrawlerState = {
  instanceMode: boolean;
  rulesVersion: string;
  profiles: CrawlerProfile[];
};

export type CrawlerProblem = string | null;
