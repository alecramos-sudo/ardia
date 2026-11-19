import assert from "node:assert/strict";
import { test } from "node:test";

const { begin, end, endCause, fit, holdsFrame, HOLD_FRAME_MS, NO_DEVICE_MODE, turnOn, windowEmulating } = await import("./session.ts");
const { IPHONE, emulatesUrl, iphonePreset } = await import("./preset.ts");

const BEFORE = [100, 200, 900, 640];
const PHONE = [100, -82, 418, 922];

function onState() {
  const started = begin(NO_DEVICE_MODE, "w1", "t1");
  return turnOn(fit(started, "w1", "t1", BEFORE, PHONE), "w1", "t1");
}

test("the iPhone preset is a current iPhone in Safari, at full size unless the screen is too short", () => {
  assert.equal(IPHONE.width, 402);
  assert.equal(IPHONE.height, 874);
  assert.equal(IPHONE.deviceScaleFactor, 3);
  assert.match(IPHONE.userAgent, /^Mozilla\/5\.0 \(iPhone; CPU iPhone OS \d+_\d+ like Mac OS X\) AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\) Version\/26\.\d+ Mobile\/\w+ Safari\/604\.1$/);
  assert.equal(IPHONE.platform, "iPhone");
  assert.equal(iphonePreset().scale, 1);
  assert.equal(iphonePreset(0.8).scale, 0.8);
  assert.equal(iphonePreset(4).scale, 1);
  assert.equal(iphonePreset(0).scale, 0.25);
  assert.equal(iphonePreset(Number.NaN).scale, 1);
});

test("only http and https pages can show as an iPhone", () => {
  assert.equal(emulatesUrl("https://example.com/"), true);
  assert.equal(emulatesUrl("HTTP://localhost:3000"), true);
  for (const url of ["", undefined, "about:blank", "file:///tmp/a.html", "chrome://settings", "ardia://newtab", "data:text/html,hi"]) assert.equal(emulatesUrl(url), false, url);
});

test("a window goes starting → fitted → on, and a second start while one runs is refused", () => {
  const started = begin(NO_DEVICE_MODE, "w1", "t1");
  assert.deepEqual(started.sessions.w1, { tabId: "t1", phase: "starting", restore: null, deviceSize: null });
  assert.equal(begin(started, "w1", "t1"), null);
  const fitted = fit(started, "w1", "t1", BEFORE, PHONE);
  assert.deepEqual(fitted.sessions.w1, { tabId: "t1", phase: "starting", restore: BEFORE, deviceSize: [418, 922] });
  assert.equal(turnOn(fitted, "w1", "t1").sessions.w1.phase, "on");
  assert.ok(begin(started, "w2", "t2").sessions.w2);
});

test("an answer for a session that ended or changed tab is ignored", () => {
  const started = begin(NO_DEVICE_MODE, "w1", "t1");
  assert.equal(fit(started, "w1", "other", BEFORE, PHONE), started);
  assert.equal(turnOn(started, "w9", "t1"), started);
  const ended = end(started, "w1", 0);
  assert.equal(fit(ended, "w1", "t1", BEFORE, PHONE), ended);
  assert.equal(turnOn(ended, "w1", "t1"), ended);
});

test("while on, every frame of the window is held out of the saved Little Ardia size", () => {
  const on = onState();
  assert.equal(holdsFrame(on, "w1", PHONE, 0), true);
  assert.equal(holdsFrame(on, "w1", [5, 5, 1000, 700], 0), true);
  assert.equal(holdsFrame(on, "w2", PHONE, 0), false);
});

test("after it ends, a late report of the iPhone size is still held, the restored frame isn't, and the hold expires", () => {
  const ended = end(onState(), "w1", 1000);
  assert.deepEqual(ended.sessions, {});
  assert.equal(holdsFrame(ended, "w1", [0, 0, 418.2, 921.6], 1000), true);
  assert.equal(holdsFrame(ended, "w1", BEFORE, 1000), false);
  assert.equal(holdsFrame(ended, "w1", PHONE, 1000 + HOLD_FRAME_MS), false);
});

test("a session ended before the window was fitted holds nothing", () => {
  const ended = end(begin(NO_DEVICE_MODE, "w1", "t1"), "w1", 0);
  assert.equal(holdsFrame(ended, "w1", PHONE, 0), false);
  assert.equal(end(ended, "w1", 0), ended);
});

test("starting again clears the hold from the last session", () => {
  const again = begin(end(onState(), "w1", 0), "w1", "t1");
  assert.deepEqual(again.held, {});
});

test("the window that emulates a tab is found by tab", () => {
  const on = onState();
  assert.equal(windowEmulating(on, "t1"), "w1");
  assert.equal(windowEmulating(on, "t2"), undefined);
});

test("iPhone mode ends when the window closes, the tab leaves it or another tab takes its place, and holds through navigations", () => {
  const session = onState().sessions.w1;
  const facts = { open: true, activeTabId: "t1", tabWindowId: "w1" };
  assert.equal(endCause("w1", session, facts), null);
  assert.equal(endCause("w1", session, { ...facts, open: false }), "closed");
  assert.equal(endCause("w1", session, { ...facts, tabWindowId: undefined, activeTabId: undefined }), "closed");
  assert.equal(endCause("w1", session, { ...facts, tabWindowId: "main", activeTabId: undefined }), "moved");
  assert.equal(endCause("w1", session, { ...facts, activeTabId: "t2" }), "tabChanged");
});
