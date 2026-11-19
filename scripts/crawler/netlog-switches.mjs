export function appSwitches(list) {
  return ` ${list.join(" ")}`.split(" --").map((item) => item.trim()).filter(Boolean).map((item) => `--${item}`);
}

export function netLogSwitchIn(list) {
  const names = [...appSwitches(list), ...list.join(" ").split(/\s+/)].map((piece) => piece.replace(/^-+/, "").split("=")[0].toLowerCase());
  return names.find((name) => name.startsWith("log-net-log") || name.startsWith("net-log")) ?? null;
}
