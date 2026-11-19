import { displayUrl } from "@ardia/core";
import { pickFiles } from "../../state/app/system";
import { chooseFromMenu } from "../../state/app/menuChoice";
import { otherOpenTabs, switchFromBar } from "../../state/omnibox/openFromBar";
import { ADD_CHIP } from "./tokens";

export async function openTabOrFile(windowId: string, tabId: string, onGo: (url: string) => void) {
  const others = otherOpenTabs(windowId, ADD_CHIP.otherTabs);
  const choice = await chooseFromMenu<{ tab: string }, "files">([
    ...others.map((t) => ({ value: { tab: t.id }, title: t.title || displayUrl(t.url) })),
    ...(others.length ? [{ separator: true as const }] : []),
    { id: "files", title: "Open File…", symbol: "doc" },
  ]);
  if (choice && typeof choice === "object") switchFromBar(choice.tab, "", tabId, "current");
  if (choice === "files") {
    const [file] = await pickFiles();
    if (file) onGo(file);
  }
}
