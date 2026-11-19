#import "ArdiaCrawlerInternal.h"
#import "ArdiaContentBlockerInternal.h"
#import "ArdiaHostInternal.h"

using namespace ardia_crawler;

namespace {

constexpr double kStatsSeconds = 45;

constexpr double kStartSeconds = 8;

constexpr double kTurnOnSeconds = 10;

constexpr double kClearSeconds = 20;


}

namespace ardia_crawler {

ArdiaCrawlerProfileState *Current(NSString *profile, NSUInteger generation) {
  ArdiaCrawlerProfileState *state = States()[profile];
  return state.generation == generation ? state : nil;
}

NSArray<NSDictionary *> *Withholding(NSArray<NSDictionary *> *shopify, NSString *detail) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *entry in shopify) {
    NSMutableDictionary *withheld = [entry mutableCopy];
    withheld[@"sent"] = @NO;
    if (![withheld[@"detail"] isKindOfClass:NSString.class]) withheld[@"detail"] = detail;
    [out addObject:withheld];
  }
  return out;
}

void Fail(NSString *profile, NSUInteger generation, NSString *reason, NSString *detail, void (^done)(void)) {
  done = [done copy];
  ArdiaCrawlerProfileState *state = Current(profile, generation);
  if (!state) {
    if (done) done();
    return;
  }
  const NSUInteger failed = NextToken();
  state.generation = failed;
  state.ready = NO;
  state.reason = reason;
  state.detail = detail;
  state.readySince = nil;
  state.navigationHeader = NO;
  state.shopify = Withholding(state.shopify, @"crawler mode isn't ready");
  NSLog(@"[crawler] profile \"%@\" isn't ready (%@): %@", profile, reason, detail ?: @"");
  Publish();
  if (InstanceRequested()) return Terminate(profile, reason);
  Contain(profile, failed, ^(NSString *) {
    ArdiaCrawlerProfileState *current = Current(profile, failed);
    if (current.held) {
      current.held = NO;
      [ardia_host::LoadedProfile(profile)
          releaseNavigationHold:[NSString stringWithFormat:@"crawler mode isn't ready (%@); its tabs are gone and its site data cleared", reason]];
    }
    if (done) done();
  });
}

}

