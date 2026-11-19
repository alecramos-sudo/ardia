#include "../../../engine/ardiacore/src/ardia/core/ac_page_worlds.h"

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

static void ThePagesWorldPostsOnlyWhatItsShimsSend() {
  current_case = "the page's world posts only what its shims send";
  for (const char* kind : {"nowPlaying", "notification", "notificationClose", "displayMedia", "displayMediaHello",
                           "appBadge", "newTabLink", "drm", "pipTrace"})
    CHECK(PageWorldMayPost(PageWorld::kPage, kind));
  for (const char* kind : {"hello", "peek", "hideElement", "linkDrop", "selection", "theme", "scroll", "pinch",
                           "exclusive", "commandWheel", "firstPaint", "perf", "peekHello", "peekGone", "result", ""})
    CHECK(!PageWorldMayPost(PageWorld::kPage, kind));
}

static void ArdiasWorldPostsAnyKind() {
  current_case = "Ardia's world posts any kind";
  for (const char* kind : {"hello", "peek", "hideElement", "nowPlaying", "newTabLink"})
    CHECK(PageWorldMayPost(PageWorld::kArdia, kind));
}

static void EachCallReachesTheWorldThatHandlesIt() {
  current_case = "each call reaches the world that handles it, and config reaches both";
  for (const char* kind : {"media", "notification", "displayMedia"}) {
    CHECK(PageWorldReceives(PageWorld::kPage, kind));
    CHECK(!PageWorldReceives(PageWorld::kArdia, kind));
  }
  CHECK(PageWorldReceives(PageWorld::kPage, "config"));
  CHECK(PageWorldReceives(PageWorld::kArdia, "config"));
  for (const char* kind : {"peekConfig", "peekRefused", "firstPaint", "fieldTiming", "wakeFrames", "commandWheel",
                           "selectionPopover", "hideElement"}) {
    CHECK(PageWorldReceives(PageWorld::kArdia, kind));
    CHECK(!PageWorldReceives(PageWorld::kPage, kind));
  }
}

int main() {
  ThePagesWorldPostsOnlyWhatItsShimsSend();
  ArdiasWorldPostsAnyKind();
  EachCallReachesTheWorldThatHandlesIt();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("page worlds: all passed\n");
  return 0;
}
