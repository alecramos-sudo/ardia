#include "../../../engine/ardiacore/src/ardia/core/ac_page_message_budget.h"

#include <cstdio>

using namespace ardiacore;

static int failures = 0;
static const char* current_case = "";
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    if (!(cond)) {                                                                     \
      std::printf("FAIL %s: %s:%d: %s\n", current_case, __FILE__, __LINE__, #cond);   \
      failures++;                                                                      \
    }                                                                                  \
  } while (0)

static int Admitted(PageMessageBudget& frame, PageMessageBudget& tab, double now, int count, size_t bytes = 64) {
  int admitted = 0;
  for (int i = 0; i < count; i++) {
    if (AdmitPageMessage(frame, tab, now, bytes)) admitted++;
  }
  return admitted;
}

static void AFrameGetsItsBurstAtOnceThenNothingMoreInTheSameInstant() {
  current_case = "a frame gets its burst at once, then nothing more in the same instant";
  PageMessageBudget frame(kFramePageMessageRate);
  PageMessageBudget tab(kTabPageMessageRate);
  CHECK(Admitted(frame, tab, 10, 10000) == static_cast<int>(kFramePageMessageRate.message_burst));
  CHECK(!AdmitPageMessage(frame, tab, 10, 64));
}

static void AFrameRefillsAtItsRateUpToItsBurst() {
  current_case = "a frame refills at its rate, up to its burst";
  PageMessageBudget frame(kFramePageMessageRate);
  PageMessageBudget tab(kTabPageMessageRate);
  Admitted(frame, tab, 0, 10000);
  CHECK(Admitted(frame, tab, 0.5, 10000) == static_cast<int>(kFramePageMessageRate.messages_per_second / 2));
  PageMessageBudget idle(kFramePageMessageRate);
  PageMessageBudget idle_tab(kTabPageMessageRate);
  Admitted(idle, idle_tab, 0, 1);
  CHECK(Admitted(idle, idle_tab, 3600, 10000) == static_cast<int>(kFramePageMessageRate.message_burst));
}

static void ALegitimateSteadyStreamIsNeverDropped() {
  current_case = "a steady stream at 120 messages a second, as a Command-scroll sends, is never dropped";
  PageMessageBudget frame(kFramePageMessageRate);
  PageMessageBudget tab(kTabPageMessageRate);
  int admitted = 0;
  for (int i = 0; i < 1200; i++) admitted += AdmitPageMessage(frame, tab, i / 120.0, 256) ? 1 : 0;
  CHECK(admitted == 1200);
}

static void BigMessagesSpendTheByteBudget() {
  current_case = "big messages spend the byte budget before the message count";
  PageMessageBudget frame(kFramePageMessageRate);
  PageMessageBudget tab(kTabPageMessageRate);
  const size_t big = 1280 * 1024;
  const int fit = static_cast<int>(kFramePageMessageRate.byte_burst / big);
  CHECK(Admitted(frame, tab, 0, 100, big) == fit);
  CHECK(AdmitPageMessage(frame, tab, 0, 64));
}

static void ManyFramesShareTheTabsBudget() {
  current_case = "many frames together get no more than the tab's budget";
  PageMessageBudget tab(kTabPageMessageRate);
  int admitted = 0;
  for (int f = 0; f < 50; f++) {
    PageMessageBudget frame(kFramePageMessageRate);
    admitted += Admitted(frame, tab, 0, 10000);
  }
  CHECK(admitted == static_cast<int>(kTabPageMessageRate.message_burst));
}

static void AFrameTheTabRefusesKeepsItsOwnTokens() {
  current_case = "a message the tab refuses costs the frame nothing";
  PageMessageBudget tab(kTabPageMessageRate);
  PageMessageBudget greedy(kFramePageMessageRate);
  PageMessageBudget other(kFramePageMessageRate);
  Admitted(greedy, tab, 0, 10000);
  Admitted(other, tab, 0, 10000);
  CHECK(Admitted(other, tab, 0, 10000) == 0);
  PageMessageBudget quiet(kFramePageMessageRate);
  CHECK(Admitted(quiet, tab, 0, 10) == 0);
  CHECK(Admitted(quiet, tab, 1, 10000) == static_cast<int>(kFramePageMessageRate.message_burst));
}

static void TimeGoingBackwardsAddsNothing() {
  current_case = "a clock that goes backwards adds no tokens";
  PageMessageBudget frame(kFramePageMessageRate);
  PageMessageBudget tab(kTabPageMessageRate);
  Admitted(frame, tab, 100, 10000);
  CHECK(Admitted(frame, tab, 50, 10000) == 0);
  CHECK(Admitted(frame, tab, 100, 10000) == 0);
}

int main() {
  AFrameGetsItsBurstAtOnceThenNothingMoreInTheSameInstant();
  AFrameRefillsAtItsRateUpToItsBurst();
  ALegitimateSteadyStreamIsNeverDropped();
  BigMessagesSpendTheByteBudget();
  ManyFramesShareTheTabsBudget();
  AFrameTheTabRefusesKeepsItsOwnTokens();
  TimeGoingBackwardsAddsNothing();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("page message budget ok\n");
  return 0;
}