namespace {

NSDate *ExpiryOfEntry(NSDictionary *entry) {
  bool readable = true;
  return ExpiryOf(entry[@"signatureInput"] ?: @"", &readable);
}

NSArray<NSDictionary *> *ShopifyStatus(NSArray<NSDictionary *> *entries, NSArray<NSString *> *domains, NSSet<NSString *> *installed,
                                       NSDictionary<NSString *, NSString *> *withheld) {
  NSMutableArray *out = [NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  for (NSDictionary *entry in entries) {
    NSString *domain = entry[@"domain"];
    const bool sent = [installed containsObject:domain];
    NSString *detail = sent ? nil : (withheld[domain] ?: (installed ? @"not installed" : nil));
    [out addObject:@{@"domain" : domain, @"expires" : ExpiryOfEntry(entry) ?: NSNull.null, @"sent" : @(sent), @"detail" : detail ?: NSNull.null}];
    [seen addObject:domain];
  }
  for (NSString *domain in domains)
    if (![seen containsObject:domain]) [out addObject:@{@"domain" : domain, @"expires" : NSNull.null, @"sent" : @NO, @"detail" : NSNull.null}];
  return out;
}

void ConfigureStep(NSString *profile, NSUInteger generation, NSArray<NSDictionary<NSString *, NSString *> *> *explicitEntries,
                   void (^then)(NSString *error));

void ScheduleExpiry(NSString *profile, NSUInteger generation, NSDate *expires) {
  ArdiaCrawlerProfileState *state = Current(profile, generation);
  if (!state) return;
  const NSUInteger timer = state.expiryTimer + 1;
  state.expiryTimer = timer;
  if (!expires) return;
  const NSTimeInterval in = MAX(0, [expires timeIntervalSinceDate:Now()] - kExpiryMarginSeconds);
  ArdiaCrawlerProfileState *owner = state;
  dispatch_after(dispatch_walltime(nullptr, (int64_t)(in * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (States()[profile] != owner || owner.expiryTimer != timer) return;
    NSLog(@"[crawler] profile \"%@\": a Shopify signature expires within %.0f s; it stops being sent", profile, kExpiryMarginSeconds);
    const NSUInteger now = owner.generation;
    if (owner.ready && !owner.containing && !owner.converting && !owner.deleting) {
      return ConfigureStep(profile, now, @[], ^(NSString *error) {
        if (!Current(profile, now)) return;
        if (error) return Fail(profile, now, kReasonConfigureFailed, error, nil);
        Publish();
        Reconfigure(profile);
      });
    }
    Bridge(profile, now, RemoveSignatureRulesExpression(), ^(id, NSString *error) {
      if (States()[profile] != owner) return;
      owner.shopify = Withholding(owner.shopify, @"expired");
      Publish();
      if (!error) return;
      if (owner.blockAll) {
        NSLog(@"[crawler] profile \"%@\": the expiring signature couldn't be removed (%@); the block-everything rule keeps it from being sent", profile, error);
        return;
      }
      Terminate(profile, [NSString stringWithFormat:@"an expiring signature couldn't be removed (%@) and nothing blocks it", error]);
    });
  });
}

void ConfigureStep(NSString *profile, NSUInteger generation, NSArray<NSDictionary<NSString *, NSString *> *> *explicitEntries,
                   void (^then)(NSString *error)) {
  then = [then copy];
  __block NSArray<NSDictionary<NSString *, NSString *> *> *entries = @[];
  __block NSArray<NSDictionary<NSString *, NSString *> *> *sendable = @[];
  __block NSDictionary<NSString *, NSString *> *withheld = @{};
  __block NSString *header = nil;
  void (^build)(void (^)(NSString *, NSString *)) = ^(void (^go)(NSString *, NSString *)) {
    if (ArdiaCrawlerProfileState *replacing = Current(profile, generation)) replacing.blockAll = NO;
    void (^compose)(NSArray *, NSString *) = ^(NSArray *read, NSString *problem) {
      if (problem) NSLog(@"[crawler] profile \"%@\": %@", profile, problem);
      if (problem && InstanceRequested()) return go(nil, problem);
      entries = read ?: @[];
      header = HeaderFor(profile);
      NSMutableArray *ok = [NSMutableArray array];
      NSMutableDictionary *held = [NSMutableDictionary dictionary];
      NSDate *now = Now();
      for (NSDictionary *entry in entries) {
        if (NSString *why = WithheldBecause(entry, now)) held[entry[@"domain"]] = why;
        else [ok addObject:entry];
      }
      sendable = ok;
      withheld = held;
      go(ConfigureExpression(@{@"navigationHeader" : header ?: NSNull.null, @"shopify" : sendable}), nil);
    };
    if (explicitEntries) compose(explicitEntries, nil);
    else SignaturesFor(profile, compose);
  };
  BridgeBuilt(profile, generation, build, ^(NSDictionary *reply, NSString *error) {
    ArdiaCrawlerProfileState *current = Current(profile, generation);
    if (!current || [error isEqualToString:kSuperseded]) return then(nil);
    const NSUInteger expected = (header ? 1 : 0) + sendable.count;
    const bool ok = !error && [reply isKindOfClass:NSDictionary.class] && [reply[@"ok"] boolValue];
    const NSInteger rules = ok && [reply[@"sessionRules"] isKindOfClass:NSNumber.class] ? [reply[@"sessionRules"] integerValue] : -1;
    NSMutableSet<NSString *> *installed = [NSMutableSet set];
    for (id domain in ok && [reply[@"signed"] isKindOfClass:NSArray.class] ? reply[@"signed"] : @[])
      if ([domain isKindOfClass:NSString.class]) [installed addObject:domain];
    current.configured = ok && rules == (NSInteger)expected;
    current.navigationHeader = current.configured && header != nil;
    if (ok) current.shopify = ShopifyStatus(entries, ShopifyDomainsFor(profile), installed, withheld);
    if (error) return then(error);
    if (!current.configured)
      return then([NSString stringWithFormat:@"configure answered %ld session rules, expected %lu", (long)rules, (unsigned long)expected]);
    NSDate *earliest = nil;
    for (NSDictionary *entry in sendable)
      if (NSDate *expires = [installed containsObject:entry[@"domain"]] ? ExpiryOfEntry(entry) : nil) earliest = earliest ? [earliest earlierDate:expires] : expires;
    ScheduleExpiry(profile, generation, earliest);
    then(nil);
  });
}

void Configure(NSString *profile, NSUInteger generation, void (^then)(NSString *error)) { ConfigureStep(profile, generation, nil, then); }

void SchedulePoll();

void SelfTest(NSString *profile, NSUInteger generation) {
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  if (!Current(profile, generation)) return;
  if (!p) return Fail(profile, generation, kReasonOther, @"the profile went", nil);
  [ArdiaCrawlerSelfTest runInProfile:p
                               named:profile
                          completion:^(NSString *reason, NSString *detail) {
                            ArdiaCrawlerProfileState *state = Current(profile, generation);
                            if (!state) return;
                            if (reason) return Fail(profile, generation, reason, detail, nil);
                            state.ready = YES;
                            state.reason = nil;
                            state.detail = nil;
                            state.readySince = NSDate.date;
                            NSLog(@"[crawler] profile \"%@\" is ready", profile);
                            if (state.held) [ardia_host::LoadedProfile(profile) releaseNavigationHoldReady];
                            state.held = NO;
                            Publish();
                            RetryWaitingPages();
                            SchedulePoll();
                          }];
}

void PollStats();

void SchedulePoll() {
  static bool scheduled = false;
  if (scheduled) return;
  scheduled = true;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStatsSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    scheduled = false;
    PollStats();
  });
}

void PollStats() {
  ForgetGoneProfiles();
  bool any = false;
  for (ArdiaCrawlerProfileState *state in States().allValues) {
    if (!state.ready || !ardia_host::LoadedProfile(state.profileId)) continue;
    any = true;
    NSString *profile = state.profileId;
    const NSUInteger generation = state.generation;
    Bridge(profile, generation, @"crawler.stats()", ^(NSDictionary *stats, NSString *error) {
      ArdiaCrawlerProfileState *current = Current(profile, generation);
      if (!current || error || ![stats isKindOfClass:NSDictionary.class] || ![stats[@"blocked"] isKindOfClass:NSDictionary.class]) {
        if (error && current) NSLog(@"[crawler] profile \"%@\": stats failed: %@", profile, error);
        return;
      }
      NSMutableDictionary *blocked = [NSMutableDictionary dictionary];
      [stats[@"blocked"] enumerateKeysAndObjectsUsingBlock:^(NSString *vendor, NSNumber *count, BOOL *) {
        if ([vendor isKindOfClass:NSString.class] && ![vendor isEqualToString:@"selftest"] && [count isKindOfClass:NSNumber.class])
          blocked[vendor] = count;
      }];
      if ([blocked isEqualToDictionary:current.blocked]) return;
      current.blocked = blocked;
      Publish();
    });
  }
  if (any) SchedulePoll();
}

void Activate(NSString *profile, NSUInteger generation) {
  ArdiaCrawlerProfileState *state = Current(profile, generation);
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  if (!state || !p) return;
  NSString *path = ExtensionPath();
  if (!path) return Fail(profile, generation, kReasonOther, @"the crawler extension isn't in the app bundle", nil);
  NSString *loaded = [p loadComponentExtension:path];
  if (![loaded isEqualToString:kExtensionId]) {
    return Fail(profile, generation, kReasonOther, [NSString stringWithFormat:@"the crawler extension didn't load (%@)", loaded ?: @"no id"], nil);
  }
  state.extensionLoaded = YES;
  Bridge(profile, generation, RulesetExpression(), ^(id, NSString *rulesetError) {
    if (!Current(profile, generation)) return;
    if (rulesetError) return Fail(profile, generation, kReasonConfigureFailed, rulesetError, nil);
    Configure(profile, generation, ^(NSString *error) {
      if (!Current(profile, generation)) return;
      if (error) return Fail(profile, generation, kReasonConfigureFailed, error, nil);
      SelfTest(profile, generation);
    });
  });
}

}

