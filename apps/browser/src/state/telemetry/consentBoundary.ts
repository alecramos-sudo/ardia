import { setConsentEpoch } from "../../platform/focus";
import { consentEpoch, onConsentPeriodChange } from "./choice";
import { takeColdTabHoldCounts, takeContentDriftCounts, takeMainProcessWork } from "./diagnostics";
import { takeFreezeCounts } from "./freezes";
import { takeCrawlerTabsRefused } from "./crawlerTabsRefused";
import { resetLocalStoreMeters } from "./localStore";
import { resetPostStats } from "./transport";

let dropUsage = () => {};

onConsentPeriodChange(() => {
  setConsentEpoch(consentEpoch());
  dropUsage();
  resetLocalStoreMeters();
  resetPostStats();
  void takeMainProcessWork().catch(() => null);
  void takeContentDriftCounts().catch(() => null);
  void takeColdTabHoldCounts().catch(() => null);
  takeFreezeCounts(null);
  takeCrawlerTabsRefused();
});

export function watchConsentBoundary(drop: () => void) {
  dropUsage = drop;
  setConsentEpoch(consentEpoch());
}
