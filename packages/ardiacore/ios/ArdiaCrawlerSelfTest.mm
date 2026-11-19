#import "ArdiaCrawlerInternal.h"

#include <utility>

using namespace ardia_crawler;

namespace {

bool gTestDelayNext = false;

}

namespace ardia_crawler {

void TestDelayNextSelfTest() { gTestDelayNext = true; }

}

namespace {

constexpr double kSelfTestSeconds = 6;

constexpr int kBlockedByClient = -20;

constexpr int kAborted = -3;

NSMutableDictionary<NSString *, ArdiaCoreWindow *> *Windows() {
  static NSMutableDictionary *windows = [NSMutableDictionary dictionary];
  return windows;
}

NSMutableSet<ArdiaCrawlerSelfTest *> *Running() {
  static NSMutableSet *running = [NSMutableSet set];
  return running;
}

}

@implementation ArdiaCrawlerSelfTest {
  NSString *_name;
  ArdiaCoreTab *_tab;
  void (^_completion)(NSString *reason, NSString *detail);
}

+ (void)runInProfile:(ArdiaCoreProfile *)profile named:(NSString *)name completion:(void (^)(NSString *, NSString *))completion {
  if (std::exchange(gTestDelayNext, false)) {
    NSLog(@"[crawler] test: the self-test starts 3 s late");
    __weak ArdiaCoreProfile *weakProfile = profile;
    void (^done)(NSString *, NSString *) = [completion copy];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      if (ArdiaCoreProfile *p = weakProfile) [self runInProfile:p named:name completion:done];
      else done(kReasonOther, @"the profile went");
    });
    return;
  }
  ArdiaCrawlerSelfTest *test = [ArdiaCrawlerSelfTest new];
  test->_completion = [completion copy];
  test->_name = [name copy];
  [Running() addObject:test];
  ArdiaCoreWindow *window = Windows()[name];
  if (!window) {
    Windows()[name] = window = [[ArdiaCoreWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)];
    window.internal = YES;
  }
  test->_tab = [window openTab:kSelfTestURL profile:profile foreground:YES];
  if (!test->_tab) return [test finish:kReasonOther detail:@"the self-test tab didn't open"];
  test->_tab.delegate = test;
  __weak ArdiaCrawlerSelfTest *weakTest = test;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSelfTestSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakTest finish:kReasonTimeout detail:[NSString stringWithFormat:@"the self-test page neither loaded nor failed in %.0f s", kSelfTestSeconds]];
  });
}

+ (void)cancelInProfile:(NSString *)name {
  for (ArdiaCrawlerSelfTest *test in Running().allObjects)
    if ([test->_name isEqualToString:name]) [test finish:kReasonOther detail:@"cancelled"];
}

- (void)finish:(NSString *)reason detail:(NSString *)detail {
  void (^completion)(NSString *, NSString *) = _completion;
  if (!completion) return;
  _completion = nil;
  ArdiaCoreTab *tab = _tab;
  _tab = nil;
  tab.delegate = nil;
  [Running() removeObject:self];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!tab.closed) [tab closeNow];
    completion(reason, detail);
  });
}

- (void)tab:(ArdiaCoreTab *)tab didFailLoad:(NSString *)url code:(int)code description:(NSString *)text {
  if (tab != _tab || code == kAborted) return;
  if (code == kBlockedByClient) return [self finish:nil detail:nil];
  [self finish:kReasonSelfTestFailed detail:[NSString stringWithFormat:@"the self-test page failed with %d (%@), not ERR_BLOCKED_BY_CLIENT", code, text ?: @""]];
}

- (void)tabDidCommitDocument:(ArdiaCoreTab *)tab {
  if (tab != _tab || [tab.url hasPrefix:@"chrome-error:"] || !tab.url.length || [tab.url isEqualToString:@"about:blank"]) return;
  if (tab.committedHTTPStatus > 0) [self finish:kReasonSelfTestFailed detail:@"the self-test page loaded: the ruleset isn't blocking"];
}

- (void)tabDidChangeURL:(ArdiaCoreTab *)tab {
  if (tab == _tab && [ArdiaCrawler refusesURL:tab.url]) [self finish:kReasonOther detail:@"the self-test tab was sent to a NetLog page"];
}

- (void)tabWillClose:(ArdiaCoreTab *)tab {
  if (tab == _tab) [self finish:kReasonOther detail:@"the self-test tab closed"];
}

- (void)tab:(ArdiaCoreTab *)tab rendererGone:(NSString *)status code:(int)code {
  if (tab == _tab) [self finish:kReasonOther detail:[@"the self-test renderer went: " stringByAppendingString:status ?: @""]];
}

@end
