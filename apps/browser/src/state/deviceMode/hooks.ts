import { useDeviceMode } from "./store";

export const useShowsAsIphone = (windowId: string) => useDeviceMode((s) => !!s.sessions[windowId]);
