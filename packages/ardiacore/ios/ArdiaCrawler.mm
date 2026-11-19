#import "ArdiaCrawlerInternal.h"

using namespace ardia_crawler;

namespace {

NSString *const kOriginalProfile = @"The original profile can't be a crawler profile: it loads before crawler mode can clear it. Use another profile, or New Crawler Profile";

NSString *const kClosePrivate = @"Close this profile's private windows first";

NSString *const kCloseWebKit = @"Close this profile's WebKit tabs and finish or cancel its WebKit downloads first";

NSString *const kLoading = @"This profile is still loading; try again in a moment";

NSString *const kBusy = @"Crawler mode is still closing this profile's pages; try again in a moment";

NSString *const kInstanceRefusal = @"every profile is a crawler profile in this instance (ARDIA_INSTANCE crawler=on)";

NSString *ProfileProblem(NSString *profile) {
  if (InstanceRequested()) return kInstanceRefusal;
  if (ardia_host::IsPrivateSessionId(profile)) return @"a private window can't be a crawler profile";
  if (!IsCrawler(profile)) return @"not a crawler profile";
  return nil;
}

NSMutableDictionary *MutableSettings(NSString *profile) {
  return [ProfileSettings(profile) mutableCopy] ?: [NSMutableDictionary dictionary];
}

void Changed(NSString *profile) {
  if (ardia_host::LoadedProfile(profile)) Reconfigure(profile);
  else Publish();
}

}

@implementation ArdiaCrawler

+ (BOOL)instanceMode {
  return InstanceRequested();
}

+ (NSDictionary<NSString *, id> *)state {
  WatchPower();
  return StateSnapshot();
}

+ (BOOL)isCrawlerProfile:(NSString *)profileId {
  return IsCrawler(profileId ?: @"");
}

+ (BOOL)isReadyProfile:(NSString *)profileId {
  return IsCrawler(profileId ?: @"") && States()[profileId ?: @""].ready;
}

+ (BOOL)refusesTabsInProfile:(NSString *)profileId {
  NSString *profile = ardia_host::OriginalProfileName(profileId ?: @"");
  if (!IsCrawler(profile)) return NO;
  return ardia_host::IsPrivateSessionId(profileId) || !States()[profile].ready;
}

+ (BOOL)refusesTab:(ArdiaCoreTab *)tab {
  ArdiaCoreProfile *profile = tab.profile;
  if (!profile) return NO;
  if ([self refusesURL:tab.url]) return YES;
  NSString *original = ardia_host::OriginalProfileNameOf(profile);
  if (!IsCrawler(original)) return NO;
  return profile.offTheRecord || !States()[original].ready;
}

+ (BOOL)refusesWebKitInProfile:(NSString *)profileId {
  return IsCrawler(ardia_host::OriginalProfileName(profileId ?: @""));
}

+ (BOOL)refusesURL:(NSString *)url {
  return IsNetLogPage(url) && (InstanceRequested() || ProfileIds().count > 0);
}

+ (void)setWebKitContainment:(void (^)(NSString *, void (^)(void)))contain clear:(void (^)(NSString *, void (^)(void)))clear {
  SetWebKitContainment(contain, clear);
}

+ (void)setWebKitPagesQuery:(BOOL (^)(NSString *))hasPages {
  SetWebKitPagesQuery(hasPages);
}

+ (void)setProfile:(NSString *)profileId enabled:(BOOL)enabled name:(NSString *)name completion:(void (^)(NSString *))completion {
  completion = [completion copy];
  if (InstanceRequested()) return completion(kInstanceRefusal);
  if (ardia_host::IsPrivateSessionId(profileId)) return completion(@"a private window can't be a crawler profile");
  if (ardia_host::IsDeletedProfile(profileId)) return completion(@"that profile was deleted");
  if (!profileId.length) return completion(kOriginalProfile);
  NSMutableDictionary *settings = MutableSettings(profileId);
  const BOOL was = [settings[@"enabled"] boolValue];
  if (States()[profileId].containing || States()[profileId].converting) return completion(kBusy);
  if (!enabled) {
    if (!was) return completion(nil);
    settings[@"enabled"] = @NO;
    SaveProfileSettings(profileId, settings);
    Stop(profileId);
    NSLog(@"[crawler] profile \"%@\": crawler mode is off; its label and signatures are kept for next time", profileId);
    Publish();
    return completion(nil);
  }
  if (was) return completion(nil);
  if (IsLoading(profileId)) return completion(kLoading);
  if (HasPrivateSession(profileId)) return completion(kClosePrivate);
  if (HasWebKitPages(profileId)) return completion(kCloseWebKit);
  settings[@"enabled"] = @YES;
  if (name.length) settings[@"name"] = name;
  SaveProfileSettings(profileId, settings);
  CloseNetLogPages();
  if (!ardia_host::LoadedProfile(profileId)) {
    Publish();
    return completion(nil);
  }
  Convert(profileId, ^(NSString *problem) {
    if ([problem isEqualToString:kConvertSuperseded] || [problem hasPrefix:kConvertKeptOn]) return completion(problem);
    if (problem) {
      NSMutableDictionary *back = MutableSettings(profileId);
      back[@"enabled"] = @NO;
      SaveProfileSettings(profileId, back);
      Stop(profileId);
      Publish();
    }
    completion(problem);
  });
}

