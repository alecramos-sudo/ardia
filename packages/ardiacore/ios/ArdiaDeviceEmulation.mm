#import "ArdiaDeviceEmulation.h"

#import "ArdiaContentBlockerInternal.h"
#import "ArdiaWebView.h"

using ardia_content_blocker::HiddenPage;
using ardia_content_blocker::Pages;
using ardia_content_blocker::ScriptWith;

@interface ArdiaDeviceSession : NSObject
@property(copy) NSString *tabId;
@property(copy) NSString *targetId;
@property(copy) NSString *opId;
@property(copy) NSString *pageKey;
@property(weak) ArdiaCoreProfile *pageProfile;
@end

@implementation ArdiaDeviceSession
@end

namespace {

NSString *const kExtensionId = @"algjkobgkfckihfdhjpogcnmlgnihiki";
NSString *const kExtensionFolder = @"device-emulation";
NSString *const kPageFile = @"emulate.html";
constexpr double kStartSeconds = 10;
constexpr double kTargetSeconds = 2;
constexpr double kStuckSeconds = 5;

NSMutableDictionary<NSString *, ArdiaDeviceSession *> *Sessions() {
  static NSMutableDictionary *sessions = [NSMutableDictionary dictionary];
  return sessions;
}

NSString *ExtensionPath() {
  NSString *path = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:[@"Extensions" stringByAppendingPathComponent:kExtensionFolder]];
  return [NSFileManager.defaultManager fileExistsAtPath:[path stringByAppendingPathComponent:@"manifest.json"]] ? path : nil;
}

bool IsWebUrl(NSString *url) {
  NSString *scheme = [NSURL URLWithString:url ?: @""].scheme.lowercaseString;
  return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

ArdiaCoreProfile *PageProfileFor(ArdiaCoreTab *tab) {
  ArdiaCoreProfile *profile = tab.profile;
  if (!profile.offTheRecord) return profile;
  return ardia_host::LoadedProfile(ardia_host::OriginalProfileNameOf(profile));
}

NSString *PageKeyFor(ArdiaCoreProfile *profile) {
  return [@"device:" stringByAppendingString:ardia_host::ProfileName(profile)];
}

NSString *FailureCode(NSString *error) {
  NSRange colon = [error rangeOfString:@":"];
  NSString *code = colon.location == NSNotFound ? error : [error substringToIndex:colon.location];
  for (NSString *known in @[ @"notHttp", @"noTarget", @"attachRefused", @"timeout", @"noExtension" ])
    if ([code isEqualToString:known]) return known;
  return @"attachRefused";
}

NSMutableDictionary<NSString *, NSNumber *> *PendingStarts() {
  static NSMutableDictionary *pending = [NSMutableDictionary dictionary];
  return pending;
}

void ClosePageIfUnused(NSString *pageKey, ArdiaCoreProfile *profile) {
  if (PendingStarts()[pageKey].integerValue > 0) return;
  for (ArdiaDeviceSession *session in Sessions().allValues)
    if ([session.pageKey isEqualToString:pageKey]) return;
  [Pages()[pageKey] fail:@"idle"];
  [Pages() removeObjectForKey:pageKey];
  if (profile && !profile.destroyed) [profile unloadComponentExtension:kExtensionId];
}

void HoldPage(NSString *pageKey) {
  PendingStarts()[pageKey] = @(PendingStarts()[pageKey].integerValue + 1);
}

void ReleasePage(NSString *pageKey, ArdiaCoreProfile *profile) {
  const NSInteger left = PendingStarts()[pageKey].integerValue - 1;
  if (left > 0) PendingStarts()[pageKey] = @(left);
  else [PendingStarts() removeObjectForKey:pageKey];
  ClosePageIfUnused(pageKey, profile);
}

bool PageAlive(NSString *pageKey, ArdiaContentBlockerPage *page) {
  return page && !page.dead && Pages()[pageKey] == page;
}

void TellPage(ArdiaContentBlockerPage *page, NSString *verb, NSString *targetId, NSString *opId, void (^done)(void)) {
  done = [done copy];
  if (!page || page.dead) return done();
  [page.tab evaluate:ScriptWith([NSString stringWithFormat:@"ardiaDeviceEmulation.%@(post, %%@, %%@)", verb], @[ targetId, opId ])
          completion:^(NSString *) {
            done();
          }];
}

void EndSession(ArdiaDeviceSession *session, NSString *reason);

void RecyclePage(NSString *pageKey, ArdiaCoreProfile *profile, ArdiaContentBlockerPage *page) {
  NSLog(@"[device] the iPhone mode page stopped answering; closing it and every session on it");
  [Pages() removeObjectForKey:pageKey];
  [page fail:@"stuck"];
  for (ArdiaDeviceSession *session in Sessions().allValues)
    if ([session.pageKey isEqualToString:pageKey]) EndSession(session, @"pageGone");
  if (profile && !profile.destroyed) [profile unloadComponentExtension:kExtensionId];
}

void EndSession(ArdiaDeviceSession *session, NSString *reason) {
  if (Sessions()[session.tabId] != session) return;
  [Sessions() removeObjectForKey:session.tabId];
  NSLog(@"[device] iPhone mode ended for %@: %@", session.tabId, reason);
  [ArdiaEvents emit:@"tabs.deviceModeEnded" data:@{@"tabId" : session.tabId, @"reason" : reason}];
  ClosePageIfUnused(session.pageKey, session.pageProfile);
}

NSString *ReasonFromWatch(NSString *json) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *answer = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  id value = [answer isKindOfClass:NSDictionary.class] ? answer[@"value"] : nil;
  return [value isKindOfClass:NSString.class] ? value : @"pageGone";
}

