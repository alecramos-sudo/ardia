import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useDeviceMode } = await import("./store.ts");
const { begin, end, fit, NO_DEVICE_MODE, turnOn } = await import("./session.ts");
const { moveLittleArdiaToProfile } = await import("../littleArdia/actions.ts");

const S = () => useBrowser.getState();
const PROFILES = {
  default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
  work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 0 },
};
const BEFORE = [100, 200, 900, 640];
const PHONE = [100, -82, 418, 922];

function littleArdiaInIphoneMode() {
  S().hydrate({ profiles: PROFILES, profileOrder: ["default", "work"], windows: {}, tabs: {} });
  S().createWindow({ url: "https://main.example/" });
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  const tabId = S().windows[small].tabIds[0];
  S().setWindowFrame(small, BEFORE);
  assert.deepEqual(S().settings.littleArdiaSize, [900, 640]);
  useDeviceMode.setState(turnOn(fit(begin(NO_DEVICE_MODE, small, tabId), small, tabId, BEFORE, PHONE), small, tabId), true);
  return { small, tabId };
}

test("resizing or moving a Little Ardia window in iPhone mode keeps the saved Little Ardia size", () => {
  const { small } = littleArdiaInIphoneMode();
  S().setWindowFrame(small, PHONE);
  assert.deepEqual(S().windows[small].frame, PHONE);
  assert.deepEqual(S().settings.littleArdiaSize, [900, 640]);
  S().setWindowFrame(small, [300, 10, 418, 922]);
  assert.deepEqual(S().settings.littleArdiaSize, [900, 640]);
});

test("leaving iPhone mode: a late report of the iPhone frame is held, the restored frame goes through as before", () => {
  const { small } = littleArdiaInIphoneMode();
  useDeviceMode.setState(end(useDeviceMode.getState(), small, Date.now()), true);
  S().setWindowFrame(small, PHONE);
  assert.deepEqual(S().settings.littleArdiaSize, [900, 640]);
  S().setWindowFrame(small, BEFORE);
  assert.deepEqual(S().windows[small].frame, BEFORE);
  assert.deepEqual(S().settings.littleArdiaSize, [900, 640]);
});

test("other windows' frames still save as before", () => {
  const { small } = littleArdiaInIphoneMode();
  const other = S().createWindow({ kind: "small", url: "https://other.example/" });
  S().setWindowFrame(other, [0, 0, 700, 500]);
  assert.deepEqual(S().settings.littleArdiaSize, [700, 500]);
  assert.ok(useDeviceMode.getState().sessions[small]);
});

test("switching profile in iPhone mode opens the new window at the frame from before iPhone mode", () => {
  const { small } = littleArdiaInIphoneMode();
  S().setWindowFrame(small, PHONE);
  moveLittleArdiaToProfile(small, "work");
  const replacement = S().windowOrder.find((id) => id !== small && S().windows[id].kind === "small" && S().windows[id].profileId === "work");
  assert.ok(replacement);
  assert.deepEqual(S().windows[replacement].frame, BEFORE);
});
