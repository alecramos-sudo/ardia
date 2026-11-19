#import "ArdiaCrawlerInternal.h"
#import "ArdiaLaunchConfig.h"

#import <IOKit/IOMessage.h>
#import <IOKit/pwr_mgt/IOPMLib.h>

#include <notify.h>
#include <unistd.h>

using namespace ardia_crawler;

namespace {

io_connect_t gRootPort = MACH_PORT_NULL;

constexpr double kSleepRemovalSeconds = 20;

NSString *const kSleepOvertaken = @"overtaken by a newer crawler operation";

void RemoveForSleep(NSString *profile, NSUInteger generation, NSTimeInterval deadline, void (^done)(void));

void FollowCurrentForSleep(NSString *profile, NSTimeInterval deadline, void (^done)(void)) {
  ArdiaCrawlerProfileState *now = States()[profile];
  if (!now || !now.extensionLoaded || !ardia_host::LoadedProfile(profile)) return done();
  if (now.containing) return WhenContained(profile, done);
  if (now.converting || now.reason || now.blockAll) return done();
  RemoveForSleep(profile, now.generation, deadline, done);
}

void RemovalAttempt(NSString *profile, NSUInteger generation, NSMutableArray *settled, void (^settle)(NSString *)) {
  BridgeBuilt(
      profile, generation,
      ^(void (^go)(NSString *, NSString *)) {
        if (ArdiaCrawlerProfileState *replacing = Current(profile, generation)) replacing.blockAll = NO;
        go(ConfigureExpression(@{@"navigationHeader" : HeaderFor(profile) ?: NSNull.null, @"shopify" : @[]}), nil);
      },
      ^(NSDictionary *reply, NSString *error) {
        if (settled.count) return;
        if ([error isEqualToString:kSuperseded]) return RemovalAttempt(profile, generation, settled, settle);
        ArdiaCrawlerProfileState *current = Current(profile, generation);
        if (!current) return settle(kSleepOvertaken);
        NSArray *signedDomains = [reply isKindOfClass:NSDictionary.class] && [reply[@"signed"] isKindOfClass:NSArray.class] ? reply[@"signed"] : nil;
        const bool removed = !error && [reply[@"ok"] boolValue] && signedDomains && signedDomains.count == 0;
        if (removed) current.shopify = Withholding(current.shopify, @"the Mac is going to sleep");
        settle(removed ? nil : (error ?: @"removing the signatures wasn't confirmed"));
      });
}

void RemoveForSleep(NSString *profile, NSUInteger generation, NSTimeInterval deadline, void (^done)(void)) {
  done = [done copy];
  NSMutableArray *settled = [NSMutableArray array];
  void (^settle)(NSString *) = ^(NSString *error) {
    if (settled.count) return;
    [settled addObject:@YES];
    if (!error) {
      NSLog(@"[crawler] profile \"%@\": signatures removed for sleep", profile);
      Publish();
      return done();
    }
    if ([error isEqualToString:kSleepOvertaken] || !Current(profile, generation)) return FollowCurrentForSleep(profile, deadline, done);
    Fail(profile, generation, kReasonConfigureFailed, error, done);
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(0, deadline - NSDate.timeIntervalSinceReferenceDate) * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   settle([NSString stringWithFormat:@"removing the signatures wasn't confirmed within %.0f s", kSleepRemovalSeconds]);
                 });
  RemovalAttempt(profile, generation, settled, settle);
}


void BeforeSleep(void (^allow)(void)) {
  allow = [allow copy];
  SetSleeping(true);
  NSLog(@"[crawler] the Mac is going to sleep: removing Shopify signatures first");
  RemoveSignaturesForSleep(^{
    NSLog(@"[crawler] signatures removed; sleep can go ahead");
    if (allow) allow();
  });
}

void AfterWake(NSString *why) {
  SetSleeping(false);
  NSLog(@"[crawler] %@: reinstalling only the signatures still valid", why);
  ReconfigureAll(nil);
}

void ClockChanged(NSString *why) {
  if (Sleeping()) {
    NSLog(@"[crawler] %@ while the Mac is going to sleep: signatures stay withheld until it wakes", why);
    return;
  }
  NSLog(@"[crawler] %@: dropping any signature that is now expired", why);
  ReconfigureAll(nil);
}