void Watch(ArdiaDeviceSession *session, ArdiaContentBlockerPage *page) {
  [page.tab evaluate:ScriptWith(@"ardiaDeviceEmulation.watch(post, %@)", @[ session.targetId ])
          completion:^(NSString *json) {
            EndSession(session, json ? ReasonFromWatch(json) : @"pageGone");
          }];
}

void TargetIdOf(ArdiaCoreTab *tab, void (^done)(NSString *targetId)) {
  done = [done copy];
  [tab devToolsCall:@"Target.getTargetInfo"
             params:@{}
            timeout:kTargetSeconds
         completion:^(NSDictionary *result, NSString *error) {
           id info = result[@"targetInfo"];
           id targetId = [info isKindOfClass:NSDictionary.class] ? info[@"targetId"] : nil;
           done([targetId isKindOfClass:NSString.class] ? targetId : nil);
         }];
}

NSScreen *ScreenOf(NSWindow *window) { return window.screen ?: NSScreen.mainScreen; }

NSArray<NSNumber *> *FrameArray(NSRect frame) {
  return @[ @(NSMinX(frame)), @(NSMinY(frame)), @(NSWidth(frame)), @(NSHeight(frame)) ];
}

}

@implementation ArdiaDeviceEmulation

+ (void)startForTab:(NSString *)tabId
             preset:(NSDictionary<NSString *, id> *)preset
         completion:(void (^)(NSDictionary<NSString *, id> *, NSString *))completion {
  __block void (^reply)(NSDictionary *, NSString *) = [completion copy];
  __block NSString *pageKey = nil;
  __block ArdiaCoreProfile *profile = nil;
  void (^finish)(NSDictionary *, NSString *) = ^(NSDictionary *result, NSString *error) {
    if (!reply) return;
    void (^once)(NSDictionary *, NSString *) = reply;
    reply = nil;
    if (error) NSLog(@"[device] iPhone mode didn't start for %@: %@", tabId, error);
    if (pageKey) ReleasePage(pageKey, profile);
    once(result, error ? FailureCode(error) : nil);
  };
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  if (!tab || tab.closed) return finish(nil, @"noTarget: no tab");
  if (!IsWebUrl(tab.url)) return finish(nil, @"notHttp: only http and https pages");
  profile = PageProfileFor(tab);
  NSString *path = ExtensionPath();
  if (!profile || !path) return finish(nil, @"noExtension: not in the app");
  pageKey = PageKeyFor(profile);
  HoldPage(pageKey);
  if (![[profile loadComponentExtension:path] isEqualToString:kExtensionId]) return finish(nil, @"noExtension: didn't load");
  ArdiaContentBlockerPage *page = HiddenPage(pageKey, ardia_host::ProfileName(profile), profile, kExtensionId, kPageFile);
  if (!page) return finish(nil, @"noExtension: no page");
  __block NSString *resolvedTarget = nil;
  __block BOOL ran = NO;
  NSString *opId = NSUUID.UUID.UUIDString;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (!reply) return;
    NSString *target = resolvedTarget;
    finish(nil, @"timeout: no answer");
    if (!target || !PageAlive(pageKey, page)) return;
    TellPage(page, @"cancel", target, opId, ^{});
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStuckSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (!ran && PageAlive(pageKey, page)) RecyclePage(pageKey, profile, page);
    });
  });
  TargetIdOf(tab, ^(NSString *targetId) {
    if (!reply) return;
    if (!targetId) return finish(nil, @"noTarget: no target id");
    resolvedTarget = targetId;
    [page run:ScriptWith(@"ardiaDeviceEmulation.start(post, %@, %@, %@)", @[ targetId, preset, opId ])
        completion:^(id value, NSString *error) {
          ran = YES;
          if (!reply) {
            if (!error && PageAlive(pageKey, page)) TellPage(page, @"stop", targetId, opId, ^{ ClosePageIfUnused(pageKey, profile); });
            return;
          }
          if (error) return finish(nil, error);
          ArdiaDeviceSession *session = [ArdiaDeviceSession new];
          session.tabId = tabId;
          session.targetId = targetId;
          session.opId = opId;
          session.pageKey = pageKey;
          session.pageProfile = profile;
          Sessions()[tabId] = session;
          Watch(session, page);
          NSLog(@"[device] iPhone mode on for %@", tabId);
          finish(@{@"targetId" : targetId}, nil);
        }];
  });
}

