#import "ArdiaCrawlerInternal.h"
#import "ArdiaHostInternal.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

using namespace ardia_crawler;

namespace {

NSString *const kOwnerLockName = @"ArdiaCrawlerOwner.lock";

NSSet<NSString *> *SiteStorageNames() {
  static NSSet *names = [NSSet setWithArray:@[
    @"Service Worker", @"IndexedDB", @"Local Storage", @"Session Storage", @"Sessions", @"Cookies", @"Network", @"Cache",
    @"Code Cache", @"GPUCache", @"DawnGraphiteCache", @"DawnWebGPUCache", @"Shared Storage", @"SharedStorage", @"Shared Dictionary",
    @"File System", @"WebStorage", @"blob_storage", @"databases", @"Storage", @"Trust Tokens", @"DIPS", @"Platform Notifications",
    @"Reporting and NEL", @"TransportSecurity", @"Network Persistent State", @"Site Characteristics Database", @"BudgetDatabase",
    @"Download Service", @"PersistentOriginTrials", @"SCT Auditing Pending Reports", @"Interest Groups", @"Attribution Reporting",
    @"Aggregation Service", @"Conversions", @"Private Aggregation", @"Federated Credential Management", @"Background Fetch",
    @"Background Sync", @"Sessions_Encrypted", @"heavy_ad_intervention_opt_out.db", @"Network Action Predictor",
  ]];
  return names;
}

NSString *BaseName(NSString *name) {
  for (NSString *suffix in @[ @"-journal", @"-wal", @"-shm" ])
    if ([name hasSuffix:suffix]) return [name substringToIndex:name.length - suffix.length];
  return name;
}

bool IsSingleComponent(NSString *name) {
  if (!name.length || name.length > NAME_MAX) return false;
  if ([name isEqualToString:@"."] || [name isEqualToString:@".."]) return false;
  return [name rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/:\0"]].location == NSNotFound;
}

NSString *ResolvedPath(NSString *path) {
  char resolved[PATH_MAX];
  return realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
}

bool IsPlainDirectory(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) == 0 && S_ISDIR(info.st_mode);
}

bool Exists(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) == 0;
}

bool ResolvesInside(NSString *directory, NSString *root, NSString *rest) {
  NSString *resolvedRoot = ResolvedPath(root);
  NSString *resolved = ResolvedPath(directory);
  return resolvedRoot && resolved && [resolved isEqualToString:[resolvedRoot stringByAppendingPathComponent:rest]];
}

bool WipeDirectory(NSString *directory, NSString **problem) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSError *listError;
  NSArray<NSString *> *names = [files contentsOfDirectoryAtPath:directory error:&listError];
  if (!names) {
    *problem = [NSString stringWithFormat:@"can't list %@ (%@)", directory.lastPathComponent, listError.localizedDescription];
    return false;
  }
  for (NSString *name in names) {
    if (![SiteStorageNames() containsObject:BaseName(name)]) continue;
    NSString *path = [directory stringByAppendingPathComponent:name];
    NSError *removeError;
    if ([files removeItemAtPath:path error:&removeError] || !Exists(path)) continue;
    *problem = [NSString stringWithFormat:@"can't remove %@ (%@)", name, removeError.localizedDescription];
    return false;
  }
  return true;
}

NSString *CachesRoot() { return NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject; }

NSString *CacheTwinSuffix(NSString *directory) {
  NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  NSString *prefix = [support stringByAppendingString:@"/"];
  return support.length && [directory hasPrefix:prefix] ? [directory substringFromIndex:prefix.length] : nil;
}

bool WipeProfileDirectory(NSString *chromium, NSString *directoryName, NSString *why, NSString **problem) {
  if (!IsSingleComponent(directoryName)) {
    *problem = [NSString stringWithFormat:@"\"%@\" isn't a profile folder name", directoryName];
    return false;
  }
  if (!IsPlainDirectory(chromium)) {
    *problem = @"the data folder isn't a plain directory";
    return false;
  }
  NSString *directory = [chromium stringByAppendingPathComponent:directoryName];
  if (!Exists(directory)) return true;
  if (!IsPlainDirectory(directory) || !ResolvesInside(directory, chromium, directoryName)) {
    *problem = [NSString stringWithFormat:@"%@ isn't a plain directory inside the data folder", directoryName];
    return false;
  }
  if (!WipeDirectory(directory, problem)) return false;
  if (NSString *suffix = CacheTwinSuffix(directory)) {
    NSString *twin = [CachesRoot() stringByAppendingPathComponent:suffix];
    if (Exists(twin)) {
      if (!IsPlainDirectory(twin) || !ResolvesInside(twin, CachesRoot(), suffix)) {
        *problem = [NSString stringWithFormat:@"the cache folder of %@ isn't a plain directory", directoryName];
        return false;
      }
      if (!WipeDirectory(twin, problem)) return false;
    }
  }
  NSLog(@"[crawler] %@ \"%@\": site storage wiped before the engine loads it", why, directoryName);
  return true;
}

