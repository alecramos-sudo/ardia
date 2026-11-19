export type RenderedTheme = { id: string; role: string };
export type PreviewKept = "url" | "theme" | "none";

export const PREVIEW_THEME_PARAM = "preview_theme_id";
const THEME_ID = /^\d{1,20}$/;
const WEB_URL = /^https?:\/\/[^/?#\s]+/i;

export const THEME_PROBE = `let theme = null;
for (const script of document.querySelectorAll("script:not([src])")) {
  const found = /Shopify\\.theme\\s*=\\s*(\\{.*\\})/.exec(script.textContent || "");
  if (!found) continue;
  try {
    theme = JSON.parse(found[1]);
  } catch {}
  break;
}
post("result", JSON.stringify(theme && typeof theme === "object" ? { id: String(theme.id), role: String(theme.role) } : null));`;

export const isWebPage = (url: string): boolean => WEB_URL.test(url);

type Parts = { base: string; params: string[]; hash: string };

function partsOf(url: string): Parts {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return { base: beforeHash, params: [], hash };
  return { base: beforeHash.slice(0, queryAt), params: beforeHash.slice(queryAt + 1).split("&").filter(Boolean), hash };
}

const keyOf = (param: string) => param.split("=", 1)[0]!;

const valueOf = (param: string) => {
  const at = param.indexOf("=");
  return at < 0 ? "" : param.slice(at + 1);
};

export function previewThemeInUrl(url: string): string | null {
  const found = partsOf(url).params.find((p) => keyOf(p) === PREVIEW_THEME_PARAM && valueOf(p));
  return found ? valueOf(found) : null;
}

export function readRenderedTheme(value: unknown): RenderedTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, role } = value as Record<string, unknown>;
  const themeId = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" ? id : null;
  if (!themeId || !THEME_ID.test(themeId) || typeof role !== "string" || !role) return null;
  return { id: themeId, role };
}

export function withPreviewTheme(url: string, themeId: string): string {
  const { base, params, hash } = partsOf(url);
  const kept = params.filter((p) => keyOf(p) !== PREVIEW_THEME_PARAM);
  return `${base}?${[...kept, `${PREVIEW_THEME_PARAM}=${themeId}`].join("&")}${hash}`;
}

export function incognitoUrl(url: string, theme: RenderedTheme | null): { url: string; preview: PreviewKept } {
  if (previewThemeInUrl(url)) return { url, preview: "url" };
  if (!theme || theme.role === "main" || !isWebPage(url)) return { url, preview: "none" };
  return { url: withPreviewTheme(url, theme.id), preview: "theme" };
}
