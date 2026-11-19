export type Frame = [x: number, y: number, width: number, height: number];
type Size = readonly [width: number, height: number];

export type DeviceSession = { tabId: string; generation: number; phase: "starting" | "on"; restore: Frame | null; deviceSize: Size | null };
type HeldSize = { size: Size; until: number };
export type DeviceModeState = { sessions: Readonly<Record<string, DeviceSession>>; held: Readonly<Record<string, HeldSize>> };
export type EndCause = "desktop" | "closed" | "moved" | "tabChanged" | "engine";

export const NO_DEVICE_MODE: DeviceModeState = { sessions: {}, held: {} };
export const HOLD_FRAME_MS = 1500;
export const STOP_DEADLINE_MS = 3000;

const without = <T>(record: Readonly<Record<string, T>>, key: string) => {
  const { [key]: _, ...rest } = record;
  return rest;
};

const sameSize = (a: Size, b: Size) => Math.round(a[0]) === Math.round(b[0]) && Math.round(a[1]) === Math.round(b[1]);

export function begin(state: DeviceModeState, windowId: string, tabId: string, generation: number): DeviceModeState | null {
  if (state.sessions[windowId]) return null;
  return { sessions: { ...state.sessions, [windowId]: { tabId, generation, phase: "starting", restore: null, deviceSize: null } }, held: without(state.held, windowId) };
}

export const isCurrent = (state: DeviceModeState, windowId: string, generation: number) => state.sessions[windowId]?.generation === generation;

export function fit(state: DeviceModeState, windowId: string, generation: number, restore: Frame, device: Frame): DeviceModeState {
  const session = state.sessions[windowId];
  if (session?.generation !== generation || session.phase !== "starting") return state;
  return { ...state, sessions: { ...state.sessions, [windowId]: { ...session, restore, deviceSize: [device[2], device[3]] } } };
}

export function turnOn(state: DeviceModeState, windowId: string, generation: number): DeviceModeState {
  const session = state.sessions[windowId];
  if (session?.generation !== generation || session.phase !== "starting") return state;
  return { ...state, sessions: { ...state.sessions, [windowId]: { ...session, phase: "on" } } };
}

export function end(state: DeviceModeState, windowId: string, now: number): DeviceModeState {
  const session = state.sessions[windowId];
  if (!session) return state;
  const held = session.deviceSize ? { ...state.held, [windowId]: { size: session.deviceSize, until: now + HOLD_FRAME_MS } } : state.held;
  return { sessions: without(state.sessions, windowId), held };
}

export function holdsFrame(state: DeviceModeState, windowId: string, frame: Frame, now: number): boolean {
  if (state.sessions[windowId]) return true;
  const held = state.held[windowId];
  return !!held && now < held.until && sameSize(held.size, [frame[2], frame[3]]);
}

export const windowEmulating = (state: DeviceModeState, tabId: string) =>
  Object.entries(state.sessions).find(([, session]) => session.tabId === tabId)?.[0];

export type WindowFacts = { open: boolean; activeTabId: string | undefined; tabWindowId: string | undefined };

export function endCause(windowId: string, session: DeviceSession, facts: WindowFacts): EndCause | null {
  if (!facts.open || !facts.tabWindowId) return "closed";
  if (facts.tabWindowId !== windowId) return "moved";
  if (facts.activeTabId !== session.tabId) return "tabChanged";
  return null;
}
