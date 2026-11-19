import { create } from "zustand";
import { holdsFrame, NO_DEVICE_MODE, type DeviceModeState, type Frame } from "./session";

export const useDeviceMode = create<DeviceModeState>()(() => NO_DEVICE_MODE);

export const isDeviceModeFrame = (windowId: string, frame: Frame) => holdsFrame(useDeviceMode.getState(), windowId, frame, Date.now());

export const frameBeforeDeviceMode = (windowId: string): Frame | undefined => useDeviceMode.getState().sessions[windowId]?.restore ?? undefined;

export const windowShowsAsIphone = (windowId: string) => !!useDeviceMode.getState().sessions[windowId];
