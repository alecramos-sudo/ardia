import type { ProviderSuggestion, SearchScope } from "@ardia/core";
import { idleClientSiteRows, typedClientSiteRows, withClientSiteRows } from "../../state/clientSites/clientSiteRows";
import { useMemo, type RefObject } from "react";
import type { TextInput } from "react-native";
import { previewText } from "./barText";
import { offeredScope } from "../../state/omnibox/scopes";
import { useDropdownStart, useOpenTabsStart } from "./dropdownStart";
import { useInlineCompletion } from "./useInlineCompletion";
import { useSuggestions } from "./useSuggestions";
import { useClientSites } from "../../state/clientSites/hooks";

const NO_ROWS: ProviderSuggestion[] = [];

export function useBarItems({
  input,
  typed,
  edited,
  scope,
  suppressCompletion,
  selected,
  dropdown,
  opensTab,
  windowId,
  profileId,
  tabId,
  currentUrl,
  privateWindow,
}: {
  input: RefObject<TextInput | null>;
  typed: string;
  edited: boolean;
  scope: SearchScope | null;
  suppressCompletion: boolean;
  selected: number;
  dropdown: boolean;
  opensTab: boolean;
  windowId: string;
  profileId: string;
  tabId: string;
  currentUrl: string;
  privateWindow: boolean;
}) {
  const { items: suggested, completion } = useSuggestions({
    text: typed,
    active: edited || !!scope,
    windowId,
    profileId,
    currentTabId: tabId,
    currentUrl: currentUrl || undefined,
    scope,
    preventInline: suppressCompletion,
  });
  const start = useDropdownStart(dropdown && !edited && !scope, tabId, profileId);
  const idle = opensTab && !scope && !typed.trim();
  const openTabs = useOpenTabsStart(idle, windowId, profileId);
  const sites = useClientSites(privateWindow);
  const starting = dropdown && !edited && !scope;
  const blank = !scope && !typed.trim();
  const clientIdle = !starting && blank && sites.length > 0;
  const clientTyped = !starting && !blank && !scope && edited && sites.length > 0;
  const idleClients = useMemo(() => (clientIdle ? idleClientSiteRows(sites) : NO_ROWS), [clientIdle, sites]);
  const typedClients = useMemo(() => (clientTyped ? typedClientSiteRows(sites, typed) : NO_ROWS), [clientTyped, sites, typed]);
  const items = useMemo(() => {
    if (starting) return start;
    if (idle) return idleClients.length ? [...openTabs, ...idleClients] : openTabs;
    if (clientIdle) return idleClients;
    return typedClients.length ? withClientSiteRows(suggested, typedClients) : suggested;
  }, [starting, start, idle, openTabs, idleClients, clientIdle, typedClients, suggested]);
  const listOnly = idle || clientIdle;
  const unpreviewed = listOnly ? -1 : 0;
  const selectedIndex = selected < 0 && listOnly ? -1 : Math.min(Math.max(selected, 0), items.length - 1);
  const current = items[selectedIndex];
  const preview = selectedIndex > unpreviewed ? (previewText(current) ?? typed) : null;
  const previewing = preview !== null;
  const inline = useInlineCompletion(input, typed, suppressCompletion || scope ? "" : completion, preview);
  const shownCompletion = previewing ? "" : inline.shown;
  const value = preview ?? typed + shownCompletion;
  const tabScope = useMemo(
    () => (!scope && edited && !previewing ? offeredScope(typed, shownCompletion, windowId) : null),
    [scope, edited, previewing, typed, shownCompletion, windowId],
  );
  return { clientIdle, items, completion, inline, shownCompletion, value, selectedIndex, current, tabScope, previewing, unpreviewed };
}
