import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const NONE = { clientSitePicks: 0, clientSitesUnreadable: 0, opens: 0, opensFromLittleArdia: 0, previewFromUrl: 0, previewFromTheme: 0, previewNone: 0 };
let counts = { ...NONE };

const PREVIEW = {
  url: ["previewFromUrl", "open_in_incognito_preview_url"],
  theme: ["previewFromTheme", "open_in_incognito_preview_theme"],
  none: ["previewNone", "open_in_incognito_preview_none"],
} as const;

export const noteClientSites = (event: "picked" | "unreadable") => void counts[event === "picked" ? "clientSitePicks" : "clientSitesUnreadable"]++;

export function noteOpenInIncognito(preview: keyof typeof PREVIEW, from: "tabMenu" | "littleArdia", consent?: ConsentToken | null) {
  const [counter, field] = PREVIEW[preview];
  const fromLittleArdia = from === "littleArdia";
  countFor(
    consent,
    () => void (counts.opens++, counts[counter]++, fromLittleArdia && counts.opensFromLittleArdia++),
    { open_in_incognito: 1, [field]: 1, open_in_incognito_from_little_ardia: +fromLittleArdia },
  );
}

export function takeIncognitoCounts() {
  const taken = {
    client_site_picks: counts.clientSitePicks,
    client_sites_unreadable: counts.clientSitesUnreadable,
    open_in_incognito: counts.opens,
    open_in_incognito_from_little_ardia: counts.opensFromLittleArdia,
    open_in_incognito_preview_url: counts.previewFromUrl,
    open_in_incognito_preview_theme: counts.previewFromTheme,
    open_in_incognito_preview_none: counts.previewNone,
  };
  counts = { ...NONE };
  return taken;
}
