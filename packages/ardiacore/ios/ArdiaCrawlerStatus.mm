#import "ArdiaCrawlerInternal.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

using namespace ardia_crawler;

namespace {

constexpr int kStatusVersion = 1;

NSString *StatusDirectory() {
  return [[ArdiaHost.dataDirectory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"crawler"];
}

NSArray<ArdiaCrawlerProfileState *> *Listed() {
  ForgetGoneProfiles();
  NSMutableDictionary<NSString *, ArdiaCrawlerProfileState *> *listed = [States() mutableCopy];
  if (!InstanceRequested()) {
    for (NSString *profile in ProfileIds()) {
      if (listed[profile] || ardia_host::IsDeletedProfile(profile)) continue;
      ArdiaCrawlerProfileState *idle = [[ArdiaCrawlerProfileState alloc] initWithProfile:profile source:kSourceProfile name:DisplayName(profile)];
      idle.detail = @"not loaded";
      NSMutableArray *shopify = [NSMutableArray array];
      for (NSString *domain in ShopifyDomainsFor(profile))
        [shopify addObject:@{@"domain" : domain, @"expires" : NSNull.null, @"sent" : @NO, @"detail" : @"not loaded"}];
      idle.shopify = shopify;
      listed[profile] = idle;
    }
  }
  return [listed.allValues sortedArrayUsingComparator:^NSComparisonResult(ArdiaCrawlerProfileState *a, ArdiaCrawlerProfileState *b) {
    return [a.profileId compare:b.profileId];
  }];
}

NSString *StartedAt() {
  static NSString *started = [] {
    struct kinfo_proc info = {};
    size_t size = sizeof info;
    int name[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
    NSDate *at = NSDate.date;
    if (sysctl(name, 4, &info, &size, nullptr, 0) == 0 && size == sizeof info)
      at = [NSDate dateWithTimeIntervalSince1970:info.kp_proc.p_starttime.tv_sec + info.kp_proc.p_starttime.tv_usec / 1e6];
    NSISO8601DateFormatter *format = [NSISO8601DateFormatter new];
    format.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    format.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    return [format stringFromDate:at];
  }();
  return started;
}

bool WriteAtomically(NSData *data, NSString *directory, NSString *path) {
  mkdir(directory.fileSystemRepresentation, 0700);
  chmod(directory.fileSystemRepresentation, 0700);
  NSString *temp = [path stringByAppendingFormat:@".%d.tmp", getpid()];
  const int fd = open(temp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  const bool written = write(fd, data.bytes, data.length) == (ssize_t)data.length && fchmod(fd, 0600) == 0 && fsync(fd) == 0;
  close(fd);
  if (written && rename(temp.fileSystemRepresentation, path.fileSystemRepresentation) == 0) return true;
  unlink(temp.fileSystemRepresentation);
  return false;
}

void WriteStatus(NSArray<ArdiaCrawlerProfileState *> *listed) {
  NSMutableDictionary *profiles = [NSMutableDictionary dictionary];
  for (ArdiaCrawlerProfileState *state in listed) profiles[state.profileId] = [state statusEntry];
  NSDictionary *status = @{
    @"version" : @(kStatusVersion),
    @"pid" : @(getpid()),
    @"startedAt" : StartedAt(),
    @"rulesVersion" : RulesVersion(),
    @"profiles" : profiles,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:status options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
  static NSData *last;
  if (!data || [data isEqualToData:last]) return;
  if (WriteAtomically(data, StatusDirectory(), StatusPath())) last = data;
  else NSLog(@"[crawler] the status file didn't write: %s", strerror(errno));
}

}

namespace ardia_crawler {

NSMutableDictionary<NSString *, ArdiaCrawlerProfileState *> *States() {
  static NSMutableDictionary *states = [NSMutableDictionary dictionary];
  return states;
}

NSString *StatusPath() { return [StatusDirectory() stringByAppendingPathComponent:@"status.json"]; }

NSDictionary<NSString *, id> *StateSnapshot() {
  NSMutableArray *profiles = [NSMutableArray array];
  for (ArdiaCrawlerProfileState *state in Listed()) [profiles addObject:[state stateEntry]];
  return @{@"instanceMode" : @(InstanceRequested()), @"rulesVersion" : RulesVersion(), @"profiles" : profiles};
}

void Publish() {
  NSArray<ArdiaCrawlerProfileState *> *listed = Listed();
  if (InstanceRequested() || listed.count || [NSFileManager.defaultManager fileExistsAtPath:StatusPath()]) WriteStatus(listed);
  [ArdiaEvents emit:@"crawler.changed" data:[[ArdiaConsentStamp begin] onto:StateSnapshot()]];
}

}
