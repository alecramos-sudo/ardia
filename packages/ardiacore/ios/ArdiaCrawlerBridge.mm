#import "ArdiaCrawlerInternal.h"
#import "ArdiaContentBlockerInternal.h"

#include <utility>

using namespace ardia_crawler;

@interface ArdiaCrawlerBridgeOp : NSObject
@property NSUInteger token;
@property NSUInteger request;
@property(copy) NSString *script;
@property(copy) void (^build)(void (^go)(NSString *expression, NSString *problem));
@property(copy) void (^completion)(id value, NSString *error);
@end

@implementation ArdiaCrawlerBridgeOp
@end

namespace {

constexpr double kCallSeconds = 15;

constexpr double kRetryMs = 250;

constexpr double kTestRetryMs = 1500;

constexpr int kFailClosedRuleId = 900000;

NSString *const kTrackersRuleset = @"trackers";

NSString *const kBridgeFile = @"bridge.html";

NSString *const kPrelude =
    @"const origin = %@;"
     "const until = Date.now() + 5000;"
     "const bridge = () => new Promise((resolve, reject) => {"
     "  const look = () => {"
     "    if (location.origin !== origin) return reject(new Error(`not the extension page: ${location.href}`));"
     "    if (globalThis.ardiaCrawler) return resolve(globalThis.ardiaCrawler);"
     "    if (Date.now() > until) return reject(new Error('the crawler bridge never started'));"
     "    setTimeout(look, 20);"
     "  };"
     "  look();"
     "});"
     "const dnr = chrome.declarativeNetRequest;"
     "bridge().then((crawler) => (%@))"
     ".then((v) => post('result', JSON.stringify({value: v === undefined ? null : v})),"
     "(e) => post('result', JSON.stringify({error: String(e && e.message || e)})))";

NSString *const kStale = @"stale: a newer crawler step replaced it";

NSString *Script(NSString *expression) {
  return [NSString stringWithFormat:kPrelude, Json([@"chrome-extension://" stringByAppendingString:kExtensionId]), expression];
}

NSMutableDictionary<NSString *, NSNumber *> *Requests() {
  static NSMutableDictionary *requests = [NSMutableDictionary dictionary];
  return requests;
}

bool Superseded(NSString *profile, ArdiaCrawlerBridgeOp *op) {
  return op.request && op.request < Requests()[profile].unsignedIntegerValue;
}

bool gTestRetryNext = false;

bool gTestFailNext = false;

NSMutableDictionary<NSString *, NSMutableArray<ArdiaCrawlerBridgeOp *> *> *Queues() {
  static NSMutableDictionary *queues = [NSMutableDictionary dictionary];
  return queues;
}

NSMutableSet<NSString *> *Busy() {
  static NSMutableSet *busy = [NSMutableSet set];
  return busy;
}

bool Retriable(NSString *error) {
  for (NSString *sign in @[ @"no answer", @"not the extension page", @"renderer ", @"closed", @"never started", @"context invalidated" ])
    if ([error containsString:sign]) return true;
  return false;
}

void Pump(NSString *profile);

void Attempt(NSString *profile, ArdiaCrawlerBridgeOp *op, NSTimeInterval deadline, void (^finish)(id, NSString *)) {
  if (!TokenLive(profile, op.token)) {
    NSLog(@"[crawler] profile \"%@\": dropped a stale crawler step", profile);
    return finish(nil, kStale);
  }
  if (Superseded(profile, op)) {
    NSLog(@"[crawler] profile \"%@\": dropped a configure a newer one superseded", profile);
    return finish(nil, kSuperseded);
  }
  if (std::exchange(gTestFailNext, false)) return finish(nil, @"failed (test)");
  if (std::exchange(gTestRetryNext, false)) {
    NSLog(@"[crawler] test: the bridge call gets a retriable error and retries in %.1f s", kTestRetryMs / 1000);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTestRetryMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      NSLog(@"[crawler] test: the delayed retry is due now");
      Attempt(profile, op, deadline + kTestRetryMs / 1000, finish);
    });
    return;
  }
  ArdiaCoreProfile *p = ardia_host::LoadedProfile(profile);
  ArdiaContentBlockerPage *page = p ? ardia_content_blocker::HiddenPage(PageKey(profile), profile, p, kExtensionId, kBridgeFile) : nil;
  if (!page) return finish(nil, @"the crawler page didn't open");
  __block bool settled = false;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(0, deadline - NSDate.timeIntervalSinceReferenceDate) * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (settled) return;
                   settled = true;
                   [page fail:@"the crawler call timed out"];
                   finish(nil, @"the crawler call timed out");
                 });
  [page run:op.script
      completion:^(id value, NSString *error) {
        if (settled) return;
        settled = true;
        if (error && Retriable(error) && NSDate.timeIntervalSinceReferenceDate + kRetryMs / 1000 < deadline && ardia_host::LoadedProfile(profile)) {
          [page fail:error];
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRetryMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            Attempt(profile, op, deadline, finish);
          });
          return;
        }
        finish(value, error);
      }];
}

