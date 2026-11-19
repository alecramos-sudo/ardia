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
import { begin, end, endCause, fit, isCurrent, STOP_DEADLINE_MS, turnOn, windowEmulating, type DeviceModeState, type EndCause, type Frame } from "./session";
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

let lastGeneration = 0;
const settling = new Map<string, Promise<unknown>>();

function settleBefore(windowId: string, work: Promise<unknown>) {
  const prior = settling.get(windowId);
  const all = prior ? Promise.allSettled([prior, work]) : Promise.allSettled([work]);
  settling.set(windowId, all);
  void all.then(() => {
    if (settling.get(windowId) === all) settling.delete(windowId);
  });
}

const windowOpen = (s: BrowserState, windowId: string) => !!s.windows[windowId] && !isWindowClosing(windowId);

async function stopThenReload(tabId: string, reloads: boolean) {
  const stopped = stopDeviceEmulation(tabId).catch(orWarn(false));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), STOP_DEADLINE_MS);
  });
  const answer = await Promise.race([stopped, deadline]);
  clearTimeout(timer);
  if (answer !== "late") return void (reloads && reload(tabId));
  console.warn(`[deviceMode] stopping ${tabId} got no answer in ${STOP_DEADLINE_MS} ms`);
  if (reloads) void stopped.then(() => reload(tabId));
}

async function restoreFrame(windowId: string, frame: Frame | null) {
  const s = browser();
  const anchor = windowOpen(s, windowId) ? activeTabId(s, windowId) : undefined;
  if (frame && anchor) await setTabWindowFrame(anchor, frame).catch(orWarn(false));
}

const reload = (tabId: string) => {
  if (browser().tabs[tabId]) void withLivePage(tabId, (page) => page.reload());
};

function failed(windowId: string, failure: DeviceModeFailure) {
  noteDeviceMode(failure);
  showToast(windowId, FAILURE_MESSAGES[failure], undefined, { icon: "iphone.slash" });
}

export function toggleDeviceMode(windowId: string) {
  if (modes().sessions[windowId]) return endDeviceMode(windowId, "desktop");
  startDeviceMode(windowId);
}

function startDeviceMode(windowId: string) {
  const s = browser();
  if (!isSmall(s, windowId) || !windowOpen(s, windowId)) return;
  const tabId = activeTabId(s, windowId);
  if (!tabId) return;
  if (!emulatesUrl(s.tabs[tabId]?.url)) return failed(windowId, "notHttp");
  const generation = ++lastGeneration;
  const started = begin(modes(), windowId, tabId, generation);
  if (!started) return;
  apply(started);
  watchDeviceMode();
  const prior = settling.get(windowId) ?? Promise.resolve();
  settleBefore(windowId, prior.then(() => runStart(windowId, tabId, generation)));
}

async function runStart(windowId: string, tabId: string, generation: number) {
  const current = () => isCurrent(modes(), windowId, generation);
  if (!current()) return;
  const sizing = await fitWindowToPage(tabId, IPHONE.width, IPHONE.height).catch(orWarn(null));
  if (!current()) return restoreFrame(windowId, sizing?.previous ?? null);
  if (sizing) apply(fit(modes(), windowId, generation, sizing.previous, sizing.frame));
  const result = await startDeviceEmulation(tabId, iphonePreset(sizing?.scale)).catch(orWarn<{ error: DeviceModeFailure }>({ error: "attachRefused" }));
  if (!current()) {
    if ("error" in result) return;
    return stopThenReload(tabId, true);
  }
  if ("error" in result) {
    const restore = modes().sessions[windowId]?.restore ?? null;
    apply(end(modes(), windowId, Date.now()));
    failed(windowId, result.error);
    return restoreFrame(windowId, restore);
  }
  apply(turnOn(modes(), windowId, generation));
  noteDeviceMode("on");
}

export function endDeviceMode(windowId: string, cause: EndCause, reason?: DeviceModeEndReason) {
  const session = modes().sessions[windowId];
  if (!session) return;
  apply(end(modes(), windowId, Date.now()));
  settleBefore(windowId, tearDown(windowId, session.tabId, session.restore, cause, reason));
}

async function tearDown(windowId: string, tabId: string, restore: Frame | null, cause: EndCause, reason?: DeviceModeEndReason) {
  const restored = cause === "closed" ? Promise.resolve() : restoreFrame(windowId, restore);
  const reloads = cause === "engine" ? !!reason && RELOADS_AFTER.has(reason) : cause !== "closed";
  if (cause !== "engine") await stopThenReload(tabId, reloads);
  await restored;
  if (cause === "engine" && reloads) reload(tabId);
}

function checkSessions(s: BrowserState) {
  for (const [windowId, session] of Object.entries(modes().sessions)) {
    const tab = s.tabs[session.tabId];
    const cause = endCause(windowId, session, { open: windowOpen(s, windowId), activeTabId: activeTabId(s, windowId), tabWindowId: tab?.windowId });
    if (cause) endDeviceMode(windowId, cause);
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
    if (windowId) endDeviceMode(windowId, "engine", reason);
  });
}
