#include "../ios/ArdiaDeviceStall.h"

#include <cstdio>

using namespace ardia_device_stall;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

int main() {
  CHECK(AfterStuckWait(true, true) == Step::leave);
  CHECK(AfterStuckWait(true, false) == Step::leave);
  CHECK(AfterStuckWait(false, false) == Step::leave);
  CHECK(AfterStuckWait(false, true) == Step::probe);

  CHECK(AfterProbe(true, true) == Step::fence);
  CHECK(AfterProbe(false, true) == Step::recycle);
  CHECK(AfterProbe(true, false) == Step::leave);
  CHECK(AfterProbe(false, false) == Step::leave);

  StartDeadline queued{10};
  CHECK(!queued.MaySend(10));
  CHECK(!queued.MaySend(9));
  StartDeadline live{10};
  CHECK(live.MaySend(9));
  CHECK(!live.MaySend(11));

  if (failures) return 1;
  std::printf("device-stall: ok\n");
  return 0;
}