namespace ardia_crawler {

NSString *PageKey(NSString *profile) { return [@"crawler:" stringByAppendingString:profile]; }

NSUInteger NextToken() {
  static NSUInteger token = 0;
  return ++token;
}

bool TokenLive(NSString *profile, NSUInteger token) { return Current(profile, token) != nil; }

void Start(NSString *profile) {
  if (!IsCrawler(profile)) return;
  ArdiaCrawlerProfileState *state = States()[profile];
  if (!state) States()[profile] = state = [[ArdiaCrawlerProfileState alloc] initWithProfile:profile source:SourceOf(profile) name:DisplayName(profile)];
  state.name = DisplayName(profile);
  WatchPower();
  const NSUInteger generation = NextToken();
  state.generation = generation;
  state.ready = NO;
  state.reason = nil;
  state.detail = @"starting";
  state.readySince = nil;
  state.configured = NO;
  state.navigationHeader = NO;
  state.blocked = @{};
  state.shopify = ShopifyStatus(@[], ShopifyDomainsFor(profile), nil, @{});
  if (InstanceRequested() && !InstanceAllowed()) {
    return Fail(profile, generation, kReasonRefusedNotScratch, @"crawler=on needs a scratch ARDIA_DATA_DIR", nil);
  }
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  if (!p) {
    state.detail = @"not loaded";
    return Publish();
  }
  Publish();
  CloseNetLogPages();
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kClearSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaCrawlerProfileState *current = Current(profile, generation);
    if (current && !current.held && !current.ready)
      Fail(profile, generation, kReasonTimeout, [NSString stringWithFormat:@"its site data wasn't cleared within %.0f s", kClearSeconds], nil);
  });
  ClearSiteDataWithin(profile, ^(BOOL cleared) {
    ArdiaCrawlerProfileState *current = Current(profile, generation);
    ArdiaCoreProfile *loaded = ardia_host::LoadedProfile(profile);
    if (!current || !loaded) return;
    if (!cleared) return Fail(profile, generation, kReasonTimeout, @"its site data wasn't cleared in time", nil);
    NSLog(@"[crawler] profile \"%@\": started from cleared site data", profile);
    [loaded holdNavigationsUntilRulesetsOf:kExtensionId];
    current.held = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      ArdiaCrawlerProfileState *now = Current(profile, generation);
      if (now && !now.ready)
        Fail(profile, generation, kReasonTimeout, [NSString stringWithFormat:@"not ready within %.0f s, before the engine's own hold ends", kStartSeconds], nil);
    });
    Activate(profile, generation);
  });
  SchedulePoll();
}