+ (void)stopForTab:(NSString *)tabId completion:(void (^)(BOOL))completion {
  completion = [completion copy];
  ArdiaDeviceSession *session = Sessions()[tabId];
  if (!session) return completion(NO);
  [Sessions() removeObjectForKey:tabId];
  TellPage(Pages()[session.pageKey], @"stop", session.targetId, session.opId, ^{
    ClosePageIfUnused(session.pageKey, session.pageProfile);
    completion(YES);
  });
}

+ (NSArray<NSString *> *)emulatedTabs {
  return Sessions().allKeys;
}

+ (NSDictionary<NSString *, id> *)fitWindowOfTab:(NSString *)tabId toPage:(NSSize)page {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  ArdiaWebView *view = tab ? [ArdiaTabRegistry viewForTab:tab] : nil;
  NSWindow *window = view.window;
  if (!window || page.width <= 0 || page.height <= 0) return nil;
  const NSRect frame = window.frame;
  const NSRect shown = [view convertRect:view.bounds toView:nil];
  const CGFloat chromeWidth = NSWidth(frame) - NSWidth(shown);
  const CGFloat chromeHeight = NSHeight(frame) - NSHeight(shown);
  const NSRect visible = ScreenOf(window).visibleFrame;
  const CGFloat scale = MIN(1.0, MIN((NSWidth(visible) - chromeWidth) / page.width, (NSHeight(visible) - chromeHeight) / page.height));
  const CGFloat width = round(page.width * scale) + chromeWidth;
  const CGFloat height = round(page.height * scale) + chromeHeight;
  NSRect next = NSMakeRect(NSMinX(frame), NSMaxY(frame) - height, width, height);
  next.origin.x = MAX(NSMinX(visible), MIN(NSMinX(next), NSMaxX(visible) - width));
  next.origin.y = MAX(NSMinY(visible), MIN(NSMinY(next), NSMaxY(visible) - height));
  [window setFrame:next display:YES];
  return @{@"previous" : FrameArray(frame), @"frame" : FrameArray(next), @"scale" : @(scale)};
}

+ (BOOL)setFrame:(NSArray<NSNumber *> *)frame ofWindowOfTab:(NSString *)tabId {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  NSWindow *window = tab ? [ArdiaTabRegistry viewForTab:tab].window : nil;
  if (!window || frame.count != 4) return NO;
  [window setFrame:NSMakeRect(frame[0].doubleValue, frame[1].doubleValue, frame[2].doubleValue, frame[3].doubleValue) display:YES];
  return YES;
}

@end
