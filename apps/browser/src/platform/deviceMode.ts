import { call, on, type EngineCalls, type EngineEvents } from "@ardia/ardiacore";

export type DevicePreset = EngineCalls["tabs.startDeviceMode"][0]["preset"];
export type DeviceModeStartResult = EngineCalls["tabs.startDeviceMode"][1] & { sent?: boolean };
export type DeviceModeFailure = Extract<EngineCalls["tabs.startDeviceMode"][1], { error: unknown }>["error"];
export type DeviceModeEnded = EngineEvents["tabs.deviceModeEnded"];
export type DeviceModeEndReason = DeviceModeEnded["reason"];
export type WindowFrame = readonly [x: number, y: number, width: number, height: number];

export const startDeviceEmulation = (tabId: string, preset: DevicePreset): Promise<DeviceModeStartResult> => call("tabs.startDeviceMode", { tabId, preset });
export const stopDeviceEmulation = (tabId: string) => call("tabs.stopDeviceMode", { tabId });
export const emulatedTabs = () => call("tabs.deviceModeTabs", {});
export const fitWindowToPage = (tabId: string, width: number, height: number) => call("tabs.fitWindowToPage", { tabId, width, height });
export const setTabWindowFrame = (tabId: string, [x, y, width, height]: WindowFrame) => call("tabs.setTabWindowFrame", { tabId, x, y, width, height });
export const onDeviceEmulationEnded = (listener: (e: DeviceModeEnded) => void) => on("tabs.deviceModeEnded", listener);
