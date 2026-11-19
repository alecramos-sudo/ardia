#import "../ios/ArdiaLaunchConfig.h"
#import "../ios/ArdiaScratchDirectory.h"

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static NSString *gRoot;
static NSString *gInstalled;

static ArdiaLaunchConfig *Config(NSDictionary<NSString *, NSString *> *environment, BOOL teamSigned, int *teamChecks = nullptr) {
  return [[ArdiaLaunchConfig alloc] initWithEnvironment:environment
                                 installedDataDirectory:gInstalled
                                             teamSigned:^BOOL {
                                               if (teamChecks) ++*teamChecks;
                                               return teamSigned;
                                             }
                                  signedForDistribution:^BOOL { return NO; }];
}

static ArdiaLaunchConfig *TeamSignedWith(NSString *dataDirectory) {
  return Config(@{@"ARDIA_DATA_DIR" : dataDirectory}, YES);
}

static BOOL Refused(NSString *dataDirectory) {
  ArdiaLaunchConfig *config = TeamSignedWith(dataDirectory);
  return config.refusedDataDirectory != nil && config.dataDirectory == nil && !config.isolated;
}

static BOOL Accepted(NSString *dataDirectory) {
  ArdiaLaunchConfig *config = TeamSignedWith(dataDirectory);
  return config.refusedDataDirectory == nil && config.dataDirectory != nil && config.isolated;
}

static NSString *Path(NSString *relative) {
  return [gRoot stringByAppendingPathComponent:relative];
}

static NSString *Installed(NSString *relative) {
  return [gInstalled stringByAppendingPathComponent:relative];
}

static void MakeDirectory(NSString *path) {
  [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:nil];
}

static void MakeFile(NSString *path) {
  MakeDirectory(path.stringByDeletingLastPathComponent);
  [NSFileManager.defaultManager createFileAtPath:path contents:[NSData data] attributes:nil];
}

static BOOL Link(NSString *link, NSString *target) {
  MakeDirectory(link.stringByDeletingLastPathComponent);
  return [NSFileManager.defaultManager createSymbolicLinkAtPath:link withDestinationPath:target error:nil];
}

static NSString *Physical(NSString *path) {
  char resolved[PATH_MAX];
  return realpath(path.fileSystemRepresentation, resolved) ? @(resolved) : nil;
}

static BOOL MakeSocket(NSString *path) {
  MakeDirectory(path.stringByDeletingLastPathComponent);
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return NO;
  struct sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof address.sun_path);
  const BOOL bound = bind(fd, (struct sockaddr *)&address, sizeof address) == 0;
  close(fd);
  return bound;
}

static NSString *ScratchWithSingletonLinks(NSString *name, NSString *socketTarget) {
  NSString *scratch = Path([@"singleton" stringByAppendingPathComponent:name]);
  NSString *chromium = [scratch stringByAppendingPathComponent:@"Chromium"];
  MakeDirectory([chromium stringByAppendingPathComponent:@"Default"]);
  Link([chromium stringByAppendingPathComponent:@"SingletonLock"], @"build-host.local-4242");
  Link([chromium stringByAppendingPathComponent:@"SingletonCookie"], @"8231093497245364093");
  Link([chromium stringByAppendingPathComponent:@"SingletonSocket"], socketTarget);
  return scratch;
}

static NSString *ScratchWithLink(NSString *name, NSString *inside, NSString *target) {
  NSString *scratch = Path([@"linked" stringByAppendingPathComponent:name]);
  MakeDirectory(scratch);
  Link([scratch stringByAppendingPathComponent:inside], target);
  return scratch;
}

