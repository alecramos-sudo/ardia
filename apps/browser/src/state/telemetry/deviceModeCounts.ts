import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const FIELDS = {
  on: "device_mode_on",
  notHttp: "device_mode_fail_not_web",
  noExtension: "device_mode_fail_no_extension",
  noTarget: "device_mode_fail_attach",
  attachRefused: "device_mode_fail_attach",
  timeout: "device_mode_fail_timeout",
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

const none = (): Record<Field, number> => ({ device_mode_on: 0, device_mode_fail_not_web: 0, device_mode_fail_no_extension: 0, device_mode_fail_attach: 0, device_mode_fail_timeout: 0 });

let counts = none();

export function noteDeviceMode(event: keyof typeof FIELDS, consent?: ConsentToken | null) {
  const field = FIELDS[event];
  countFor(consent, () => void counts[field]++, { [field]: 1 });
}

export function takeDeviceModeCounts() {
  const taken = counts;
  counts = none();
  return taken;
}