NSString *const kConvertSuperseded = @"crawler mode changed while turning on";

NSString *const kConvertKeptOn = @"crawler mode is on but not ready: ";

void KeepBlocked(NSString *profile, NSUInteger token, NSString *problem) {
  ArdiaCrawlerProfileState *state = Current(profile, token);
  if (!state) return;
  state.ready = NO;
  state.reason = kReasonOther;
  state.detail = problem;
  state.readySince = nil;
  state.navigationHeader = NO;
  NSLog(@"[crawler] profile \"%@\": %@; it stays blocked and not ready", profile, problem);
  Publish();
}

void Convert(NSString *profile, void (^done)(NSString *problem)) {
  done = [done copy];
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  if (!p) return done(@"the profile isn't loaded");
  ArdiaCrawlerProfileState *state = States()[profile];
  if (!state) States()[profile] = state = [[ArdiaCrawlerProfileState alloc] initWithProfile:profile source:SourceOf(profile) name:DisplayName(profile)];
  state.name = DisplayName(profile);
  WatchPower();
  const NSUInteger token = NextToken();
  state.generation = token;
  state.converting = YES;
  state.ready = NO;
  state.reason = nil;
  state.detail = @"turning on";
  state.readySince = nil;
  state.configured = NO;
  state.navigationHeader = NO;
  state.blocked = @{};
  state.shopify = ShopifyStatus(@[], ShopifyDomainsFor(profile), nil, @{});
  Publish();
  void (^finish)(NSString *) = ^(NSString *problem) {
    ArdiaCrawlerProfileState *current = Current(profile, token);
    if (current) current.converting = NO;
    else if (States()[profile] == state) state.converting = NO;
    done(current ? problem : kConvertSuperseded);
  };
  NSString *path = ExtensionPath();
  if (!path) return finish(@"the crawler extension isn't in the app bundle");
  NSString *loaded = [p loadComponentExtension:path];
  if (![loaded isEqualToString:kExtensionId]) return finish([NSString stringWithFormat:@"the crawler extension didn't load (%@)", loaded ?: @"no id"]);
  state.extensionLoaded = YES;
  __block bool settled = false;
  void (^settle)(NSString *) = ^(NSString *problem) {
    if (settled) return;
    settled = true;
    if (!Current(profile, token)) return finish(nil);
    if (problem) {
      NSLog(@"[crawler] profile \"%@\": couldn't turn crawler mode on (%@); it stays off and its pages stay open", profile, problem);
      return finish(problem);
    }
    state.blockAll = YES;
    NSLog(@"[crawler] profile \"%@\": turning on: everything is blocked; closing its pages and clearing its data", profile);
    Contain(profile, token, ^(NSString *containProblem) {
      if (!Current(profile, token)) return finish(nil);
      if (containProblem) {
        KeepBlocked(profile, token, containProblem);
        return finish([kConvertKeptOn stringByAppendingString:containProblem]);
      }
      NSLog(@"[crawler] profile \"%@\": turned on: its old pages are gone and its data is cleared", profile);
      finish(nil);
      Start(profile);
    });
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTurnOnSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    settle([NSString stringWithFormat:@"the block-everything rule wasn't confirmed within %.0f s", kTurnOnSeconds]);
  });
  Bridge(profile, token, FailClosedExpression(), ^(id, NSString *error) { settle(error); });
}

