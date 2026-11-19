import { openWindow } from "../browser/actions";
import { useBrowser } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import { noteOpenInIncognito } from "../telemetry/incognitoCounts";
import type { ConsentToken } from "../telemetry/client";
import { closeWindowAnimated, isWindowClosing } from "../windows/closeAnimated";
import { isSmall, privateWindowProfile } from "../windows/small";
import { incognitoUrl, isWebPage, previewThemeInUrl, readRenderedTheme, THEME_PROBE, type RenderedTheme } from "./shopifyPreview";
import { webviews } from "./webviewHandles";

export const OPEN_IN_INCOGNITO_TITLE = "Open in Incognito";
export const THEME_PROBE_TIMEOUT_MS = 1000;

const store = () => useBrowser.getState();

export function canOpenInIncognito(tabId: string | undefined): boolean {
  const tab = tabId ? store().tabs[tabId] : undefined;
  return !!tab && isWebPage(tab.url) && !isIncognitoProfile(tab.profileId);
}

async function renderedTheme(tabId: string, timeoutMs: number): Promise<RenderedTheme | null> {
  const web = webviews.get(tabId);
  if (!web) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const answered = web.evaluate<unknown>(THEME_PROBE).then(readRenderedTheme, () => null);
  const theme = await Promise.race([answered, late]);
  clearTimeout(timer);
  return theme;
}

export async function openInIncognito(tabId: string, from: "tabMenu" | "littleArdia", consent?: ConsentToken | null, timeoutMs = THEME_PROBE_TIMEOUT_MS): Promise<string | null> {
  if (!canOpenInIncognito(tabId)) return null;
  const tab = store().tabs[tabId]!;
  const theme = previewThemeInUrl(tab.url) ? null : await renderedTheme(tabId, timeoutMs);
  const samePage = store().tabs[tabId]?.url === tab.url;
  const { url, preview } = incognitoUrl(tab.url, samePage ? theme : null);
  noteOpenInIncognito(preview, from, consent);
  const s = store();
  return openWindow({ kind: "private", url, profileId: privateWindowProfile(s, s.windows[tab.windowId]) });
}

export async function openLittleArdiaInIncognito(windowId: string, consent?: ConsentToken | null, timeoutMs = THEME_PROBE_TIMEOUT_MS) {
  const s = store();
  if (!isSmall(s, windowId) || isWindowClosing(windowId)) return;
  const tabId = activeTabId(s, windowId);
  if (!tabId || !(await openInIncognito(tabId, "littleArdia", consent, timeoutMs))) return;
  if (!store().windows[windowId] || isWindowClosing(windowId)) return;
  closeWindowAnimated(windowId, {
    then: () => useBrowser.setState((now) => ({ closedTabs: now.closedTabs.filter((c) => c.tabId !== tabId) })),
  });
}
