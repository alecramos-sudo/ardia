import type { ChoiceItem } from "../app/menuChoice";
import { menuSections } from "../app/menuSections";
import type { Destination } from "./menuParts";

type Item = ChoiceItem<Destination>;
type Named = Extract<Item, { id: string }>;
type Place = { id: string; title: string; holds: (itemId: string, pinned: boolean) => boolean };

const isNamed = (item: Item): item is Named => "id" in item;
const any = (...ids: string[]) => (itemId: string) => ids.includes(itemId);
const MOVE_ACTIONS = ["newGroup", "ungroupTab", "newFolder", "leaveFolder"];
const MOVE_LISTS: Record<string, string> = { moveToGroup: "Groups", moveToProfile: "Profiles", moveToWindow: "Windows" };

const PLACES = [
  [{ id: "backToPin", title: "Back to Pinned URL", holds: any("backToPin") }],
  [
    { id: "copy", title: "Copy Link", holds: any("copy") },
    { id: "copyMd", title: "Copy Link as Markdown", holds: any("copyMd") },
    { id: "rename", title: "Rename", holds: any("rename", "resetName") },
    { id: "icon", title: "Change Icon", holds: any("icon", "resetIcon") },
    { id: "duplicate", title: "Duplicate", holds: any("duplicate") },
    { id: "split", title: "Open as Split", holds: any("split", "unsplit") },
    { id: "newWindow", title: "Open in New Window", holds: any("newWindow") },
    { id: "incognito", title: "Open in Incognito", holds: any("incognito") },
    { id: "engine", title: "Open in the Other Engine", holds: any("engine") },
    { id: "pin", title: "Pin or Unpin", holds: (itemId: string, pinned: boolean) => (pinned ? itemId === "pin" || itemId === "unpinMember" : itemId === "pinRow") },
    { id: "pinElsewhere", title: "Move to Top Apps or Pinned", holds: (itemId: string, pinned: boolean) => (pinned ? itemId === "pinRow" || itemId === "pinTile" : itemId === "pin") },
    { id: "pinnedPage", title: "Edit Pinned Page", holds: any("pinnedPage") },
    { id: "moveTo", title: "Move to", holds: any("moveTo") },
    { id: "bookmark", title: "Add to Bookmarks", holds: any("bookmark") },
    { id: "bookmarkTo", title: "Add Bookmark to Folder", holds: any("bookmarkTo") },
    { id: "send", title: "Send to Device", holds: (itemId: string) => itemId === "sendToDevice" || itemId.startsWith("sendTo:") },
    { id: "mute", title: "Mute Tab", holds: any("mute") },
    { id: "muteSite", title: "Mute Site", holds: any("muteSite") },
    { id: "unread", title: "Unread Count", holds: any("siteUnread", "allUnread") },
    { id: "calendar", title: "Calendar", holds: (itemId: string) => itemId === "cal" || itemId.startsWith("cal:") },
  ],
  [
    { id: "close", title: "Close", holds: any("close", "closeSplit") },
    { id: "closeOthers", title: "Close Other Tabs", holds: any("closeOthers") },
    { id: "closeBelow", title: "Close Tabs Below", holds: any("closeBelow") },
    { id: "closeAbove", title: "Close Tabs Above", holds: any("closeAbove") },
  ],
] as const satisfies readonly (readonly Place[])[];

const SECTIONS: readonly (readonly Place[])[] = PLACES;

export type TabMenuPlaceId = (typeof PLACES)[number][number]["id"];

export const TAB_MENU_PLACES: readonly { id: TabMenuPlaceId; title: string }[] = PLACES.flat().map(({ id, title }) => ({ id, title }));
export const TAB_MENU_PLACE_IDS: readonly TabMenuPlaceId[] = TAB_MENU_PLACES.map((place) => place.id);
export const DEFAULT_TAB_MENU_SHOWN: readonly TabMenuPlaceId[] = ["backToPin", "copy", "rename", "duplicate", "split", "pin", "moveTo", "mute", "close", "closeOthers", "closeBelow"];

const KNOWN: ReadonlySet<unknown> = new Set(TAB_MENU_PLACE_IDS);

export const isTabMenuShown = (v: unknown): v is TabMenuPlaceId[] => Array.isArray(v) && v.every((id) => KNOWN.has(id));

export const withTabMenuPlace = (shown: readonly TabMenuPlaceId[], id: TabMenuPlaceId, on: boolean): TabMenuPlaceId[] =>
  TAB_MENU_PLACE_IDS.filter((place) => (place === id ? on : shown.includes(place)));

function alwaysVisible(item: Named): Named {
  if (!item.alternate) return item;
  const { alternate, modifiers, ...plain } = item;
  return plain.key ? { ...plain, modifiers } : plain;
}

function withBackToPinLifted(items: Named[]): Named[] {
  return items.flatMap((item) => {
    const children = item.id === "pinnedPage" ? (item.children ?? []) : [];
    const back = children.filter(isNamed).find((child) => child.id === "backToPin");
    if (!back) return [item];
    const rest = children.filter((child) => child !== back);
    return [back, { ...item, children: rest.slice(Math.max(0, rest.findIndex(isNamed))) }];
  });
}

function withMoveToGathered(items: Named[]): Named[] {
  const actions = items.filter((item) => MOVE_ACTIONS.includes(item.id));
  const lists = items.flatMap((item) => {
    const title = MOVE_LISTS[item.id];
    const children = item.children ?? [];
    const first = children[0];
    if (!title || item.enabled === false || !first) return [];
    if (isNamed(first) && first.enabled === false) return [children];
    return [[{ id: `${item.id}Header`, title, enabled: false }, ...children.filter((child) => !("separator" in child))]];
  });
  const rest = items.filter((item) => !MOVE_ACTIONS.includes(item.id) && !(item.id in MOVE_LISTS));
  const children = menuSections<Item>(actions, ...lists);
  const moveTo: Named = { id: "moveTo", title: "Move to", symbol: "folder", children };
  return children.length ? [...rest, moveTo] : rest;
}

export function arrangeTabMenu(items: readonly Item[], look: { shown: readonly string[]; pinned: boolean }): Item[] {
  const left = new Set(withMoveToGathered(withBackToPinLifted(items.filter(isNamed).map(alwaysVisible))));
  const take = (place: Place) => {
    const taken = [...left].filter((item) => place.holds(item.id, look.pinned));
    for (const item of taken) left.delete(item);
    return taken;
  };
  const main: Named[][] = [];
  const tucked: Named[][] = [];
  for (const section of SECTIONS) {
    main.push(section.filter((place) => look.shown.includes(place.id)).flatMap(take));
    tucked.push(section.filter((place) => !look.shown.includes(place.id)).flatMap(take));
  }
  const children = menuSections<Item>(...tucked, [...left]);
  const more: Named = { id: "more", title: "More", symbol: "ellipsis.circle", children };
  return menuSections<Item>(...main, children.length ? [more] : []);
}
