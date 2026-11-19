import type { WebNotification } from "../../platform/tabs";
import { confirm } from "../../platform/dialogs";
import {
  notificationPermission,
  openNotificationSettings,
  postNotification,
  removeNotifications,
  requestNotificationPermission,
  type NotificationResponse,
} from "../../platform/notifications";
import { useBrowser } from "../browser/store";
import { focus, switchToTab } from "../browser/actions";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { isSilenced } from "../tabs/mute";
import { noteNotificationShown } from "../automation/notificationEvents";
import { noteWebNotificationFromShim } from "../telemetry/webNotificationCounts";
import { recordWebNotificationPost } from "../telemetry/webNotificationFailures";
import { consentToken } from "../telemetry/choice";
import { noteWebNotificationClicked } from "../telemetry/notificationRequestCounts";

const shown = new Map<string, { tabId: string; engineId: string }>();

const macId = (tabId: string, n: WebNotification) => (n.tag ? `web:${n.origin}#${n.tag}` : `web:${tabId}/${n.id}`);

const isShown = (id: string, tabId: string | null, engineId: string | undefined) => {
  const entry = shown.get(id);
  return !!entry && entry.tabId === tabId && entry.engineId === engineId;
};

const received = new Map<string, WebNotification>();
const RECEIVED_KEPT = 50;
if (__DEV__) (globalThis as { acWebNotifications?: unknown }).acWebNotifications = { received: () => [...received.values()] };

function noteReceived(tabId: string, n: WebNotification) {
  received.delete(macId(tabId, n));
  received.set(macId(tabId, n), n);
  for (const id of received.keys()) {
    if (received.size <= RECEIVED_KEPT) break;
    received.delete(id);
  }
}

export function showWebNotification(tabId: string, n: WebNotification) {
  const consent = consentToken();
  if (__DEV__) noteReceived(tabId, n);
  noteWebNotificationFromShim();
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  const window = tab ? s.windows[tab.windowId] : undefined;
  if (!tab || !window || window.kind === "private") return void webviews.get(tabId)?.notificationAction(n.id, "close");
  const id = macId(tabId, n);
  shown.set(id, { tabId, engineId: n.id });
  let site = n.origin;
  try {
    site = new URL(n.origin).host;
  } catch {}
  void ensureNotificationPermission(tab.windowId).then(async (allowed) => {
    if (!allowed || !isShown(id, tabId, n.id)) return;
    const icon = n.icon ? await iconFor(tabId, n.id, n.icon) : undefined;
    if (!isShown(id, tabId, n.id)) return;
    const now = useBrowser.getState();
    const current = now.tabs[tabId];
    noteNotificationShown(tabId, n);
    void recordWebNotificationPost(
      postNotification({
        id,
        title: n.title,
        body: n.body,
        subtitle: site,
        silent: n.silent || (!!current && isSilenced(now, current)),
        icon,
        tabId,
        windowId: tab.windowId,
        origin: n.origin,
        dismissible: true,
        data: { engineId: n.id },
      }),
      { titleLength: n.title.length, bodyLength: n.body.length, iconRequested: !!n.icon, iconSent: !!icon },
      consent,
    );
  });
}

const ICON_PIXELS = 128;
const ICON_TIMEOUT_MS = 3000;

async function iconFor(tabId: string, notificationId: string, url: string): Promise<string | undefined> {
  const view = webviews.get(tabId);
  if (!view) return undefined;
  const image = await withDeadline(view.downloadNotificationIcon(notificationId, url, ICON_PIXELS).catch(() => null), ICON_TIMEOUT_MS, null);
  return image?.uri ?? undefined;
}

export function closeWebNotification(tabId: string, engineId: string) {
  if (__DEV__) for (const [id, n] of received) if (n.id === engineId && id === macId(tabId, n)) received.delete(id);
  for (const [id, entry] of shown) {
    if (entry.tabId !== tabId || entry.engineId !== engineId) continue;
    shown.delete(id);
    void removeNotifications([id]);
  }
}

export function handleWebNotificationResponse({ id, action, tabId, data }: NotificationResponse): boolean {
  if (!id.startsWith("web:")) return false;
  const engineId = (data as { engineId?: string } | null)?.engineId;
  if (engineId && isShown(id, tabId, engineId)) shown.delete(id);
  const tab = tabId ? useBrowser.getState().tabs[tabId] : undefined;
  if (!tab) return true;
  if (action === "click") {
    noteWebNotificationClicked();
    switchToTab(tab.id);
    focus(tab.windowId);
  }
  if (engineId) void webviews.get(tab.id)?.notificationAction(engineId, action);
  return true;
}

let asked = false;

export async function ensureNotificationPermission(windowId?: string): Promise<boolean> {
  const status = await notificationPermission();
  if (status === "granted" || status === "provisional") return true;
  if (status === "notDetermined") return requestNotificationPermission();
  if (asked) return false;
  asked = true;
  const { confirmed } = await confirm({
    title: "Ardia Needs Notifications Permission",
    message: "You need to open System Settings to give Ardia permission to show you Notifications.",
    confirmTitle: "Open System Settings",
    cancelTitle: "Not Now",
    windowId,
  });
  if (confirmed) void openNotificationSettings();
  return false;
}

if (__DEV__) (globalThis as { acNotifications?: unknown }).acNotifications = { shown };
