import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");

const BEFORE = [100, 200, 900, 640];
const PHONE = [100, -81, 420, 921];
const native = { frame: BEFORE, pending: [], calls: [], holdStops: false };

function answer(verb, args) {
  if (verb === "fitWindowToPage") {
    const previous = native.frame;
    native.frame = PHONE;
    return { held: true, value: { previous, frame: PHONE, scale: 1 } };
  }
  if (verb === "setTabWindowFrame") {
    native.frame = [args.x, args.y, args.width, args.height];
    return { held: false, value: true };
  }
  if (verb === "startDeviceMode") return { held: true, value: null };
  if (verb === "stopDeviceMode") return { held: native.holdStops, value: true };
  if (verb === "deviceModeTabs") return { held: false, value: [] };
  return null;
}

globalThis.acTestTabStrip = { listen: () => ({ remove() {} }), command: () => null, snapshot: async () => null };
globalThis.acTestNativeModules = {
  ArdiaTabs: {
    ...ardiaCoreNativeModules.ArdiaTabs,
    call(verb, profile, json) {
      const args = JSON.parse(json);
      const reply = answer(verb, args);
      if (!reply) return ardiaCoreNativeModules.ArdiaTabs.call(verb, profile, json);
      native.calls.push(verb);
      return new Promise((resolve) => {
        if (!reply.held) return resolve(JSON.stringify(reply.value));
        native.pending.push({ verb, release: (value = reply.value) => resolve(JSON.stringify(value)) });
      });
    },
  },
};

await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { toggleDeviceMode } = await import("./deviceMode.ts");
const { useDeviceMode } = await import("./store.ts");
const { STOP_DEADLINE_MS } = await import("./session.ts");
const { webviews } = await import("../../platform/webviews.ts");
const reloads = [];

const S = () => useBrowser.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

function littleArdia() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  S().createWindow({ url: "https://main.example/" });
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  useDeviceMode.setState({ sessions: {}, held: {} }, true);
  Object.assign(native, { frame: BEFORE, pending: [], calls: [], holdStops: false });
  const tabId = S().windows[small].tabIds[0];
  webviews.set(tabId, { reload: () => reloads.push(tabId) });
  return small;
}

async function releaseAll(startAnswer) {
  for (let i = 0; i < 50 && native.pending.length; i++) {
    const next = native.pending.shift();
    if (next.verb === "startDeviceMode") next.release(startAnswer(native.pending.some((p) => p.verb === "startDeviceMode")));
    else next.release();
    await flush();
  }
  assert.equal(native.pending.length, 0);
}

const OK = { targetId: "T" };

test("on → off → on while the first start is still out: the late failure of the first leaves the second on, and Desktop restores the original frame", async () => {
  const small = littleArdia();
  toggleDeviceMode(small);
  await flush();
  toggleDeviceMode(small);
  await flush();
  toggleDeviceMode(small);
  await flush();
  await releaseAll((another) => (another ? { error: "timeout" } : OK));
  const session = useDeviceMode.getState().sessions[small];
  assert.equal(session?.phase, "on");
  assert.deepEqual(session.restore, BEFORE);
  toggleDeviceMode(small);
  await flush();
  assert.deepEqual(native.frame, BEFORE);
});

test("on → off → on with both starts succeeding: one session, the original frame kept, and no stop aimed at the live session", async () => {
  const small = littleArdia();
  toggleDeviceMode(small);
  await flush();
  toggleDeviceMode(small);
  await flush();
  toggleDeviceMode(small);
  await flush();
  const stopsBefore = native.calls.filter((c) => c === "stopDeviceMode").length;
  await releaseAll(() => OK);
  const session = useDeviceMode.getState().sessions[small];
  assert.equal(session?.phase, "on");
  assert.deepEqual(session.restore, BEFORE);
  const lastStart = native.calls.lastIndexOf("startDeviceMode");
  assert.equal(native.calls.slice(lastStart).filter((c) => c === "stopDeviceMode").length, 0);
  assert.ok(native.calls.filter((c) => c === "stopDeviceMode").length >= stopsBefore);
  toggleDeviceMode(small);
  await flush();
  assert.deepEqual(native.frame, BEFORE);
});

