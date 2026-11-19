#import "ArdiaDeviceEmulation.h"

#import "ArdiaContentBlockerInternal.h"
#import "ArdiaWebView.h"

using ardia_content_blocker::HiddenPage;
using ardia_content_blocker::Pages;
using ardia_content_blocker::ScriptWith;

@interface ArdiaDeviceSession : NSObject
@property(copy) NSString *tabId;
@property(copy) NSString *targetId;
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

void ClosePageIfUnused(NSString *pageKey, ArdiaCoreProfile *profile) {
  for (ArdiaDeviceSession *session in Sessions().allValues)
    if ([session.pageKey isEqualToString:pageKey]) return;
  [Pages()[pageKey] fail:@"idle"];
  [Pages() removeObjectForKey:pageKey];
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
  void (^finish)(NSDictionary *, NSString *) = ^(NSDictionary *result, NSString *error) {
    if (!reply) return;
    void (^once)(NSDictionary *, NSString *) = reply;
    reply = nil;
    if (error) NSLog(@"[device] iPhone mode didn't start for %@: %@", tabId, error);
    once(result, error ? FailureCode(error) : nil);
  };
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  if (!tab || tab.closed) return finish(nil, @"noTarget: no tab");
  if (!IsWebUrl(tab.url)) return finish(nil, @"notHttp: only http and https pages");
  ArdiaCoreProfile *profile = PageProfileFor(tab);
  NSString *path = ExtensionPath();
  if (!profile || !path) return finish(nil, @"noExtension: not in the app");
  if (![[profile loadComponentExtension:path] isEqualToString:kExtensionId]) return finish(nil, @"noExtension: didn't load");
  NSString *pageKey = PageKeyFor(profile);
  ArdiaContentBlockerPage *page = HiddenPage(pageKey, ardia_host::ProfileName(profile), profile, kExtensionId, kPageFile);
  if (!page) return finish(nil, @"noExtension: no page");
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    finish(nil, @"timeout: no answer");
  });
  TargetIdOf(tab, ^(NSString *targetId) {
    if (!reply) return;
    if (!targetId) return finish(nil, @"noTarget: no target id");
    [page run:ScriptWith(@"ardiaDeviceEmulation.start(post, %@, %@)", @[ targetId, preset ])
        completion:^(id value, NSString *error) {
          if (!reply) {
            if (!error) [page run:ScriptWith(@"ardiaDeviceEmulation.stop(post, %@)", @[ targetId ]) completion:^(id, NSString *) {}];
            return;
          }
          if (error) {
            ClosePageIfUnused(pageKey, profile);
            return finish(nil, error);
          }
          ArdiaDeviceSession *session = [ArdiaDeviceSession new];
          session.tabId = tabId;
          session.targetId = targetId;
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
  ArdiaContentBlockerPage *page = Pages()[session.pageKey];
  void (^done)(void) = ^{
    ClosePageIfUnused(session.pageKey, session.pageProfile);
    completion(YES);
  };
  if (!page || page.dead) return done();
  [page run:ScriptWith(@"ardiaDeviceEmulation.stop(post, %@)", @[ session.targetId ])
      completion:^(id, NSString *) {
        done();
      }];
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
