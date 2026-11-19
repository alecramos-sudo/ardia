#import "ArdiaCrawlerInternal.h"
#import "ArdiaHostInternal.h"
#import "ArdiaLaunchConfig.h"

#import <Security/Security.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ardia_crawler {

NSString *const kExtensionId = @"jphbnffonbejilmcbfhnpjfmblejpcgc";
NSString *const kSelfTestURL = @"https://ardia-crawler-selftest.invalid/";
NSString *const kReasonSelfTestFailed = @"selftest_failed";
NSString *const kReasonConfigureFailed = @"configure_failed";
NSString *const kReasonTimeout = @"timeout";
NSString *const kReasonRefusedNotScratch = @"refused_not_scratch";
NSString *const kReasonOther = @"other";
NSString *const kSourceInstance = @"instance";
NSString *const kSourceProfile = @"profile";
const NSTimeInterval kExpiryMarginSeconds = 60;

const NSTimeInterval kSignatureReadSeconds = 10;

}

namespace {

using namespace ardia_crawler;

NSString *const kProfilesDefaultsKey = @"ArdiaCrawlerProfiles";
NSString *const kSecretsService = @"Ardia Crawler Signatures";
NSString *const kIsolatedSecretsFile = @"Crawler Signatures.json";
NSString *const kBundledName = @"ardia-crawler";
constexpr NSUInteger kMaxHeaderLength = 4096;
constexpr off_t kMaxSignaturesFileBytes = 1 << 20;

NSString *RunId() {
  static NSString *run;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    uint8_t bytes[6];
    arc4random_buf(bytes, sizeof bytes);
    NSMutableString *hex = [NSMutableString string];
    for (uint8_t byte : bytes) [hex appendFormat:@"%02x", byte];
    run = hex;
  });
  return run;
}

NSString *DefaultHeader() { return [@"qa; run=" stringByAppendingString:RunId()]; }

NSString *InstanceHeader() { return [ArdiaLaunchConfig.shared instance:@"crawlerHeader"] ?: DefaultHeader(); }

NSArray<NSDictionary<NSString *, NSString *> *> *ReadEntries(id parsed, NSString **problem) {
  if (![parsed isKindOfClass:NSArray.class]) {
    *problem = @"the Shopify signatures file isn't a JSON list";
    return nil;
  }
  NSMutableArray *entries = [NSMutableArray array];
  NSUInteger index = 0;
  for (id entry in parsed) {
    NSDictionary *e = [entry isKindOfClass:NSDictionary.class] ? entry : nil;
    NSString *domain = HostOrNil([e[@"domain"] isKindOfClass:NSString.class] ? e[@"domain"] : nil);
    NSString *input = [e[@"signatureInput"] isKindOfClass:NSString.class] ? e[@"signatureInput"] : nil;
    NSString *signature = [e[@"signature"] isKindOfClass:NSString.class] ? e[@"signature"] : nil;
    if (!domain || HeaderValueProblem(input, @"signatureInput") || HeaderValueProblem(signature, @"signature") || e.count != 3) {
      *problem = [NSString stringWithFormat:@"the Shopify signatures file's entry %lu isn't {domain, signatureInput, signature}", (unsigned long)index];
      return nil;
    }
    [entries addObject:@{@"domain" : domain, @"signatureInput" : input, @"signature" : signature}];
    index++;
  }
  return entries;
}

NSArray<NSDictionary<NSString *, NSString *> *> *ReadSignaturesFile(NSString *path, NSString **problem) {
  const int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) {
    *problem = @"the Shopify signatures file can't be opened (missing, or a symbolic link)";
    return nil;
  }
  struct stat info;
  NSMutableData *data = nil;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    *problem = @"the Shopify signatures file isn't a regular file";
  } else if (info.st_uid != getuid()) {
    *problem = @"the Shopify signatures file isn't owned by this user";
  } else if ((info.st_mode & 0777) != 0600) {
    *problem = @"the Shopify signatures file's mode isn't 0600";
  } else if (info.st_size > kMaxSignaturesFileBytes) {
    *problem = @"the Shopify signatures file is too large";
  } else {
    data = [NSMutableData dataWithLength:(NSUInteger)info.st_size];
    const ssize_t read = info.st_size ? pread(fd, data.mutableBytes, (size_t)info.st_size, 0) : 0;
    if (read != info.st_size) {
      *problem = @"the Shopify signatures file can't be read";
      data = nil;
    }
  }
  close(fd);
  if (!data) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return ReadEntries(parsed, problem);
}