int main() {
  @autoreleasepool {
    NSString *temp = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"ardia-launch-config-%d", getpid()]];
    [NSFileManager.defaultManager removeItemAtPath:temp error:nil];
    MakeDirectory(temp);
    gRoot = Physical(temp);
    gInstalled = Path(@"Application Support/com.example.browser");
    MakeDirectory(Installed(@"Chromium/Default"));
    MakeFile(Installed(@"Chromium/Default/Cookies"));
    MakeFile(Installed(@"session.json"));
    MakeFile(Installed(@"Connected Accounts.json"));
    MakeDirectory(Path(@"scratch"));
    MakeDirectory(Path(@"elsewhere/Chromium/Default"));
    Link(Path(@"to-installed"), gInstalled);
    Link(Path(@"to-chromium"), Installed(@"Chromium"));
    Link(Path(@"to-application-support"), Path(@"Application Support"));
    Link(Path(@"hop/back-out"), Path(@"Application Support"));

    {
      int teamChecks = 0;
      ArdiaLaunchConfig *config = Config(@{@"ARDIA_DATA_DIR" : @"", @"ARDIA_BACKGROUND" : @"1"}, YES, &teamChecks);
      CHECK(config.dataDirectory == nil && config.refusedDataDirectory == nil && !config.isolated && config.background);
      CHECK(teamChecks == 0);
      CHECK([config.installedDataDirectory isEqualToString:gInstalled]);
    }
    {
      ArdiaLaunchConfig *config = Config(@{}, YES);
      CHECK(config.dataDirectory == nil && config.refusedDataDirectory == nil && !config.isolated && !config.testInstance);
    }

    CHECK(Refused(gInstalled));
    CHECK(Refused([gInstalled stringByAppendingString:@"/"]));
    CHECK(Refused(Installed(@"Chromium")));
    CHECK(Refused(Installed(@"not/made/yet")));
    CHECK(![NSFileManager.defaultManager fileExistsAtPath:Installed(@"not")]);
    CHECK(Refused(gInstalled.uppercaseString));
    CHECK(Refused(Path(@"to-installed")));
    CHECK(Refused(Path(@"to-chromium")));
    CHECK(Refused(Path(@"to-application-support/com.example.browser")));
    CHECK(Refused(Path(@"to-application-support/com.example.browser/scratch")));
    CHECK(Refused(Path(@"hop/back-out/com.example.browser")));
    CHECK(Refused([Path(@"scratch/..") stringByAppendingPathComponent:@"Application Support/com.example.browser"]));
    NSString *firmlinked = [@"/System/Volumes/Data" stringByAppendingString:gInstalled];
    CHECK([NSFileManager.defaultManager fileExistsAtPath:firmlinked]);
    CHECK(Refused(firmlinked));

    CHECK(Refused(ScratchWithLink(@"chromium", @"Chromium", Installed(@"Chromium"))));
    CHECK(Refused(ScratchWithLink(@"profile", @"Chromium/Default", Installed(@"Chromium/Default"))));
    CHECK(Refused(ScratchWithLink(@"cookies", @"Chromium/Default/Cookies", Installed(@"Chromium/Default/Cookies"))));
    CHECK(Refused(ScratchWithLink(@"session", @"session.json", Installed(@"session.json"))));
    CHECK(Refused(ScratchWithLink(@"secrets", @"Connected Accounts.json", Installed(@"Connected Accounts.json"))));
    CHECK(Refused(ScratchWithLink(@"dangling", @"Chromium", Installed(@"Chromium/Profile 9"))));
    CHECK(Refused(ScratchWithLink(@"relative", @"Chromium", @"../../Application Support/com.example.browser/Chromium")));
    CHECK(Refused(ScratchWithLink(@"through-parent", @"Chromium", @"../../to-application-support/com.example.browser/Chromium")));

    CHECK(Refused(ScratchWithLink(@"elsewhere", @"Chromium", Path(@"elsewhere/Chromium"))));
    CHECK(Refused(ScratchWithLink(@"to-parent", @"Chromium/Default", Path(@"Application Support"))));
    {
      NSString *external = Path(@"external/Chromium");
      MakeDirectory(external);
      Link([external stringByAppendingPathComponent:@"Default"], Installed(@"Chromium/Default"));
      NSString *chained = ScratchWithLink(@"chained", @"Chromium", external);
      CHECK(Refused(chained));
      ArdiaLaunchConfig *adHoc = Config(@{@"ARDIA_DATA_DIR" : chained}, NO);
      CHECK(adHoc.isolated);
    }
    {
      NSString *deep = Path(@"linked/deep");
      NSString *buried = [deep stringByAppendingPathComponent:@"a/b/c/Chromium"];
      MakeDirectory(buried);
      Link([buried stringByAppendingPathComponent:@"Default"], Installed(@"Chromium/Default"));
      Link([deep stringByAppendingPathComponent:@"Chromium"], buried);
      CHECK(Refused(deep));
    }
    {
      NSString *inside = Path(@"linked/inside");
      MakeDirectory([inside stringByAppendingPathComponent:@"copies/Chromium/Default"]);
      Link([inside stringByAppendingPathComponent:@"Chromium"], [inside stringByAppendingPathComponent:@"copies/Chromium"]);
      Link([inside stringByAppendingPathComponent:@"loop"], inside);
      MakeFile(Path(@"elsewhere/session.json"));
      Link([inside stringByAppendingPathComponent:@"session.json"], Path(@"elsewhere/session.json"));
      CHECK(Accepted(inside));
    }
    {
      NSString *socketFolder = [NSString stringWithFormat:@"/tmp/ardia-lc-%d", getpid()];
      NSString *socket = [socketFolder stringByAppendingPathComponent:@"SingletonSocket"];
      CHECK(MakeSocket(socket));
      NSString *running = ScratchWithSingletonLinks(@"left-running", socket);
      CHECK(Accepted(running));
      ArdiaLaunchConfig *config = TeamSignedWith(running);
      CHECK(![config escapesScratchDirectory:[config.dataDirectory stringByAppendingPathComponent:@"Chromium"]]);
      CHECK(Accepted(ScratchWithSingletonLinks(@"crashed", [NSString stringWithFormat:@"/tmp/ardia-lc-gone-%d/SingletonSocket", getpid()])));
      [NSFileManager.defaultManager removeItemAtPath:socketFolder error:nil];
      CHECK(Accepted(running));
    }
    const NSUInteger depth = ArdiaScratchDirectory.linkDepth;
    CHECK(depth == 3);
    CHECK(Accepted(ScratchWithLink(@"past-depth", @"Chromium/Default/Local Storage/leveldb", Installed(@"Chromium/Default"))));
    {
      NSString *crowded = Path(@"crowded");
      for (NSUInteger i = 0; i < ArdiaScratchDirectory.entriesChecked; i++) MakeFile([crowded stringByAppendingPathComponent:[NSString stringWithFormat:@"file-%lu", (unsigned long)i]]);
      Link([crowded stringByAppendingPathComponent:@"Chromium/Default"], Installed(@"Chromium/Default"));
      CHECK(Accepted(crowded));
    }

    CHECK(Accepted(Path(@"scratch")));
    CHECK(Accepted(Path(@"scratch/data")));
    CHECK(Accepted(Path(@"elsewhere/not/made/yet")));
    CHECK(Accepted(Path(@"Application Support")));
    CHECK(Accepted(Path(@"Application Support/com.example.browser-other")));
    CHECK(Accepted(Path(@"Application Support/com.example")));

    {
      NSString *fresh = Path(@"fresh/data");
      ArdiaLaunchConfig *config = TeamSignedWith(fresh);
      struct stat info;
      CHECK(lstat(fresh.fileSystemRepresentation, &info) == 0 && S_ISDIR(info.st_mode) && (info.st_mode & 0777) == 0700);
      CHECK(lstat(Path(@"fresh").fileSystemRepresentation, &info) == 0 && (info.st_mode & 0777) == 0700);
      CHECK([config.dataDirectory isEqualToString:Physical(fresh)]);
      CHECK(!Link(fresh, gInstalled));
      CHECK([Physical(config.dataDirectory) isEqualToString:Physical(fresh)]);
    }
    {
      Link(Path(@"alias"), Path(@"elsewhere"));
      ArdiaLaunchConfig *config = TeamSignedWith(Path(@"alias"));
      CHECK([config.dataDirectory isEqualToString:Path(@"elsewhere")]);
      CHECK([config.engineSwitches containsObject:[@"--ardia-data-dir=" stringByAppendingString:Path(@"elsewhere")]]);
      [NSFileManager.defaultManager removeItemAtPath:Path(@"alias") error:nil];
      Link(Path(@"alias"), gInstalled);
      CHECK([config.dataDirectory isEqualToString:Path(@"elsewhere")]);
    }
    {
      MakeFile(Path(@"a-file"));
      CHECK(Refused(Path(@"a-file")));
    }
    {
      NSString *late = Path(@"late");
      ArdiaLaunchConfig *config = TeamSignedWith(late);
      CHECK(config.isolated);
      NSString *chromium = [config.dataDirectory stringByAppendingPathComponent:@"Chromium"];
      CHECK(![config escapesScratchDirectory:chromium]);
      Link(chromium, Installed(@"Chromium"));
      CHECK([config escapesScratchDirectory:chromium]);
      ArdiaLaunchConfig *adHoc = Config(@{@"ARDIA_DATA_DIR" : late}, NO);
      CHECK(![adHoc escapesScratchDirectory:chromium]);
      [NSFileManager.defaultManager removeItemAtPath:chromium error:nil];
      Link(chromium, Path(@"external/Chromium"));
      CHECK([config escapesScratchDirectory:chromium]);
      [NSFileManager.defaultManager removeItemAtPath:chromium error:nil];
      MakeDirectory([config.dataDirectory stringByAppendingPathComponent:@"copies/Chromium"]);
      Link(chromium, [config.dataDirectory stringByAppendingPathComponent:@"copies/Chromium"]);
      CHECK(![config escapesScratchDirectory:chromium]);
      [NSFileManager.defaultManager removeItemAtPath:chromium error:nil];
      Link(chromium, @"nowhere-yet");
      CHECK(![config escapesScratchDirectory:chromium]);
    }
    {
      ArdiaLaunchConfig *config = TeamSignedWith(Path(@"scratch"));
      CHECK(config.teamSigned && config.testInstance);
      CHECK([config.configDirectory isEqualToString:[Path(@"scratch") stringByAppendingPathComponent:@"config"]]);
      CHECK([config.engineSwitches containsObject:[@"--ardia-data-dir=" stringByAppendingString:Path(@"scratch")]]);
    }
    {
      ArdiaLaunchConfig *config = TeamSignedWith(gInstalled);
      CHECK([Physical(config.refusedDataDirectory) isEqualToString:gInstalled]);
      CHECK(!config.testInstance);
      for (NSString *sw in config.engineSwitches) CHECK(![sw hasPrefix:@"--ardia-data-dir="]);
      CHECK(![config.configDirectory hasPrefix:gInstalled]);
    }
    {
      ArdiaLaunchConfig *config = Config(@{@"ARDIA_DATA_DIR" : gInstalled}, NO);
      CHECK(!config.teamSigned && config.refusedDataDirectory == nil && [Physical(config.dataDirectory) isEqualToString:gInstalled] && config.isolated);
      ArdiaLaunchConfig *linked = Config(@{@"ARDIA_DATA_DIR" : Path(@"linked/chromium")}, NO);
      CHECK(linked.isolated && [Physical(linked.dataDirectory) isEqualToString:Path(@"linked/chromium")]);
    }
    {
      [NSFileManager.defaultManager removeItemAtPath:gInstalled error:nil];
      CHECK(Refused(gInstalled));
      CHECK(Refused(Installed(@"Chromium")));
      CHECK(Refused(ScratchWithLink(@"before-install", @"Chromium", Installed(@"Chromium"))));
      CHECK(Accepted(Path(@"scratch")));
    }
    [NSFileManager.defaultManager removeItemAtPath:temp error:nil];
  }
  if (failures) return 1;
  std::printf("launch-config: ok\n");
  return 0;
}