+ (NSString *)setHeader:(NSString *)value profile:(NSString *)profileId {
  if (NSString *problem = ProfileProblem(profileId)) return problem;
  if (value && HeaderValueProblem(value, @"the header")) return HeaderValueProblem(value, @"the header");
  NSMutableDictionary *settings = MutableSettings(profileId);
  if (value) {
    settings[@"header"] = value;
    [settings removeObjectForKey:@"headerOff"];
  } else {
    settings[@"headerOff"] = @YES;
    [settings removeObjectForKey:@"header"];
  }
  SaveProfileSettings(profileId, settings);
  Changed(profileId);
  return nil;
}

+ (NSString *)setShopifySignature:(NSString *)domain signatureInput:(NSString *)signatureInput signature:(NSString *)signature profile:(NSString *)profileId {
  if (NSString *problem = ProfileProblem(profileId)) return problem;
  NSString *host = HostOrNil(domain);
  if (!host) return @"the domain must be a bare host name such as shop.example.com";
  if (NSString *problem = HeaderValueProblem(signatureInput, @"Signature-Input")) return problem;
  if (NSString *problem = HeaderValueProblem(signature, @"Signature")) return problem;
  bool readable = true;
  ExpiryOf(signatureInput, &readable);
  if (!readable) return @"Signature-Input has an unreadable expires parameter";
  NSMutableArray<NSString *> *domains = [ShopifyDomainsFor(profileId) mutableCopy];
  if (![domains containsObject:host] && domains.count >= 64) return @"a crawler profile holds at most 64 Shopify signatures";
  if (!StoreSecret(profileId, host, @{@"signatureInput" : signatureInput, @"signature" : signature}))
    return @"the signature couldn't be saved in the keychain";
  if (![domains containsObject:host]) [domains addObject:host];
  NSMutableDictionary *settings = MutableSettings(profileId);
  settings[@"shopify"] = [domains sortedArrayUsingSelector:@selector(compare:)];
  SaveProfileSettings(profileId, settings);
  Changed(profileId);
  return nil;
}

+ (NSString *)removeShopifySignature:(NSString *)domain profile:(NSString *)profileId {
  if (NSString *problem = ProfileProblem(profileId)) return problem;
  NSString *host = HostOrNil(domain) ?: domain.lowercaseString;
  if (!StoreSecret(profileId, host, nil)) return @"the signature couldn't be removed from the keychain";
  NSMutableArray<NSString *> *domains = [ShopifyDomainsFor(profileId) mutableCopy];
  [domains removeObject:host];
  NSMutableDictionary *settings = MutableSettings(profileId);
  settings[@"shopify"] = domains;
  SaveProfileSettings(profileId, settings);
  Changed(profileId);
  return nil;
}

+ (void)reset:(NSString *)profileId completion:(void (^)(NSString *))completion {
  if (ardia_host::IsPrivateSessionId(profileId)) return completion(@"a private window can't be a crawler profile");
  if (!IsCrawler(profileId)) return completion(@"not a crawler profile");
  Reset(profileId, completion);
}

@end

namespace ardia_crawler {

void ForgetProfile(NSString *profile) {
  NSDictionary *settings = ProfileSettings(profile);
  Stop(profile);
  if (settings) {
    for (NSString *domain in ShopifyDomainsFor(profile)) StoreSecret(profile, domain, nil);
    SaveProfileSettings(profile, nil);
    NSLog(@"[crawler] profile \"%@\" was deleted: its crawler settings and signatures are gone", profile);
  }
  Publish();
}

}