NSArray<NSDictionary<NSString *, NSString *> *> *InstanceSignatures(NSString **problem) {
  static NSArray *entries;
  static NSString *failure;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *path = [ArdiaLaunchConfig.shared instance:@"crawlerShopifySignatures"];
    if (!path.length) {
      entries = @[];
      return;
    }
    NSString *readProblem;
    entries = ReadSignaturesFile(path.stringByExpandingTildeInPath, &readProblem);
    failure = readProblem;
    if (failure) NSLog(@"[crawler] %@", failure);
  });
  *problem = failure;
  return entries;
}

NSUserDefaults *Defaults() { return NSUserDefaults.standardUserDefaults; }

NSDictionary<NSString *, NSDictionary *> *SavedProfiles() {
  NSDictionary *saved = [Defaults() dictionaryForKey:kProfilesDefaultsKey];
  return [saved isKindOfClass:NSDictionary.class] ? saved : @{};
}

NSString *SecretAccount(NSString *profile, NSString *domain) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:@[ profile, domain ] options:0 error:nil];
  return [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
}

NSDictionary *SecretQuery(NSString *account) {
  return @{(id)kSecClass : (id)kSecClassGenericPassword, (id)kSecAttrService : kSecretsService, (id)kSecAttrAccount : account};
}

NSString *IsolatedSecretsPath() {
  NSString *dir = ArdiaLaunchConfig.shared.dataDirectory;
  return dir ? [dir stringByAppendingPathComponent:kIsolatedSecretsFile] : nil;
}

NSLock *IsolatedLock() {
  static NSLock *lock = [NSLock new];
  return lock;
}

NSMutableDictionary<NSString *, NSDictionary *> *LoadIsolated() {
  NSData *data = [NSData dataWithContentsOfFile:IsolatedSecretsPath()];
  NSDictionary *all = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : @{};
  return [all isKindOfClass:NSDictionary.class] ? [all mutableCopy] : nil;
}

bool SaveIsolated(NSDictionary *all) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:all options:0 error:nil];
  NSString *path = IsolatedSecretsPath();
  NSString *temp = [path stringByAppendingFormat:@".%d.tmp", getpid()];
  const int fd = open(temp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  const bool written = data && write(fd, data.bytes, data.length) == (ssize_t)data.length && fchmod(fd, 0600) == 0;
  close(fd);
  if (written && rename(temp.fileSystemRepresentation, path.fileSystemRepresentation) == 0) return true;
  unlink(temp.fileSystemRepresentation);
  return false;
}

}

