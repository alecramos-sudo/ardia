#import "ArdiaCrawlerInternal.h"
#import "ArdiaHostInternal.h"
#import "ArdiaContentBlockerInternal.h"
#import "ArdiaServices.h"
#import "ArdiaWebViewInternal.h"
#import "ArdiaWindowController.h"

#include <unistd.h>

using namespace ardia_crawler;

namespace {

constexpr int kNotReadyExitCode = 78;

constexpr double kFailClosedSeconds = 5;

constexpr double kDestroyedSeconds = 6;

constexpr double kDestroyedPollMs = 100;

constexpr double kClearDeadlineSeconds = 20;

NSTimeInterval Monotonic() { return NSProcessInfo.processInfo.systemUptime; }

void (^gWebKitContainment)(NSString *, void (^)(void));

void (^gWebKitClear)(NSString *, void (^)(void));

BOOL (^gWebKitHasPages)(NSString *);

bool OfProfile(ArdiaCoreProfile *profile, NSString *name) {
  return profile && (!name || [ardia_host::OriginalProfileNameOf(profile) isEqualToString:name]);
}

NSArray<ArdiaCoreTab *> *TabsOf(NSString *name) {
  NSMutableArray<ArdiaCoreTab *> *tabs = [NSMutableArray array];
  for (ArdiaCoreProfile *profile in ardia_host::LoadedProfiles()) {
    if (!OfProfile(profile, name)) continue;
    for (ArdiaWindowController *controller in ArdiaWindowController.all)
      for (ArdiaCoreTab *tab in [controller.coreWindow tabsForProfile:profile] ?: @[])
        if (![tabs containsObject:tab]) [tabs addObject:tab];
  }
  for (ArdiaCoreTab *tab in ardia_host::PopupTabs())
    if (OfProfile(tab.profile, name) && ![tabs containsObject:tab]) [tabs addObject:tab];
  return tabs;
}

bool Destroyed(ArdiaCoreTab *tab) { return tab.view == nil; }

void WhenDestroyed(NSArray<ArdiaCoreTab *> *tabs, NSTimeInterval deadline, void (^done)(NSUInteger left)) {
  NSUInteger left = 0;
  for (ArdiaCoreTab *tab in tabs)
    if (!Destroyed(tab)) left++;
  if (!left || Monotonic() >= deadline) return done(left);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kDestroyedPollMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    WhenDestroyed(tabs, deadline, done);
  });
}

void InstallFailClosed(NSString *profile, NSUInteger token, void (^then)(BOOL installed)) {
  then = [then copy];
  ArdiaCrawlerProfileState *state = States()[profile];
  if (!state.extensionLoaded || !ardia_host::LoadedProfile(profile)) return then(NO);
  __block bool settled = false;
  void (^settle)(NSString *) = ^(NSString *error) {
    if (settled) return;
    settled = true;
    if (error) NSLog(@"[crawler] profile \"%@\": the fail-closed rule didn't apply (%@); closing its tabs anyway", profile, error);
    else NSLog(@"[crawler] profile \"%@\": the fail-closed rule is on; closing its tabs", profile);
    if (!error && States()[profile] == state) state.blockAll = YES;
    then(error == nil);
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFailClosedSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    settle(@"timed out");
  });
  AbortBridge(profile);
  Bridge(profile, token, FailClosedExpression(), ^(id, NSString *error) { settle(error); });
}

}

namespace ardia_crawler {

void SetWebKitContainment(void (^contain)(NSString *, void (^)(void)), void (^clear)(NSString *, void (^)(void))) {
  gWebKitContainment = [contain copy];
  gWebKitClear = [clear copy];
}

void ClearSiteData(NSString *profile, void (^done)(void)) {
  ClearSiteDataWithin(profile, ^(BOOL) {
    if (done) done();
  });
}

void ClearSiteDataWithin(NSString *profile, void (^done)(BOOL cleared)) {
  done = [done copy];
  __block bool answered = false;
  void (^answer)(BOOL) = ^(BOOL cleared) {
    if (answered) return;
    answered = true;
    if (!cleared) NSLog(@"[crawler] profile \"%@\": its site data wasn't cleared within %.0f s", profile, kClearDeadlineSeconds);
    done(cleared);
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kClearDeadlineSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ answer(NO); });
  dispatch_group_t group = dispatch_group_create();
  if (gWebKitClear) {
    dispatch_group_enter(group);
    gWebKitClear(profile, ^{ dispatch_group_leave(group); });
  }
  dispatch_group_enter(group);
  [ArdiaServices clearBrowsingData:profile types:@[ @"siteData", @"cache" ] since:0 completion:^{ dispatch_group_leave(group); }];
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSLog(@"[crawler] profile \"%@\": site data cleared", profile);
    answer(YES);
  });
}

