"use strict";

const sessions = new Map();

class EmulationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isWebUrl = (url) => /^https?:\/\//i.test(url || "");

function endSession(targetId, reason) {
  const session = sessions.get(targetId);
  if (!session) return;
  sessions.delete(targetId);
  for (const resolve of session.watchers) resolve(reason);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.targetId) endSession(source.targetId, reason === "canceled_by_user" ? "canceled" : "detached");
});

chrome.debugger.onEvent.addListener((source, method) => {
  if (!source.targetId || !sessions.has(source.targetId)) return;
  if (method === "Inspector.targetCrashed") {
    const target = { targetId: source.targetId };
    endSession(source.targetId, "crashed");
    chrome.debugger.detach(target).catch(() => {});
  }
});

async function pageTarget(targetId) {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find((t) => t.id === targetId);
  if (!target || target.type !== "page") throw new EmulationError("noTarget", "no such tab");
  if (!isWebUrl(target.url)) throw new EmulationError("notHttp", "only http and https pages");
  return target;
}

async function apply(target, preset) {
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  await send("Inspector.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: true,
    scale: preset.scale,
    screenWidth: preset.width,
    screenHeight: preset.height,
    positionX: 0,
    positionY: 0,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: preset.maxTouchPoints });
  await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await send("Emulation.setUserAgentOverride", { userAgent: preset.userAgent, platform: preset.platform });
  await send("Page.reload", {});
}

async function start(targetId, preset) {
  if (typeof targetId !== "string" || !targetId) throw new EmulationError("noTarget", "no tab");
  await pageTarget(targetId);
  const target = { targetId };
  if (!sessions.has(targetId)) {
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (e) {
      throw new EmulationError("attachRefused", String((e && e.message) || e));
    }
    sessions.set(targetId, { watchers: [] });
  }
  try {
    await apply(target, preset);
  } catch (e) {
    endSession(targetId, "failed");
    await chrome.debugger.detach(target).catch(() => {});
    throw new EmulationError("attachRefused", String((e && e.message) || e));
  }
  return { targetId };
}

async function stop(targetId) {
  if (!sessions.has(targetId)) return false;
  endSession(targetId, "stopped");
  await chrome.debugger.detach({ targetId }).catch(() => {});
  return true;
}

function watch(targetId) {
  const session = sessions.get(targetId);
  if (!session) return Promise.resolve("detached");
  return new Promise((resolve) => session.watchers.push(resolve));
}

const answer = (post, promise) =>
  promise.then(
    (value) => post("result", JSON.stringify({ value })),
    (e) => post("result", JSON.stringify({ error: `${(e && e.code) || "failed"}: ${(e && e.message) || e}` })),
  );

Object.defineProperty(globalThis, "ardiaDeviceEmulation", {
  value: Object.freeze({
    start: (post, targetId, preset) => answer(post, start(targetId, preset)),
    stop: (post, targetId) => answer(post, stop(targetId)),
    watch: (post, targetId) => answer(post, watch(targetId)),
    sessions: (post) => answer(post, Promise.resolve([...sessions.keys()])),
  }),
});