namespace ardia_crawler {

bool InstanceRequested() { return [ArdiaLaunchConfig.shared instanceFlag:@"crawler"]; }

bool InstanceAllowed() { return ardia_host::gScratchDataDir; }

static bool NamesNetLog(NSString *word) {
  NSString *name = [word componentsSeparatedByString:@"="].firstObject.lowercaseString;
  while ([name hasPrefix:@"-"]) name = [name substringFromIndex:1];
  return [name hasPrefix:@"net-log"] || [name hasPrefix:@"log-net-log"];
}

bool NetLogOn() {
  static bool on = [] {
    NSMutableArray<NSString *> *words = [NSProcessInfo.processInfo.arguments mutableCopy];
    if (NSString *switches = [ArdiaLaunchConfig.shared instance:@"chromiumSwitches"])
      [words addObjectsFromArray:ardia_host::ChromiumSwitchList(switches)];
    for (NSString *word in words)
      if (NamesNetLog(word)) return true;
    return false;
  }();
  return on;
}

static NSString *WithoutViewSource(NSString *url) {
  NSString *rest = [url stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  while ([rest.lowercaseString hasPrefix:@"view-source:"])
    rest = [[rest substringFromIndex:12] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return rest;
}

static bool NamesNetLogHost(NSString *host) {
  NSString *name = host.stringByRemovingPercentEncoding.lowercaseString ?: host.lowercaseString;
  while ([name hasSuffix:@"."]) name = [name substringToIndex:name.length - 1];
  return [name isEqualToString:@"net-export"] || [name isEqualToString:@"net-internals"];
}

bool IsNetLogPage(NSString *url) {
  if (![url isKindOfClass:NSString.class] || !url.length) return false;
  NSString *rest = WithoutViewSource(url);
  const NSRange colon = [rest rangeOfString:@":"];
  if (colon.location == NSNotFound) return false;
  NSString *scheme = [rest substringToIndex:colon.location].lowercaseString;
  if (![@[ @"chrome", @"chrome-untrusted", @"ardia", @"about" ] containsObject:scheme]) return false;
  NSString *after = [rest substringFromIndex:NSMaxRange(colon)];
  while ([after hasPrefix:@"/"] || [after hasPrefix:@"\\"]) after = [after substringFromIndex:1];
  NSRange end = [after rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/?#\\:"]];
  NSString *host = end.location == NSNotFound ? after : [after substringToIndex:end.location];
  return NamesNetLogHost(host);
}

static NSTimeInterval gClockOffset = 0;

static bool gSleeping = false;

bool Sleeping() { return gSleeping; }

void SetSleeping(bool sleeping) { gSleeping = sleeping; }

NSDate *Now() { return [NSDate dateWithTimeIntervalSinceNow:gClockOffset]; }

void NoteClockOffset(NSTimeInterval seconds) { gClockOffset = MAX(0, seconds); }

NSString *WithheldBecause(NSDictionary<NSString *, NSString *> *entry, NSDate *now) {
  bool readable = true;
  NSDate *expires = ExpiryOf(entry[@"signatureInput"] ?: @"", &readable);
  if (!readable) return @"its expiry can't be read";
  if (expires && [expires timeIntervalSinceDate:now] <= kExpiryMarginSeconds) return @"expired";
  if (Sleeping()) return @"the Mac is going to sleep";
  if (NetLogOn()) return @"NetLog is on";
  if (NetLogPageOpen()) return @"NetLog may be recording";
  return nil;
}

bool RulesFailTest() { return [ArdiaLaunchConfig.shared testFlag:@"crawlerRulesFail"]; }

NSString *ExtensionPath() {
  NSString *bundled = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:[@"Extensions" stringByAppendingPathComponent:kBundledName]];
  return [NSFileManager.defaultManager fileExistsAtPath:[bundled stringByAppendingPathComponent:@"manifest.json"]] ? bundled : nil;
}

NSString *RulesVersion() {
  static NSString *version;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *path = [ExtensionPath() stringByAppendingPathComponent:@"rules/vendors.json"];
    NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
    NSDictionary *table = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    version = [table isKindOfClass:NSDictionary.class] && [table[@"rulesVersion"] isKindOfClass:NSString.class] ? table[@"rulesVersion"] : @"";
  });
  return version;
}

NSString *DisplayName(NSString *profile) {
  NSString *saved = [ProfileSettings(profile)[@"name"] isKindOfClass:NSString.class] ? ProfileSettings(profile)[@"name"] : nil;
  if (saved.length) return saved;
  return profile.length ? profile : @"Default";
}

NSArray<NSString *> *ProfileIds() {
  NSMutableArray<NSString *> *ids = [NSMutableArray array];
  [SavedProfiles() enumerateKeysAndObjectsUsingBlock:^(NSString *profile, NSDictionary *settings, BOOL *) {
    if ([settings isKindOfClass:NSDictionary.class] && [settings[@"enabled"] boolValue]) [ids addObject:profile];
  }];
  return [ids sortedArrayUsingSelector:@selector(compare:)];
}

NSDictionary<NSString *, id> *ProfileSettings(NSString *profile) {
  NSDictionary *settings = SavedProfiles()[profile ?: @""];
  return [settings isKindOfClass:NSDictionary.class] ? settings : nil;
}

void SaveProfileSettings(NSString *profile, NSDictionary<NSString *, id> *settings) {
  NSMutableDictionary *all = [SavedProfiles() mutableCopy];
  all[profile ?: @""] = settings;
  [Defaults() setObject:all forKey:kProfilesDefaultsKey];
}

bool IsCrawler(NSString *profile) {
  if (ardia_host::IsPrivateSessionId(profile)) return false;
  return InstanceRequested() || [ProfileSettings(profile)[@"enabled"] boolValue];
}

NSString *SourceOf(NSString *profile) { return InstanceRequested() ? kSourceInstance : kSourceProfile; }

NSString *HeaderFor(NSString *profile) {
  if (InstanceRequested()) return InstanceHeader();
  NSDictionary *settings = ProfileSettings(profile);
  if ([settings[@"headerOff"] boolValue]) return nil;
  NSString *header = [settings[@"header"] isKindOfClass:NSString.class] ? settings[@"header"] : nil;
  return header.length ? header : DefaultHeader();
}

NSArray<NSString *> *ShopifyDomainsFor(NSString *profile) {
  if (InstanceRequested()) {
    NSString *problem;
    NSMutableArray *domains = [NSMutableArray array];
    for (NSDictionary *entry in InstanceSignatures(&problem) ?: @[]) [domains addObject:entry[@"domain"]];
    return domains;
  }
  NSArray *saved = ProfileSettings(profile)[@"shopify"];
  return [saved isKindOfClass:NSArray.class] ? saved : @[];
}

static bool gTestDelayNextRead = false;

void TestDelayNextSignatureRead() { gTestDelayNextRead = true; }

void SignaturesFor(NSString *profile, void (^completion)(NSArray<NSDictionary<NSString *, NSString *> *> *, NSString *)) {
  completion = [completion copy];
  if (gTestDelayNextRead) {
    gTestDelayNextRead = false;
    void (^late)(NSArray *, NSString *) = completion;
    NSLog(@"[crawler] test: this signature read answers 2 s late");
    completion = [^(NSArray *entries, NSString *problem) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSLog(@"[crawler] test: the late signature read answers now (%lu signatures)", (unsigned long)entries.count);
        late(entries, problem);
      });
    } copy];
  }
  if (InstanceRequested()) {
    NSString *problem;
    NSArray *entries = InstanceSignatures(&problem);
    return completion(entries ?: @[], problem);
  }
  NSArray<NSString *> *domains = ShopifyDomainsFor(profile);
  if (!domains.count) return completion(@[], nil);
  __block bool answered = false;
  void (^once)(NSArray *, NSString *) = completion;
  completion = [^(NSArray *entries, NSString *problem) {
    if (answered) return;
    answered = true;
    once(entries, problem);
  } copy];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSignatureReadSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (!answered) NSLog(@"[crawler] profile \"%@\": the keychain didn't answer within %.0f s; no signature is sent", profile, kSignatureReadSeconds);
    completion(@[], @"the keychain didn't answer in time");
  });
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSMutableArray *entries = [NSMutableArray array];
    NSString *problem;
    for (NSString *domain in domains) {
      NSDictionary *secret = LoadSecret(profile, domain);
      if (!secret) {
        problem = [NSString stringWithFormat:@"the Shopify signature for %@ isn't in the keychain", domain];
        continue;
      }
      [entries addObject:@{@"domain" : domain, @"signatureInput" : secret[@"signatureInput"], @"signature" : secret[@"signature"]}];
    }
    dispatch_async(dispatch_get_main_queue(), ^{ completion(entries, problem); });
  });
}