void PowerChanged(void *, io_service_t, natural_t message, void *argument) {
  const long notification = (long)argument;
  switch (message) {
    case kIOMessageCanSystemSleep:
      IOAllowPowerChange(gRootPort, notification);
      break;
    case kIOMessageSystemWillSleep:
      BeforeSleep(^{ IOAllowPowerChange(gRootPort, notification); });
      break;
    default:
      break;
  }
}

void WatchSystemPower() {
  IONotificationPortRef port = nullptr;
  io_object_t notifier = 0;
  gRootPort = IORegisterForSystemPower(nullptr, &port, PowerChanged, &notifier);
  if (gRootPort != MACH_PORT_NULL) {
    IONotificationPortSetDispatchQueue(port, dispatch_get_main_queue());
    return;
  }
  NSLog(@"[crawler] no system power notifications; watching the workspace's sleep notice instead");
  [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceWillSleepNotification
                                                              object:nil
                                                               queue:NSOperationQueue.mainQueue
                                                          usingBlock:^(NSNotification *) { BeforeSleep(nil); }];
}

void WatchTestEvents() {
  if (!ArdiaLaunchConfig.shared.testInstance) return;
  NSString *prefix = [NSString stringWithFormat:@"com.ardia.test.crawler.%d.", getpid()];
  int token = 0;
  notify_register_dispatch([prefix stringByAppendingString:@"sleep"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    BeforeSleep(nil);
  });
  notify_register_dispatch([prefix stringByAppendingString:@"wake"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    AfterWake(@"the Mac woke (test)");
  });
  notify_register_dispatch([prefix stringByAppendingString:@"retryNextBridge"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    TestBridgeFault(true);
  });
  notify_register_dispatch([prefix stringByAppendingString:@"failNextBridge"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    TestBridgeFault(false);
  });
  notify_register_dispatch([prefix stringByAppendingString:@"fail"].UTF8String, &token, dispatch_get_main_queue(), ^(int) { TestFailAll(); });
  notify_register_dispatch([prefix stringByAppendingString:@"delayNextSignatureRead"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    TestDelayNextSignatureRead();
  });
  notify_register_dispatch([prefix stringByAppendingString:@"delayNextSelfTest"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    TestDelayNextSelfTest();
  });
  notify_register_dispatch([prefix stringByAppendingString:@"logRules"].UTF8String, &token, dispatch_get_main_queue(), ^(int) { TestLogRules(); });
  notify_register_dispatch([prefix stringByAppendingString:@"reconfigure"].UTF8String, &token, dispatch_get_main_queue(), ^(int) {
    TestReconfigureAll();
  });
  notify_register_dispatch([prefix stringByAppendingString:@"clock"].UTF8String, &token, dispatch_get_main_queue(), ^(int fired) {
    uint64_t seconds = 0;
    notify_get_state(fired, &seconds);
    NoteClockOffset((NSTimeInterval)seconds);
    ClockChanged([NSString stringWithFormat:@"the clock changed (test, +%llu s)", seconds]);
  });
}

}

namespace ardia_crawler {

void RemoveSignaturesForSleep(void (^done)(void)) {
  done = [done copy];
  dispatch_group_t group = dispatch_group_create();
  const NSTimeInterval deadline = NSDate.timeIntervalSinceReferenceDate + kSleepRemovalSeconds;
  NSUInteger removing = 0, containing = 0;
  for (ArdiaCrawlerProfileState *state in States().allValues) {
    NSString *profile = state.profileId;
    if (!ardia_host::LoadedProfile(profile)) continue;
    dispatch_group_enter(group);
    void (^leave)(void) = ^{ dispatch_group_leave(group); };
    if (state.containing) {
      containing++;
      WhenContained(profile, leave);
    } else if (state.converting) {
      leave();
    } else if (state.extensionLoaded && !state.reason) {
      removing++;
      RemoveForSleep(profile, state.generation, deadline, leave);
    } else {
      leave();
    }
  }
  NSLog(@"[crawler] before sleep: removing signatures from %lu profiles, waiting on %lu containments", (unsigned long)removing,
        (unsigned long)containing);
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{ done(); });
}

void WatchPower() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    WatchSystemPower();
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidWakeNotification
                                                                object:nil
                                                                 queue:NSOperationQueue.mainQueue
                                                            usingBlock:^(NSNotification *) { AfterWake(@"the Mac woke"); }];
    [NSNotificationCenter.defaultCenter addObserverForName:NSSystemClockDidChangeNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *) { ClockChanged(@"the clock changed"); }];
    WatchTestEvents();
  });
}

}
