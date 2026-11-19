export type DesktopReloads = {
  owe(tabId: string): void;
  paid(tabId: string): void;
  settle(tabId: string): void;
  track<T>(tabId: string, stop: Promise<T>): Promise<T>;
};

export function createDesktopReloads(reload: (tabId: string) => void, emulating: (tabId: string) => boolean): DesktopReloads {
  const owed = new Set<string>();
  const stopping = new Map<string, number>();
  const settle = (tabId: string) => {
    if (!owed.has(tabId) || (stopping.get(tabId) ?? 0) > 0 || emulating(tabId)) return;
    owed.delete(tabId);
    reload(tabId);
  };
  return {
    owe(tabId) {
      owed.add(tabId);
      settle(tabId);
    },
    paid(tabId) {
      owed.delete(tabId);
    },
    settle,
    track(tabId, stop) {
      stopping.set(tabId, (stopping.get(tabId) ?? 0) + 1);
      return stop.finally(() => {
        const left = (stopping.get(tabId) ?? 1) - 1;
        if (left > 0) stopping.set(tabId, left);
        else stopping.delete(tabId);
        settle(tabId);
      });
    },
  };
}
