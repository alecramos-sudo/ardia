import type { BrowserState } from "../browser/store";
import type { NewTabOptions } from "../tabs/tabs";
import { showToast } from "../app/toasts";
import { noteCrawlerTabRefused } from "../telemetry/crawlerTabsRefused";
import { isIncognitoProfile } from "../browser/model";
import { crawlerNotReadyText, crawlerProfileIn, isCrawlerProfileIn, useCrawler } from "./crawler";

export const CRAWLER_NOT_READY_TOAST = "crawlerNotReady";
export const CRAWLER_NETLOG_TOAST = "crawlerNetLog";

const NETLOG_SCHEMES = new Set(["chrome", "chrome-untrusted", "ardia", "about"]);

export function isNetLogPage(url: string | undefined | null): boolean {
  if (!url) return false;
  let rest = url.trim();
  while (/^view-source:/i.test(rest)) rest = rest.slice("view-source:".length).trim();
  const colon = rest.indexOf(":");
  if (colon < 0 || !NETLOG_SCHEMES.has(rest.slice(0, colon).toLowerCase())) return false;
  const host = rest.slice(colon + 1).replace(/^[/\\]+/, "").split(/[/?#\\:]/)[0] ?? "";
  let name = host;
  try {
    name = decodeURIComponent(host);
  } catch {
    name = host;
  }
  name = name.toLowerCase().replace(/\.+$/, "");
  return name === "net-export" || name === "net-internals";
}

export const crawlerModeOn = () => {
  const state = useCrawler.getState().state;
  return !!state && (state.instanceMode || state.profiles.length > 0);
};

export function crawlerRefusesUrl(windowId: string | null, url: string | undefined | null): boolean {
  if (!isNetLogPage(url) || !crawlerModeOn()) return false;
  if (windowId) showToast(windowId, "NetLog pages are off", "Crawler profiles are on, and a NetLog would record their request labels and signatures.", { icon: "exclamationmark.triangle", key: CRAWLER_NETLOG_TOAST });
  return true;
}

export function crawlerRefusesNewTab(s: BrowserState, windowId: string, options: NewTabOptions | undefined): boolean {
  if (options?.adoptId) return false;
  const profileId = options?.profileId ?? s.windows[windowId]?.profileId;
  const crawler = useCrawler.getState().state;
  if (!profileId || !isCrawlerProfileIn(crawler, s, profileId)) return false;
  if (isIncognitoProfile(profileId) || s.windows[windowId]?.kind === "private") {
    noteCrawlerTabRefused();
    showToast(windowId, "No private windows in a crawler profile", "Its tracker blocking isn't proven in private windows, so they don't open.", { icon: "exclamationmark.triangle", key: CRAWLER_NOT_READY_TOAST });
    return true;
  }
  const profile = crawlerProfileIn(crawler, s, profileId);
  if (profile?.ready) return false;
  noteCrawlerTabRefused();
  showToast(windowId, "Crawler profile isn't ready", `${crawlerNotReadyText(profile?.reason ?? null)} Tabs open in it once it is.`, { icon: "exclamationmark.triangle", key: CRAWLER_NOT_READY_TOAST });
  return true;
}
