import { orWarn } from "../../lib/fallback";
import { fitWindowToPage, onDeviceEmulationEnded, setTabWindowFrame, startDeviceEmulation, stopDeviceEmulation, type DeviceModeEndReason, type DeviceModeFailure } from "../../platform/deviceMode";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isSmall } from "../windows/small";
import { isWindowClosing } from "../windows/closeAnimated";
import { withLivePage } from "../tabs/livePage";
import { showToast } from "../app/toasts";
import { noteDeviceMode } from "../telemetry/usage";
import { IPHONE, emulatesUrl, iphonePreset } from "./preset";
import { begin, end, endCause, fit, turnOn, windowEmulating, type DeviceModeState, type EndCause, type Frame } from "./session";
import { useDeviceMode } from "./store";

const modes = () => useDeviceMode.getState();
const apply = (next: DeviceModeState) => useDeviceMode.setState(next, true);
const browser = () => useBrowser.getState();

const FAILURE_MESSAGES: Record<DeviceModeFailure, string> = {
  notHttp: "iPhone mode works on http and https pages.",
  noTarget: "This page couldn't be shown as an iPhone.",
  attachRefused: "This page couldn't be shown as an iPhone.",
  timeout: "This page took too long to switch to iPhone.",
  noExtension: "iPhone mode isn't available in this build.",
};

const RELOADS_AFTER: ReadonlySet<DeviceModeEndReason> = new Set(["pageGone", "canceled", "failed"]);

const emulating = (windowId: string, tabId: string) => modes().sessions[windowId]?.tabId === tabId;

const windowOpen = (s: BrowserState, windowId: string) => !!s.windows[windowId] && !isWindowClosing(windowId);

function restoreFrame(windowId: string, frame: Frame | null) {
  const s = browser();
  const anchor = windowOpen(s, windowId) ? activeTabId(s, windowId) : undefined;
  if (frame && anchor) void setTabWindowFrame(anchor, frame);
}

const reload = (tabId: string) => {
  if (browser().tabs[tabId]) void withLivePage(tabId, (page) => page.reload());
};

function failed(windowId: string, failure: DeviceModeFailure) {
  noteDeviceMode(failure);
  showToast(windowId, FAILURE_MESSAGES[failure], undefined, { icon: "iphone.slash" });
}

export function toggleDeviceMode(windowId: string) {
  if (modes().sessions[windowId]) return void endDeviceMode(windowId, "desktop");
  void startDeviceMode(windowId);
}

async function startDeviceMode(windowId: string) {
  const s = browser();
  if (!isSmall(s, windowId) || !windowOpen(s, windowId)) return;
  const tabId = activeTabId(s, windowId);
  if (!tabId) return;
  if (!emulatesUrl(s.tabs[tabId]?.url)) return failed(windowId, "notHttp");
  const started = begin(modes(), windowId, tabId);
  if (!started) return;
  apply(started);
  watchDeviceMode();
  const sizing = await fitWindowToPage(tabId, IPHONE.width, IPHONE.height).catch(orWarn(null));
  if (!emulating(windowId, tabId)) return restoreFrame(windowId, sizing?.previous ?? null);
  if (sizing) apply(fit(modes(), windowId, tabId, sizing.previous, sizing.frame));
  const result = await startDeviceEmulation(tabId, iphonePreset(sizing?.scale)).catch(orWarn<{ error: DeviceModeFailure }>({ error: "attachRefused" }));
  if (!emulating(windowId, tabId)) {
    if (!("error" in result)) void stopDeviceEmulation(tabId).then(() => reload(tabId));
    return;
  }
  if ("error" in result) {
    const restore = modes().sessions[windowId]?.restore ?? null;
    apply(end(modes(), windowId, Date.now()));
    restoreFrame(windowId, restore);
    return failed(windowId, result.error);
  }
  apply(turnOn(modes(), windowId, tabId));
  noteDeviceMode("on");
}

export async function endDeviceMode(windowId: string, cause: EndCause, reason?: DeviceModeEndReason) {
  const session = modes().sessions[windowId];
  if (!session) return;
  apply(end(modes(), windowId, Date.now()));
  if (cause !== "closed") restoreFrame(windowId, session.restore);
  if (cause !== "engine") await stopDeviceEmulation(session.tabId).catch(orWarn(false));
  if (cause === "engine" ? reason && RELOADS_AFTER.has(reason) : cause !== "closed") reload(session.tabId);
}

function checkSessions(s: BrowserState) {
  for (const [windowId, session] of Object.entries(modes().sessions)) {
    const tab = s.tabs[session.tabId];
    const cause = endCause(windowId, session, { open: windowOpen(s, windowId), activeTabId: activeTabId(s, windowId), tabWindowId: tab?.windowId });
    if (cause) void endDeviceMode(windowId, cause);
  }
}

let watching = false;

function watchDeviceMode() {
  if (watching) return;
  watching = true;
  useBrowser.subscribe((s, prev) => {
    if (s.windows !== prev.windows || s.tabs !== prev.tabs) checkSessions(s);
  });
  onDeviceEmulationEnded(({ tabId, reason }) => {
    const windowId = windowEmulating(modes(), tabId);
    if (windowId) void endDeviceMode(windowId, "engine", reason);
  });
}