void RefuseLoad(NSString *profile, NSString *problem) {
  ArdiaCrawlerProfileState *state = States()[profile];
  if (!state) States()[profile] = state = [[ArdiaCrawlerProfileState alloc] initWithProfile:profile source:SourceOf(profile) name:DisplayName(profile)];
  state.generation = NextToken();
  state.ready = NO;
  state.reason = kReasonOther;
  state.detail = [@"its storage couldn't be cleared before loading: " stringByAppendingString:problem];
  state.readySince = nil;
  state.navigationHeader = NO;
  NSLog(@"[crawler] profile \"%@\" won't load: %@", profile, problem);
  Publish();
}

void Stop(NSString *profile) {
  ArdiaCrawlerProfileState *state = States()[profile];
  [States() removeObjectForKey:profile];
  [ArdiaCrawlerSelfTest cancelInProfile:profile];
  if (ArdiaContentBlockerPage *page = ardia_content_blocker::Pages()[PageKey(profile)]) {
    [page fail:@"crawler profile gone"];
    [ardia_content_blocker::Pages() removeObjectForKey:PageKey(profile)];
  }
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  if (state.held) [p releaseNavigationHold:@"crawler profile gone"];
  if (state.extensionLoaded && p) [p unloadComponentExtension:kExtensionId];
  Publish();
}

void Reset(NSString *profile, void (^done)(NSString *problem)) {
  done = [done copy];
  ArdiaCrawlerProfileState *state = States()[profile];
  if (state.converting || state.containing || state.deleting) return done(@"crawler mode is still turning on or clearing; try again in a moment");
  if (!state || !ardia_host::LoadedProfile(profile)) {
    return ClearSiteData(profile, ^{ done(nil); });
  }
  if (!state.extensionLoaded) return done(@"the crawler extension isn't loaded; turn crawler mode off and on again");
  const NSUInteger before = state.generation;
  __block bool settled = false;
  void (^confirmed)(NSString *) = ^(NSString *error) {
    if (settled) return;
    settled = true;
    if (!error) state.blockAll = YES;
    if (States()[profile] != state || state.generation != before) return done(@"crawler mode changed while clearing");
    if (error) return done([NSString stringWithFormat:@"the block-everything rule didn't apply (%@); nothing was cleared", error]);
    const NSUInteger resetting = NextToken();
    state.generation = resetting;
    state.ready = NO;
    state.reason = nil;
    state.detail = @"clearing crawler data";
    state.readySince = nil;
    state.navigationHeader = NO;
    state.shopify = Withholding(state.shopify, @"clearing crawler data");
    Publish();
    Contain(profile, resetting, ^(NSString *containProblem) {
      if (!Current(profile, resetting)) return done(@"crawler mode changed while clearing");
      if (containProblem) {
        KeepBlocked(profile, resetting, containProblem);
        return done(containProblem);
      }
      NSLog(@"[crawler] profile \"%@\": crawler data cleared; checking it again", profile);
      Start(profile);
      done(nil);
    });
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTurnOnSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    confirmed([NSString stringWithFormat:@"not confirmed within %.0f s", kTurnOnSeconds]);
  });
  Bridge(profile, before, FailClosedExpression(), ^(id, NSString *error) {
    if (settled && !error && States()[profile] == state && state.generation == before && state.ready) {
      NSLog(@"[crawler] profile \"%@\": a late block-everything rule from a Clear Crawler Data that gave up; restoring its rules", profile);
      state.blockAll = YES;
      return Reconfigure(profile);
    }
    confirmed(error);
  });
}