NSMutableDictionary<NSString *, NSMutableArray *> *ContainWaiters() {
  static NSMutableDictionary *waiters = [NSMutableDictionary dictionary];
  return waiters;
}

void WhenContained(NSString *profile, void (^then)(void)) {
  if (!States()[profile].containing) return then();
  NSMutableArray *waiting = ContainWaiters()[profile] ?: (ContainWaiters()[profile] = [NSMutableArray array]);
  [waiting addObject:[then copy]];
}

void Contain(NSString *profile, NSUInteger token, void (^finished)(NSString *problem)) {
  finished = [finished copy];
  ArdiaCrawlerProfileState *owner = States()[profile];
  owner.containing = YES;
  void (^done)(NSString *) = ^(NSString *problem) {
    owner.containing = NO;
    NSArray *waiting = ContainWaiters()[profile];
    [ContainWaiters() removeObjectForKey:profile];
    if (finished) finished(problem);
    for (void (^waiter)(void) in waiting) waiter();
  };
  InstallFailClosed(profile, token, ^(BOOL installed) {
    [ArdiaCrawlerSelfTest cancelInProfile:profile];
    for (NSString *key in @[ profile, PageKey(profile) ]) {
      [ardia_content_blocker::Pages()[key] fail:@"crawler mode isn't ready"];
      [ardia_content_blocker::Pages() removeObjectForKey:key];
    }
    NSArray<ArdiaCoreTab *> *tabs = TabsOf(profile);
    for (ArdiaCoreTab *tab in tabs)
      if (!tab.closed) [tab closeNow];
    void (^afterWebKit)(void) = ^{
      WhenDestroyed(tabs, Monotonic() + kDestroyedSeconds, ^(NSUInteger left) {
        NSLog(@"[crawler] profile \"%@\": closed its %lu tabs (%lu still unloading at the deadline); clearing its site data", profile,
              (unsigned long)tabs.count, (unsigned long)left);
        ClearSiteDataWithin(profile, ^(BOOL cleared) {
          NSString *problem = nil;
          if (left) problem = [NSString stringWithFormat:@"%lu of its pages didn't close within %.0f s", (unsigned long)left, kDestroyedSeconds];
          else if (!cleared) problem = [NSString stringWithFormat:@"its site data wasn't cleared within %.0f s", kClearDeadlineSeconds];
          if (problem && !installed && !owner.blockAll) {
            Publish();
            return Terminate(profile, [problem stringByAppendingString:@", and its block-everything rule didn't apply"]);
          }
          done(problem);
        });
      });
    };
    if (gWebKitContainment) gWebKitContainment(profile, afterWebKit);
    else afterWebKit();
  });
}

void CloseNetLogPages() {
  NSUInteger closed = 0;
  for (ArdiaCoreTab *tab in TabsOf(nil)) {
    if (tab.closed || !IsNetLogPage(tab.url)) continue;
    [tab closeNow];
    closed++;
  }
  if (closed) NSLog(@"[crawler] closed %lu NetLog pages before a crawler profile starts", (unsigned long)closed);
}

bool NetLogPageOpen() {
  for (ArdiaCoreTab *tab in TabsOf(nil))
    if (!tab.closed && IsNetLogPage(tab.url)) return true;
  return false;
}

bool SignaturesInstalled() {
  for (ArdiaCrawlerProfileState *state in States().allValues)
    for (NSDictionary *entry in state.shopify)
      if ([entry[@"sent"] boolValue]) return true;
  return false;
}

bool HasPrivateSession(NSString *profile) {
  for (NSString *name in ardia_host::LoadedProfileNames())
    if (ardia_host::IsPrivateSessionId(name) && [ardia_host::OriginalProfileName(name) isEqualToString:profile]) return true;
  for (ArdiaCoreTab *tab in TabsOf(profile))
    if (tab.profile.offTheRecord) return true;
  return false;
}

void SetWebKitPagesQuery(BOOL (^hasPages)(NSString *)) { gWebKitHasPages = [hasPages copy]; }

bool HasWebKitPages(NSString *profile) { return gWebKitHasPages && gWebKitHasPages(profile); }

bool IsLoading(NSString *profile) { return ardia_host::ProfileWaiters()[profile] != nil; }

void Terminate(NSString *profile, NSString *reason) {
  NSLog(@"[crawler] profile \"%@\" can't be kept safe (%@), so Ardia quits now", profile, reason);
  fflush(stderr);
  _exit(kNotReadyExitCode);
}

void RetryWaitingPages() {
  for (ArdiaWindowController *controller in ArdiaWindowController.all) [ArdiaWebView retryPagesInWindow:controller];
}

}
