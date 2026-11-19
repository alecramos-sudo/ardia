import type { DevicePreset } from "../../platform/deviceMode";

export const IPHONE = {
  width: 402,
  height: 874,
  deviceScaleFactor: 3,
  maxTouchPoints: 5,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
} as const;

const SMALLEST_SCALE = 0.25;

export function iphonePreset(scale = 1): DevicePreset {
  const fit = Number.isFinite(scale) ? Math.min(1, Math.max(SMALLEST_SCALE, scale)) : 1;
  return { ...IPHONE, scale: fit };
}

export const emulatesUrl = (url: string | undefined) => /^https?:\/\//i.test(url ?? "");
