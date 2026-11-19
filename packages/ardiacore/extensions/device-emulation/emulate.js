"use strict";

const sessions = new Map();
const starting = new Map();

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

async function apply(target, preset, canceled) {
  const send = async (method, params) => {
    if (canceled()) throw new EmulationError("canceled", "stopped while starting");
    await chrome.debugger.sendCommand(target, method, params);
    if (canceled()) throw new EmulationError("canceled", "stopped while starting");
  };
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

async function start(targetId, preset, opId) {
  if (typeof targetId !== "string" || !targetId) throw new EmulationError("noTarget", "no tab");
  if (typeof opId !== "string" || !opId) throw new EmulationError("noTarget", "no operation");
  const operation = { opId, canceled: false };
  starting.set(targetId, operation);
  const target = { targetId };
  const canceled = () => operation.canceled || starting.get(targetId) !== operation;
  const giveUp = async (code, message) => {
    if (sessions.get(targetId)?.opId === opId) {
      endSession(targetId, "failed");
      await chrome.debugger.detach(target).catch(() => {});
    }
    throw new EmulationError(code, message);
  };
  try {
    await pageTarget(targetId);
    if (canceled()) throw new EmulationError("canceled", "stopped while starting");
    if (!sessions.has(targetId)) {
      try {
        await chrome.debugger.attach(target, "1.3");
      } catch (e) {
        throw new EmulationError("attachRefused", String((e && e.message) || e));
      }
      if (!sessions.has(targetId)) sessions.set(targetId, { watchers: [], opId });
    }
    if (canceled()) return await giveUp("canceled", "stopped while starting");
    sessions.get(targetId).opId = opId;
    try {
      await apply(target, preset, canceled);
    } catch (e) {
      return await giveUp(e.code === "canceled" ? "canceled" : "attachRefused", String((e && e.message) || e));
    }
    if (canceled()) return await giveUp("canceled", "stopped while starting");
    return { targetId };
  } finally {
    if (starting.get(targetId) === operation) starting.delete(targetId);
  }
}

async function stop(targetId, opId) {
  const operation = starting.get(targetId);
  const wasStarting = operation?.opId === opId;
  if (wasStarting) {
    operation.canceled = true;
    if (sessions.get(targetId)?.opId === opId) endSession(targetId, "stopped");
    await chrome.debugger.detach({ targetId }).catch(() => {});
  }
  if (sessions.get(targetId)?.opId !== opId) return wasStarting;
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
    start: (post, targetId, preset, opId) => answer(post, start(targetId, preset, opId)),
    stop: (post, targetId, opId) => answer(post, stop(targetId, opId)),
    cancel: (post, targetId, opId) => answer(post, stop(targetId, opId)),
    watch: (post, targetId) => answer(post, watch(targetId)),
    sessions: (post) => answer(post, Promise.resolve([...sessions.keys()])),
  }),
});
