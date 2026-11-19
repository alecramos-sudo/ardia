import { useEffect } from "react";
import { create } from "zustand";
import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { isSilenced } from "../tabs/mute";

const MAX_PIXELS = 256;
const MAX_ENTRIES = 24;

type Entry = { uri: string | null; at: number };
const useArtworks = create<{ entries: Record<string, Entry> }>()(() => ({ entries: {} }));
const inflight = new Set<string>();

const keyOf = (tabId: string, url: string) => `${tabId} ${url}`;
const tabOf = (key: string) => key.slice(0, key.indexOf(" "));

export const artworkEntry = (tabId: string, url: string): Entry | undefined => useArtworks.getState().entries[keyOf(tabId, url)];

export function loadArtwork(tabId: string, url: string) {
  const key = keyOf(tabId, url);
  if (inflight.has(key) || useArtworks.getState().entries[key]) return;
  const view = webviews.get(tabId);
  if (!view) return;
  inflight.add(key);
  void view
    .downloadArtwork(url, MAX_PIXELS)
    .catch(() => null)
    .then((image) => {
      inflight.delete(key);
      useArtworks.setState((s) => {
        const entries = { ...s.entries, [key]: { uri: image?.uri ?? null, at: Date.now() } };
        const keys = Object.keys(entries).sort((a, b) => entries[a]!.at - entries[b]!.at);
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete entries[old];
        return { entries };
      });
    });
}

export function useArtwork(tabId: string, url: string | null | undefined): string | null {
  const entry = useArtworks((s) => (url ? s.entries[keyOf(tabId, url)] : undefined));
  useEffect(() => {
    if (url && !entry) loadArtwork(tabId, url);
  }, [tabId, url, entry]);
  return entry?.uri ?? null;
}

const silenced = (s: BrowserState, tabId: string) => {
  const tab = s.tabs[tabId];
  return !!tab && isSilenced(s, tab);
};

useBrowser.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.settings === prev.settings && s.privateSiteMutes === prev.privateSiteMutes) return;
  const entries = useArtworks.getState().entries;
  const stale = Object.entries(entries)
    .filter(([key, entry]) => {
      const tabId = tabOf(key);
      return !s.tabs[tabId] || (entry.uri === null && silenced(s, tabId) !== silenced(prev, tabId));
    })
    .map(([key]) => key);
  if (!stale.length) return;
  const next = { ...entries };
  for (const key of stale) delete next[key];
  useArtworks.setState({ entries: next });
});
