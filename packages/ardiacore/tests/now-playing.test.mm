#import "../ios/ArdiaNowPlaying.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static NSDictionary *Playing(NSString *title, BOOL controllable) {
  return @{@"title" : title, @"playbackState" : @"playing", @"controllable" : @(controllable)};
}

static NSDictionary *Paused(NSString *title) {
  return @{@"title" : title, @"playbackState" : @"paused", @"controllable" : @YES};
}

static BOOL Same(NSString *a, NSString *b) {
  return a == b || [a isEqualToString:b];
}

static void AnAdFrameThatIsNotRoutedNeverTakesThePlayer() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"1:1" page:Paused(@"article video") main:YES routedTo:@"1:1"];
  [np noteFrame:@"2:7" page:Playing(@"ad", YES) main:NO routedTo:@"1:1"];
  CHECK(Same(np.frame, @"1:1"));
  CHECK([np.selected[@"title"] isEqual:@"article video"]);
}

static void AnAdFrameAloneIsNotTheTabsPlayerWhenTheSessionRoutesNowhere() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  CHECK([np noteFrame:@"2:7" page:Playing(@"ad", YES) main:NO routedTo:nil] == nil);
  CHECK(np.frame == nil);
  CHECK(!np.isEmpty);
}

static void AnEmbeddedPlayerTheSessionRoutesToIsTheTabsPlayer() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"3:2" page:Playing(@"embedded song", YES) main:NO routedTo:@"3:2"];
  CHECK(Same(np.frame, @"3:2"));
  CHECK([np.selected[@"title"] isEqual:@"embedded song"]);
}

static void AFrameThatReportedEarlyTakesThePlayerOnceTheSessionRoutesToIt() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"3:2" page:Playing(@"embedded song", YES) main:NO routedTo:nil];
  CHECK(np.frame == nil);
  CHECK([np routeTo:@"3:2"]);
  CHECK(Same(np.frame, @"3:2"));
  CHECK(![np routeTo:@"3:2"]);
}

static void ThePlayerLeavesAFrameTheSessionNoLongerRoutesTo() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"1:1" page:Paused(@"main") main:YES routedTo:@"3:2"];
  [np noteFrame:@"3:2" page:Playing(@"embedded", YES) main:NO routedTo:@"3:2"];
  CHECK(Same(np.frame, @"3:2"));
  CHECK([np routeTo:@"1:1"]);
  CHECK(Same(np.frame, @"1:1"));
}

static void TheMainFrameStillWinsATieWithTheRoutedFrame() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"1:1" page:Playing(@"main", YES) main:YES routedTo:@"3:2"];
  [np noteFrame:@"3:2" page:Playing(@"embedded", YES) main:NO routedTo:@"3:2"];
  CHECK(Same(np.frame, @"1:1"));
}

static void AClearedReportHandsThePlayerToAnotherAllowedFrame() {
  ArdiaNowPlaying *np = [ArdiaNowPlaying new];
  [np noteFrame:@"1:1" page:Paused(@"main") main:YES routedTo:@"3:2"];
  [np noteFrame:@"3:2" page:Playing(@"embedded", YES) main:NO routedTo:@"3:2"];
  [np noteFrame:@"2:7" page:Playing(@"ad", YES) main:NO routedTo:@"3:2"];
  [np noteFrame:@"3:2" page:nil main:NO routedTo:@"3:2"];
  CHECK(Same(np.frame, @"1:1"));
  [np noteFrame:@"1:1" page:nil main:YES routedTo:@"3:2"];
  CHECK(np.frame == nil);
  CHECK(np.selected == nil);
}

int main() {
  @autoreleasepool {
    AnAdFrameThatIsNotRoutedNeverTakesThePlayer();
    AnAdFrameAloneIsNotTheTabsPlayerWhenTheSessionRoutesNowhere();
    AnEmbeddedPlayerTheSessionRoutesToIsTheTabsPlayer();
    AFrameThatReportedEarlyTakesThePlayerOnceTheSessionRoutesToIt();
    ThePlayerLeavesAFrameTheSessionNoLongerRoutesTo();
    TheMainFrameStillWinsATieWithTheRoutedFrame();
    AClearedReportHandsThePlayerToAnotherAllowedFrame();
  }
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("now playing ok\n");
  return 0;
}
