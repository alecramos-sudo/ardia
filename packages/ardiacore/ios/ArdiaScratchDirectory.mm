#import "ArdiaScratchDirectory.h"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <climits>
#include <cstdlib>
#include <cstring>

namespace {

constexpr NSUInteger kLinkDepth = 3;
constexpr NSUInteger kEntriesChecked = 4096;

NSString *FromFileSystem(const char *path) {
  return [NSFileManager.defaultManager stringWithFileSystemRepresentation:path length:strlen(path)];
}

NSString *_Nullable PhysicalPath(NSString *path) {
  NSMutableArray<NSString *> *missing = [NSMutableArray array];
  NSString *existing = path;
  char resolved[PATH_MAX];
  while (!realpath(existing.fileSystemRepresentation, resolved)) {
    if (errno != ENOENT || existing.length <= 1) return nil;
    [missing insertObject:existing.lastPathComponent atIndex:0];
    existing = existing.stringByDeletingLastPathComponent;
  }
  NSString *physical = FromFileSystem(resolved);
  for (NSString *component in missing) {
    if ([component isEqualToString:@".."]) physical = physical.stringByDeletingLastPathComponent;
    else if (![component isEqualToString:@"."]) physical = [physical stringByAppendingPathComponent:component];
  }
  return physical;
}

BOOL SameFile(NSString *path, const struct stat &target) {
  struct stat info;
  return stat(path.fileSystemRepresentation, &info) == 0 && info.st_dev == target.st_dev && info.st_ino == target.st_ino;
}

BOOL AtOrInside(NSString *path, NSString *directory) {
  NSString *physical = PhysicalPath(path);
  if (!physical) return YES;
  NSString *physicalDirectory = PhysicalPath(directory) ?: directory;
  struct stat target;
  const BOOL directoryExists = stat(directory.fileSystemRepresentation, &target) == 0;
  for (NSString *ancestor = physical;; ancestor = ancestor.stringByDeletingLastPathComponent) {
    if ([ancestor compare:physicalDirectory options:NSCaseInsensitiveSearch] == NSOrderedSame) return YES;
    if (directoryExists && SameFile(ancestor, target)) return YES;
    if (ancestor.length <= 1) return NO;
  }
}

BOOL LinkReaches(NSString *link, NSString *directory) {
  char target[PATH_MAX];
  const ssize_t length = readlink(link.fileSystemRepresentation, target, sizeof target - 1);
  if (length <= 0) return YES;
  target[length] = 0;
  NSString *destination = FromFileSystem(target);
  if (!destination.absolutePath) destination = [link.stringByDeletingLastPathComponent stringByAppendingPathComponent:destination];
  return AtOrInside(destination, directory);
}

NSString *_Nullable LinkedFolder(NSString *link) {
  struct stat info;
  char resolved[PATH_MAX];
  if (stat(link.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode) || !realpath(link.fileSystemRepresentation, resolved)) return nil;
  return FromFileSystem(resolved);
}

BOOL HoldsEscapingLink(NSString *root, NSString *installed) {
  NSArray<NSString *> *level = @[ root ];
  NSMutableSet<NSString *> *listed = [NSMutableSet setWithObject:root];
  NSUInteger checked = 0;
  for (NSUInteger depth = 1; depth <= kLinkDepth && level.count; depth++) {
    NSMutableArray<NSString *> *next = [NSMutableArray array];
    auto descend = [&](NSString *folder) {
      if ([listed containsObject:folder]) return;
      [listed addObject:folder];
      [next addObject:folder];
    };
    for (NSString *folder in level) {
      @autoreleasepool {
        DIR *listing = opendir(folder.fileSystemRepresentation);
        if (!listing) continue;
        BOOL found = NO, exhausted = NO;
        for (struct dirent *entry; !found && !exhausted && (entry = readdir(listing));) {
          if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
          if (++checked > kEntriesChecked) {
            exhausted = YES;
            continue;
          }
          NSString *path = [folder stringByAppendingPathComponent:FromFileSystem(entry->d_name)];
          struct stat info;
          if (lstat(path.fileSystemRepresentation, &info) != 0) continue;
          if (S_ISDIR(info.st_mode)) {
            descend(path);
          } else if (S_ISLNK(info.st_mode)) {
            if (LinkReaches(path, installed)) {
              found = YES;
            } else if (NSString *linked = LinkedFolder(path)) {
              if (AtOrInside(linked, root)) descend(linked);
              else found = YES;
            }
          }
        }
        closedir(listing);
        if (found) return YES;
        if (exhausted) return NO;
      }
    }
    level = next;
  }
  return NO;
}

BOOL CreateMissingFolders(NSString *path) {
  NSMutableArray<NSString *> *missing = [NSMutableArray array];
  NSString *existing = path;
  struct stat info;
  while (lstat(existing.fileSystemRepresentation, &info) != 0) {
    if (errno != ENOENT || existing.length <= 1) return NO;
    [missing insertObject:existing.lastPathComponent atIndex:0];
    existing = existing.stringByDeletingLastPathComponent;
  }
  for (NSString *component in missing) {
    existing = [existing stringByAppendingPathComponent:component];
    if (mkdir(existing.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) return NO;
  }
  return YES;
}

NSString *_Nullable Refused(NSString *_Nullable *_Nullable refusal, NSString *reason) {
  if (refusal) *refusal = reason;
  return nil;
}

}

@implementation ArdiaScratchDirectory

+ (NSUInteger)linkDepth {
  return kLinkDepth;
}

+ (NSUInteger)entriesChecked {
  return kEntriesChecked;
}

+ (NSString *)claim:(NSString *)requested apartFrom:(NSString *)installed refusal:(NSString **)refusal {
  if (AtOrInside(requested, installed)) return Refused(refusal, @"it is this app's own data folder or inside it");
  if (!CreateMissingFolders(requested)) return Refused(refusal, @"it couldn't be created");
  char resolved[PATH_MAX];
  struct stat info;
  if (!realpath(requested.fileSystemRepresentation, resolved) || stat(resolved, &info) != 0 || !S_ISDIR(info.st_mode))
    return Refused(refusal, @"it isn't a folder");
  NSString *claimed = FromFileSystem(resolved);
  if (AtOrInside(claimed, installed)) return Refused(refusal, @"it resolves to this app's own data folder or inside it");
  if (HoldsEscapingLink(claimed, installed))
    return Refused(refusal, @"it holds a symlink into this app's own data folder or to a folder outside the scratch dir");
  return claimed;
}

+ (BOOL)entry:(NSString *)path leaves:(NSString *)root orReaches:(NSString *)installed {
  if (AtOrInside(path, installed)) return YES;
  struct stat info;
  if (lstat(path.fileSystemRepresentation, &info) != 0 || !S_ISLNK(info.st_mode)) return NO;
  NSString *linked = LinkedFolder(path);
  return linked && !AtOrInside(linked, root);
}

@end
