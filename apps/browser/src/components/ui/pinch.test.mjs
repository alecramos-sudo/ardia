import assert from "node:assert/strict";
import { test } from "node:test";
const { PINCH_CLOSE_AT, PINCH_OPEN_AT, pinchFollow, pinchGesture, pinchOutcome, pinchShrink, pinchStep } = await import("./pinch.ts");

test("a small pinch either way springs back; only a deliberate one opens or closes", () => {
  for (const m of [0, 0.05, -0.05, 0.1, -0.1, 0.2, -0.2, PINCH_OPEN_AT - 0.01, PINCH_CLOSE_AT + 0.01]) assert.equal(pinchOutcome(m), "stay", `${m}`);
  assert.equal(pinchOutcome(PINCH_OPEN_AT), "open");
  assert.equal(pinchOutcome(0.8), "open");
  assert.equal(pinchOutcome(PINCH_CLOSE_AT), "close");
  assert.equal(pinchOutcome(-0.7), "close");
});

test("the card follows the fingers: a pinch shrinks it at the fingers' scale, a spread grows it toward the tab", () => {
  assert.deepEqual(pinchFollow(0, 0.12), { progress: 1, expand: 0 });
  const pinched = pinchFollow(-0.25, 0.12);
  assert.equal(pinched.expand, 0);
  assert.ok(Math.abs(0.12 + 0.88 * pinched.progress - 0.75) < 1e-9);
  assert.deepEqual(pinchFollow(-2, 0.12), { progress: 0, expand: 0 });
  assert.deepEqual(pinchFollow(0.2, 0.12), { progress: 1, expand: 0.5 });
  assert.deepEqual(pinchFollow(3, 0.12), { progress: 1, expand: 1 });
  let last = -1;
  for (let m = 0; m <= 0.5; m += 0.05) {
    const { expand } = pinchFollow(m, 0.12);
    assert.ok(expand >= last);
    last = expand;
  }
});

test("a window shrinks at the fingers' scale when pinched and never grows when spread", () => {
  assert.equal(pinchShrink(0, 0.6), 1);
  assert.ok(Math.abs(pinchShrink(-0.2, 0.6) - 0.8) < 1e-9);
  assert.equal(pinchShrink(-0.9, 0.6), 0.6);
  assert.equal(pinchShrink(0.2, 0.6), 1);
  assert.equal(pinchShrink(5, 0.6), 1);
});

function recorder({ reduce = false, idle = false, open = true, accepts } = {}) {
  const calls = [];
  const step = pinchGesture();
  const motion = {
    reduce,
    idle: () => idle,
    ...(accepts ? { accepts } : {}),
    begin: () => calls.push("begin"),
    follow: (m) => calls.push(`follow ${m}`),
    settle: () => calls.push("settle"),
    ...(open ? { open: () => calls.push("open") } : {}),
    close: () => calls.push("close"),
  };
  return { calls, run: (steps) => steps.forEach(([phase, m]) => pinchStep(motion, phase, m)), gesture: (steps) => steps.forEach(([phase, m]) => step(motion, phase, m)) };
}

test("a gesture follows live, then commits past a threshold or settles back", () => {
  const spring = recorder();
  spring.run([["began", 0], ["changed", -0.1], ["ended", -0.1]]);
  assert.deepEqual(spring.calls, ["begin", "follow 0", "follow -0.1", "settle"]);
  const closing = recorder();
  closing.run([["began", 0], ["changed", -0.3], ["ended", -0.3]]);
  assert.deepEqual(closing.calls.at(-1), "close");
  const opening = recorder();
  opening.run([["began", 0], ["changed", 0.35], ["ended", 0.35]]);
  assert.deepEqual(opening.calls.at(-1), "open");
  const cancelled = recorder();
  cancelled.run([["began", 0], ["changed", 0.5], ["cancelled", 0.5]]);
  assert.deepEqual(cancelled.calls.at(-1), "settle");
});

test("with Reduce Motion nothing follows the fingers and only the thresholds act", () => {
  const still = recorder({ reduce: true });
  still.run([["began", 0], ["changed", -0.1], ["ended", -0.1], ["began", 0], ["ended", -0.3]]);
  assert.deepEqual(still.calls, ["close"]);
  const gone = recorder({ idle: true });
  gone.run([["began", 0], ["ended", 0.5]]);
  assert.deepEqual(gone.calls, []);
});

test("without an open, a deliberate spread only settles back", () => {
  const noOpen = recorder({ open: false });
  noOpen.run([["began", 0], ["changed", 0.5], ["ended", 0.5]]);
  assert.deepEqual(noOpen.calls.at(-1), "settle");
  assert.ok(!noOpen.calls.includes("open"));
});

test("a gesture is accepted or left alone as a whole, decided when it begins", () => {
  let normal = false;
  const gate = recorder({ accepts: () => normal });
  gate.gesture([["began", 0], ["changed", -0.3], ["ended", -0.3]]);
  assert.deepEqual(gate.calls, []);
  normal = true;
  gate.gesture([["changed", -0.4], ["ended", -0.4]]);
  assert.deepEqual(gate.calls, []);
  gate.gesture([["began", 0], ["changed", -0.3], ["ended", -0.3]]);
  assert.deepEqual(gate.calls.at(-1), "close");
  const always = recorder();
  always.gesture([["began", 0], ["ended", -0.3]]);
  assert.deepEqual(always.calls.at(-1), "close");
});