test("off while the window is still being sized: the frame comes back once the sizing answers", async () => {
  const small = littleArdia();
  toggleDeviceMode(small);
  await flush();
  toggleDeviceMode(small);
  await flush();
  await releaseAll(() => OK);
  assert.deepEqual(useDeviceMode.getState().sessions, {});
  assert.deepEqual(native.frame, BEFORE);
});

for (const late of [{ error: "timeout" }, OK]) {
  test(`the first start already sized, then off → on, then its start answers late with ${late.error ?? "success"}: the second session stays on at the original frame`, async () => {
    const small = littleArdia();
    toggleDeviceMode(small);
    await flush();
    native.pending.shift().release();
    await flush();
    assert.equal(native.pending[0]?.verb, "startDeviceMode");
    const firstStart = native.pending.shift();
    toggleDeviceMode(small);
    await flush();
    assert.deepEqual(native.frame, BEFORE);
    toggleDeviceMode(small);
    await flush();
    firstStart.release(late);
    await flush();
    await releaseAll(() => OK);
    const session = useDeviceMode.getState().sessions[small];
    assert.equal(session?.phase, "on");
    assert.deepEqual(session.restore, BEFORE);
    const lastStart = native.calls.lastIndexOf("startDeviceMode");
    assert.equal(native.calls.slice(lastStart).includes("stopDeviceMode"), false);
  });
}

test("a stop that never answers holds the window's next start only until its deadline, and that start measures the original frame", async () => {
  const small = littleArdia();
  toggleDeviceMode(small);
  await flush();
  await releaseAll(() => OK);
  assert.equal(useDeviceMode.getState().sessions[small]?.phase, "on");
  native.holdStops = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const tabId = S().windows[small].tabIds[0];
    const reloadsBefore = reloads.filter((t) => t === tabId).length;
    toggleDeviceMode(small);
    await settle();
    assert.deepEqual(native.frame, BEFORE);
    toggleDeviceMode(small);
    for (let i = 0; i < 5; i++) await settle();
    const fitsBefore = native.calls.filter((c) => c === "fitWindowToPage").length;
    mock.timers.tick(STOP_DEADLINE_MS - 1);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(native.calls.filter((c) => c === "fitWindowToPage").length, fitsBefore);
    mock.timers.tick(1);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(native.calls.filter((c) => c === "fitWindowToPage").length, fitsBefore + 1);
    assert.equal(reloads.filter((t) => t === tabId).length, reloadsBefore, "no reload while the tab may still be emulated");
    const fitting = native.pending.findIndex((p) => p.verb === "fitWindowToPage");
    native.pending.splice(fitting, 1)[0].release();
    for (let i = 0; i < 5; i++) await settle();
    const starting = native.pending.findIndex((p) => p.verb === "startDeviceMode");
    native.pending.splice(starting, 1)[0].release(OK);
    for (let i = 0; i < 5; i++) await settle();
  } finally {
    mock.timers.reset();
  }
  const session = useDeviceMode.getState().sessions[small];
  assert.equal(session?.phase, "on");
  assert.deepEqual(session.restore, BEFORE);
  const tabId = S().windows[small].tabIds[0];
  const reloadsBeforeAnswer = reloads.filter((t) => t === tabId).length;
  native.pending.filter((p) => p.verb === "stopDeviceMode").forEach((p) => p.release());
  await flush();
  assert.equal(reloads.filter((t) => t === tabId).length, reloadsBeforeAnswer + 1, "the reload comes once the stop answers");
  assert.equal(useDeviceMode.getState().sessions[small]?.phase, "on");
});