NSString *HostOrNil(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSString *host = value.lowercaseString;
  static NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:@"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,62}$"
                           options:0
                             error:nil];
  return [pattern firstMatchInString:host options:0 range:NSMakeRange(0, host.length)] ? host : nil;
}

NSString *HeaderValueProblem(NSString *value, NSString *what) {
  if (![value isKindOfClass:NSString.class]) return [what stringByAppendingString:@" must be a string"];
  bool printable = value.length > 0 && value.length <= kMaxHeaderLength;
  for (NSUInteger i = 0; printable && i < value.length; i++) {
    const unichar c = [value characterAtIndex:i];
    printable = c >= 0x20 && c <= 0x7e;
  }
  if (printable && [value isEqualToString:[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]]) return nil;
  return [NSString stringWithFormat:@"%@ isn't a valid header value (printable ASCII, no CR or LF, no surrounding spaces, 1 to %lu characters)",
                                    what, (unsigned long)kMaxHeaderLength];
}

NSDate *ExpiryOf(NSString *signatureInput, bool *readable) {
  *readable = true;
  static NSRegularExpression *quoted = [NSRegularExpression regularExpressionWithPattern:@"\"(?:[^\"\\\\]|\\\\.)*\"" options:0 error:nil];
  static NSRegularExpression *expires = [NSRegularExpression regularExpressionWithPattern:@";\\s*expires=([^;,\\s]*)" options:0 error:nil];
  NSString *outside = [quoted stringByReplacingMatchesInString:signatureInput options:0 range:NSMakeRange(0, signatureInput.length)
                                                  withTemplate:@"\"\""];
  NSDate *earliest = nil;
  for (NSTextCheckingResult *match in [expires matchesInString:outside options:0 range:NSMakeRange(0, outside.length)]) {
    NSString *seconds = [outside substringWithRange:[match rangeAtIndex:1]];
    const bool digits = seconds.length >= 1 && seconds.length <= 12 &&
                        [seconds rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet].location == NSNotFound;
    if (!digits) {
      *readable = false;
      return nil;
    }
    NSDate *at = [NSDate dateWithTimeIntervalSince1970:seconds.doubleValue];
    earliest = earliest ? [earliest earlierDate:at] : at;
  }
  return earliest;
}

