import { readClientSiteGroups, type ClientSiteGroup } from "./clientSiteRows";
import { parseSaved } from "../../lib/savedDocument";
import { readDocument } from "../../platform/documents";
import { noteClientSites } from "../telemetry/incognitoCounts";

export const CLIENT_SITES_DOC = "client-sites.json";
export const CLIENT_SITES_VERSION = 1;

const NONE: readonly ClientSiteGroup[] = [];
let logged: "missing" | "unreadable" | null = null;

function logOnce(state: "missing" | "unreadable") {
  if (logged === state) return;
  logged = state;
  if (state === "missing") console.log("[clientSites] no client-sites.json; the private window's bar lists no client sites");
  else console.warn("[clientSites] client-sites.json is unreadable; the private window's bar lists no client sites");
}

export function readClientSites(read: (name: string) => string | null = readDocument): readonly ClientSiteGroup[] {
  const json = read(CLIENT_SITES_DOC);
  if (json === null) {
    logOnce("missing");
    return NONE;
  }
  const groups = readClientSiteGroups(parseSaved(json, CLIENT_SITES_VERSION));
  if (!groups) {
    if (logged !== "unreadable") noteClientSites("unreadable");
    logOnce("unreadable");
    return NONE;
  }
  logged = null;
  return groups;
}

export function forgetClientSitesLog() {
  logged = null;
}