int gOwnerLock = -1;

bool ChromiumRunsHereElsewhere(NSString *chromium) {
  char target[1024];
  const ssize_t length = readlink([chromium stringByAppendingPathComponent:@"SingletonLock"].fileSystemRepresentation, target, sizeof target - 1);
  if (length < 0) return errno != ENOENT;
  if (length == 0 || length >= (ssize_t)sizeof target - 1) return true;
  target[length] = 0;
  NSString *holder = @(target);
  const NSRange dash = [holder rangeOfString:@"-" options:NSBackwardsSearch];
  if (dash.location == NSNotFound) return true;
  char host[256] = {0};
  if (gethostname(host, sizeof host - 1) != 0 || ![[holder substringToIndex:dash.location] isEqualToString:@(host)]) return true;
  const pid_t pid = (pid_t)[holder substringFromIndex:NSMaxRange(dash)].intValue;
  if (pid <= 0) return true;
  if (pid == getpid()) return false;
  return kill(pid, 0) == 0 || errno == EPERM;
}

}

namespace ardia_crawler {

bool OwnsDataDirectory() {
  NSString *chromium = ArdiaHost.dataDirectory;
  if (!chromium.length || !IsPlainDirectory(chromium)) return false;
  if (ChromiumRunsHereElsewhere(chromium)) {
    NSLog(@"[crawler] another Ardia runs on this data folder (its Chromium holds SingletonLock); crawler storage stays untouched");
    return false;
  }
  if (gOwnerLock >= 0) return true;
  NSString *path = [chromium stringByAppendingPathComponent:kOwnerLockName];
  const int fd = open(path.fileSystemRepresentation, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || flock(fd, LOCK_EX | LOCK_NB) != 0) {
    close(fd);
    return false;
  }
  if (ChromiumRunsHereElsewhere(chromium)) {
    close(fd);
    return false;
  }
  gOwnerLock = fd;
  return true;
}

bool WipeBeforeLoad(NSString *profile, NSString **problem) {
  if (!profile.length || ardia_host::IsPrivateSessionId(profile) || !IsCrawler(profile)) return true;
  if (!OwnsDataDirectory()) {
    *problem = @"another Ardia is using this data folder";
    return false;
  }
  return WipeProfileDirectory(ArdiaHost.dataDirectory, ardia_host::ProfileDirectoryName(profile), @"crawler profile", problem);
}

bool WipeCrawlerProfilesBeforeLaunch(NSString **problem) {
  NSString *chromium = ArdiaHost.dataDirectory;
  if (!chromium.length) return true;
  if (InstanceRequested()) {
    if (!InstanceAllowed()) return true;
    if (!OwnsDataDirectory()) {
      *problem = @"another Ardia is using this data folder";
      return false;
    }
    NSError *listError;
    NSArray<NSString *> *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:chromium error:&listError];
    if (!names) {
      *problem = [NSString stringWithFormat:@"can't list the data folder (%@)", listError.localizedDescription];
      return false;
    }
    for (NSString *name in names)
      if ([name isEqualToString:@"Default"] || [name hasPrefix:@"Profile "])
        if (!WipeProfileDirectory(chromium, name, @"crawler instance profile", problem)) return false;
    return true;
  }
  NSArray<NSString *> *crawlers = [ProfileIds() filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]];
  if (!crawlers.count || !OwnsDataDirectory()) return true;
  for (NSString *profile in crawlers) {
    NSString *skipped;
    if (!WipeProfileDirectory(chromium, ardia_host::ProfileDirectoryName(profile), @"crawler profile", &skipped))
      NSLog(@"[crawler] profile \"%@\": its storage couldn't be wiped at launch (%@); it won't load", profile, skipped);
  }
  return true;
}

}
