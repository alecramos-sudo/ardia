import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { clearCrawlerData, refreshCrawler } from "../crawler/actions";
import { crawlerEngineProfile, crawlerProfileIn, isCrawlerProfileIn, useCrawler } from "../crawler/crawler";
import { failure, type MethodError } from "./automationMethods";
import { ownEntry } from "./automationWindows";

type Body = { result: unknown } | { error: MethodError };

export type CrawlerProfileAnswer = {
  id: string;
  name: string;
  engineProfile: string;
  ready: boolean;
  reason: string | null;
};

function onlyProfileParam(method: string, params: Record<string, unknown>): string | { error: MethodError } {
  const unknown = Object.keys(params).filter((key) => key !== "profile");
  if (unknown.length) return failure("bad_request", `${method} takes profile, not ${unknown.join(", ")}.`);
  const { profile } = params;
  if (typeof profile !== "string" || !profile.trim()) return failure("bad_request", `${method} needs profile: a profile's name or id.`);
  return profile.trim();
}

function findProfile(wanted: string): { id: string; name: string } | { error: MethodError } {
  const s = useBrowser.getState();
  const usable = s.profileOrder.flatMap((id) => {
    const profile = ownEntry(s.profiles, id);
    return profile && !isIncognitoProfile(id) ? [{ id, name: profile.name }] : [];
  });
  const byId = usable.find((p) => p.id === wanted);
  if (byId) return byId;
  const named = usable.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) return failure("bad_request", `${named.length} profiles are named ${wanted}: ${named.map((p) => p.id).join(", ")}. Name one by its id.`);
  return named[0] ?? failure("no_window", `There's no profile ${wanted}.`);
}

export function resolveCrawlerProfile(wanted: string): CrawlerProfileAnswer | { error: MethodError } {
  const found = findProfile(wanted);
  if ("error" in found) return found;
  const { id, name } = found;
  const s = useBrowser.getState();
  const crawler = useCrawler.getState().state;
  if (!isCrawlerProfileIn(crawler, s, id)) return failure("refused", `${name} isn't a crawler profile; turn on Crawler profile for it in Settings › Profiles.`);
  const entry = crawlerProfileIn(crawler, s, id);
  return { id, name, engineProfile: crawlerEngineProfile(s, id), ready: !!entry?.ready, reason: entry?.ready ? null : (entry?.reason ?? null) };
}

export async function crawlerProfileMethod(params: Record<string, unknown>): Promise<Body> {
  const wanted = onlyProfileParam("crawler.profile", params);
  if (typeof wanted !== "string") return wanted;
  await refreshCrawler();
  const answer = resolveCrawlerProfile(wanted);
  return "error" in answer ? answer : { result: answer };
}

export async function crawlerResetMethod(params: Record<string, unknown>): Promise<Body> {
  const wanted = onlyProfileParam("crawler.reset", params);
  if (typeof wanted !== "string") return wanted;
  await refreshCrawler();
  const answer = resolveCrawlerProfile(wanted);
  if ("error" in answer) return answer;
  const problem = await clearCrawlerData(answer.id);
  if (problem) return failure("failed", `${answer.name} wasn't reset: ${problem}`);
  return { result: { ok: true, profile: answer.id, name: answer.name, engineProfile: answer.engineProfile } };
}