bool StoreSecret(NSString *profile, NSString *domain, NSDictionary<NSString *, NSString *> *secret) {
  NSString *account = SecretAccount(profile, domain);
  if (IsolatedSecretsPath()) {
    [IsolatedLock() lock];
    NSMutableDictionary *all = LoadIsolated();
    if (all) all[account] = secret;
    const bool saved = all && SaveIsolated(all);
    [IsolatedLock() unlock];
    return saved;
  }
  if (!secret) {
    const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)SecretQuery(account));
    return status == errSecSuccess || status == errSecItemNotFound;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:secret options:0 error:nil];
  if (!data) return false;
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)SecretQuery(account), (__bridge CFDictionaryRef) @{(id)kSecValueData : data});
  if (status == errSecItemNotFound) {
    NSMutableDictionary *add = [SecretQuery(account) mutableCopy];
    add[(id)kSecValueData] = data;
    add[(id)kSecAttrLabel] = [@"Ardia crawler signature: " stringByAppendingString:domain];
    status = SecItemAdd((__bridge CFDictionaryRef)add, nil);
  }
  return status == errSecSuccess;
}

NSDictionary<NSString *, NSString *> *LoadSecret(NSString *profile, NSString *domain) {
  NSString *account = SecretAccount(profile, domain);
  id stored = nil;
  if (IsolatedSecretsPath()) {
    [IsolatedLock() lock];
    stored = LoadIsolated()[account];
    [IsolatedLock() unlock];
  } else {
    NSMutableDictionary *query = [SecretQuery(account) mutableCopy];
    query[(id)kSecReturnData] = @YES;
    query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
#if DEBUG
    query[(id)kSecUseAuthenticationUI] = (id)kSecUseAuthenticationUIFail;
#endif
    CFTypeRef item = nullptr;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &item) == errSecSuccess && item) {
      NSData *data = (__bridge_transfer NSData *)item;
      stored = [data isKindOfClass:NSData.class] ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    }
  }
  if (![stored isKindOfClass:NSDictionary.class]) return nil;
  NSString *input = stored[@"signatureInput"], *signature = stored[@"signature"];
  if (![input isKindOfClass:NSString.class] || ![signature isKindOfClass:NSString.class]) return nil;
  return @{@"signatureInput" : input, @"signature" : signature};
}

}
