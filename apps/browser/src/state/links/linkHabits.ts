import { isFields, isString } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { readDocument, writeDocument } from "../../platform/documents";

export type LinkHabit = { profileId: string; times: number };
export type LinkHabits = Record<string, LinkHabit>;

const DOC = "link-habits.json";
const VERSION = 1;
const MAX_SITES = 200;
export const LEARN_AFTER = 2;

const isHabit = (v: unknown): v is LinkHabit => isFields(v) && isString(v.profileId) && typeof v.times === "number" && v.times > 0;

export function countedSend(habits: LinkHabits, site: string, profileId: string): { habits: LinkHabits; learned: boolean } {
  const { [site]: before, ...others } = habits;
  const times = before?.profileId === profileId ? before.times + 1 : 1;
  if (times >= LEARN_AFTER) return { habits: others, learned: true };
  const kept = Object.entries(others).slice(-(MAX_SITES - 1));
  return { habits: { ...Object.fromEntries(kept), [site]: { profileId, times } }, learned: false };
}

let loaded: LinkHabits | null = null;

function saved(): LinkHabits {
  const sites = parseSaved(readDocument(DOC), VERSION)?.sites;
  if (!isFields(sites)) return {};
  return Object.fromEntries(Object.entries(sites).filter((entry): entry is [string, LinkHabit] => isHabit(entry[1])));
}

export function noteLinkSent(site: string, profileId: string): boolean {
  const next = countedSend((loaded ??= saved()), site, profileId);
  loaded = next.habits;
  writeDocument(DOC, versionedJson({ sites: loaded }, VERSION));
  return next.learned;
}

export function forgetLinkHabits() {
  loaded = null;
}