void Reconfigure(NSString *profile) {
  ArdiaCrawlerProfileState *state = States()[profile];
  if (state.converting || state.containing || state.deleting) return Publish();
  if (!state.extensionLoaded || !ardia_host::LoadedProfile(profile)) return Publish();
  if (!state.ready) return state.reason ? Publish() : Start(profile);
  const NSUInteger generation = state.generation;
  Configure(profile, generation, ^(NSString *error) {
    if (error) return Fail(profile, generation, kReasonConfigureFailed, error, nil);
    Publish();
  });
}

void ReconfigureAll(void (^done)(void)) {
  done = [done copy];
  dispatch_group_t group = dispatch_group_create();
  NSUInteger count = 0;
  for (ArdiaCrawlerProfileState *state in States().allValues) {
    if (!state.extensionLoaded || state.reason || state.containing || state.converting || state.deleting || !ardia_host::LoadedProfile(state.profileId)) continue;
    NSString *profile = state.profileId;
    const NSUInteger generation = state.generation;
    count++;
    dispatch_group_enter(group);
    Configure(profile, generation, ^(NSString *error) {
      if (!error) {
        Publish();
        return dispatch_group_leave(group);
      }
      Fail(profile, generation, kReasonConfigureFailed, error, ^{ dispatch_group_leave(group); });
    });
  }
  NSLog(@"[crawler] reconfiguring %lu profiles with the signatures still valid", (unsigned long)count);
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    if (done) done();
  });
}


}

namespace ardia_crawler {


void BeforeDelete(NSString *profile, void (^done)(NSString *problem)) {
  done = [done copy];
  ArdiaCrawlerProfileState *state = States()[profile];
  if (!state || !ardia_host::LoadedProfile(profile)) {
    ForgetProfile(profile);
    return done(nil);
  }
  const NSUInteger deleting = NextToken();
  state.generation = deleting;
  state.deleting = YES;
  state.ready = NO;
  state.reason = nil;
  state.detail = @"deleting";
  state.readySince = nil;
  state.navigationHeader = NO;
  state.shopify = Withholding(state.shopify, @"deleting");
  NSLog(@"[crawler] profile \"%@\" is being deleted: containing it before its protection goes", profile);
  Publish();
  Contain(profile, deleting, ^(NSString *problem) {
    if (problem) {
      [ardia_host::DeletedProfiles() removeObject:profile];
      state.deleting = NO;
      KeepBlocked(profile, deleting, problem);
      NSLog(@"[crawler] profile \"%@\" wasn't deleted: %@; it stays a blocked crawler profile until deleting it succeeds", profile, problem);
      return done(problem);
    }
    ForgetProfile(profile);
    done(nil);
  });
}

}

namespace ardia_crawler {

void ForgetGoneProfiles() {
  for (NSString *profile in States().allKeys) {
    if (ardia_host::IsDeletedProfile(profile) && !States()[profile].deleting) {
      [States() removeObjectForKey:profile];
      [ardia_content_blocker::Pages()[PageKey(profile)] fail:@"profile gone"];
      [ardia_content_blocker::Pages() removeObjectForKey:PageKey(profile)];
    }
  }
}

void TestFailAll() {
  for (ArdiaCrawlerProfileState *state in States().allValues)
    Fail(state.profileId, state.generation, kReasonOther, @"failed by a test", nil);
}

void TestReconfigureAll() {
  for (NSString *profile in States().allKeys) Reconfigure(profile);
}

void TestLogRules() {
  for (ArdiaCrawlerProfileState *state in States().allValues) {
    NSString *profile = state.profileId;
    Bridge(profile, state.generation, @"dnr.getSessionRules().then((rules) => rules.map((r) => [r.id, (((r.action || {}).requestHeaders || []).find((h) => h.header === 'X-Ardia-Crawler') || {}).value || null]))", ^(id ids, NSString *error) {
      NSLog(@"[crawler] test: profile \"%@\" session rules %@", profile, error ?: Json(ids ?: @[]));
    });
  }
}

}

namespace ardia_host {

void StartCrawler(NSString *profile) {
  if (ardia_crawler::IsCrawler(profile ?: @"")) ardia_crawler::Start(profile ?: @"");
}

}
