#pragma once

namespace ardia_device_stall {

enum class Step { leave, probe, fence, recycle };

struct StartDeadline {
  double until;
  bool expired = false;

  bool MaySend(double now) {
    expired = expired || now >= until;
    return !expired;
  }
};

inline bool FenceCleanupDue(bool cleaned, double now, double until) {
  return !cleaned && now >= until;
}

inline Step AfterStuckWait(bool cleanupAnswered, bool pageAlive) {
  return cleanupAnswered || !pageAlive ? Step::leave : Step::probe;
}

inline Step AfterProbe(bool probeAnswered, bool pageAlive) {
  if (!pageAlive) return Step::leave;
  return probeAnswered ? Step::fence : Step::recycle;
}

}