void Pump(NSString *profile) {
  if ([Busy() containsObject:profile]) return;
  NSMutableArray<ArdiaCrawlerBridgeOp *> *queue = Queues()[profile];
  ArdiaCrawlerBridgeOp *op = queue.firstObject;
  if (!op) return;
  [queue removeObjectAtIndex:0];
  [Busy() addObject:profile];
  void (^finish)(id, NSString *) = ^(id value, NSString *error) {
    [Busy() removeObject:profile];
    op.completion(value, error);
    Pump(profile);
  };
  if (!op.build) return Attempt(profile, op, NSDate.timeIntervalSinceReferenceDate + kCallSeconds, finish);
  if (!TokenLive(profile, op.token) || Superseded(profile, op)) return Attempt(profile, op, NSDate.timeIntervalSinceReferenceDate, finish);
  op.build(^(NSString *expression, NSString *problem) {
    if (problem) return finish(nil, problem);
    op.script = Script(expression);
    Attempt(profile, op, NSDate.timeIntervalSinceReferenceDate + kCallSeconds, finish);
  });
}

}

namespace ardia_crawler {

NSString *Json(id value) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
  return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"null";
}

NSString *const kSuperseded = @"superseded: a newer configure replaced it";

void BridgeBuilt(NSString *profile, NSUInteger token, void (^build)(void (^go)(NSString *expression, NSString *problem)),
                 void (^completion)(id value, NSString *error)) {
  ArdiaCrawlerBridgeOp *op = [ArdiaCrawlerBridgeOp new];
  op.token = token;
  const NSUInteger request = Requests()[profile].unsignedIntegerValue + 1;
  Requests()[profile] = @(request);
  op.request = request;
  op.build = build;
  op.completion = completion;
  NSMutableArray *queue = Queues()[profile] ?: (Queues()[profile] = [NSMutableArray array]);
  [queue addObject:op];
  Pump(profile);
}

void Bridge(NSString *profile, NSUInteger token, NSString *expression, void (^completion)(id value, NSString *error)) {
  ArdiaCrawlerBridgeOp *op = [ArdiaCrawlerBridgeOp new];
  op.token = token;
  op.script = Script(expression);
  op.completion = completion;
  NSMutableArray *queue = Queues()[profile] ?: (Queues()[profile] = [NSMutableArray array]);
  [queue addObject:op];
  Pump(profile);
}

void AbortBridge(NSString *profile) {
  if ([Busy() containsObject:profile]) [ardia_content_blocker::Pages()[PageKey(profile)] fail:@"superseded"];
}

NSString *FailClosedExpression() {
  NSDictionary *rule = @{
    @"id" : @(kFailClosedRuleId),
    @"priority" : @1,
    @"action" : @{@"type" : @"block"},
    @"condition" : @{
      @"resourceTypes" : @[
        @"main_frame", @"sub_frame", @"stylesheet", @"script", @"image", @"font", @"object", @"xmlhttprequest", @"ping", @"csp_report",
        @"media", @"websocket", @"webtransport", @"webbundle", @"other"
      ]
    },
  };
  return [NSString stringWithFormat:@"dnr.updateSessionRules({removeRuleIds: [%d], addRules: [%@]}).then(() => null)", kFailClosedRuleId, Json(rule)];
}

NSString *RemoveSignatureRulesExpression() {
  return @"dnr.getSessionRules().then((rules) => rules.filter((r) => ((r.action && r.action.requestHeaders) || []).some((h) => /^signature/i.test(h.header))).map((r) => r.id))"
         @".then((ids) => dnr.updateSessionRules({removeRuleIds: ids})).then(() => null)";
}

NSString *RulesetExpression() {
  NSString *key = RulesFailTest() ? @"disableRulesetIds" : @"enableRulesetIds";
  return [NSString stringWithFormat:@"dnr.updateEnabledRulesets({%@: [%@]}).then(() => null)", key, Json(kTrackersRuleset)];
}

NSString *ConfigureExpression(NSDictionary *config) {
  return [NSString stringWithFormat:
                       @"crawler.configure(%@).then((reply) => dnr.getSessionRules().then((rules) => ({ok: reply.ok, sessionRules: reply.sessionRules,"
                        " signed: [...new Set(rules.filter((r) => ((r.action && r.action.requestHeaders) || []).some((h) => h.header === 'Signature'))"
                        ".flatMap((r) => (r.condition && r.condition.requestDomains) || []))]})))",
                       Json(config)];
}

void TestBridgeFault(bool retriable) {
  if (retriable) gTestRetryNext = true;
  else gTestFailNext = true;
}

}
