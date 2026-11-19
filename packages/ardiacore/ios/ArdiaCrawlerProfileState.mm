#import "ArdiaCrawlerInternal.h"

namespace {

NSString *Timestamp(id date) {
  static NSISO8601DateFormatter *format = [] {
    NSISO8601DateFormatter *f = [NSISO8601DateFormatter new];
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    f.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
    return f;
  }();
  return [date isKindOfClass:NSDate.class] ? [format stringFromDate:date] : nil;
}

id OrNull(id value) { return value ?: NSNull.null; }

}

@implementation ArdiaCrawlerProfileState

- (instancetype)initWithProfile:(NSString *)profileId source:(NSString *)source name:(NSString *)name {
  if ((self = [super init])) {
    _profileId = [profileId copy];
    _source = [source copy];
    _name = [name copy];
    _shopify = @[];
    _blocked = @{};
  }
  return self;
}

- (NSArray<NSDictionary *> *)shopifyEntries {
  NSMutableArray *entries = [NSMutableArray array];
  for (NSDictionary *entry in _shopify)
    [entries addObject:@{
      @"domain" : entry[@"domain"],
      @"expires" : OrNull(Timestamp(entry[@"expires"])),
      @"sent" : @([entry[@"sent"] boolValue]),
      @"detail" : [entry[@"detail"] isKindOfClass:NSString.class] ? entry[@"detail"] : NSNull.null,
    }];
  return entries;
}

- (NSDictionary<NSString *, id> *)statusEntry {
  return @{
    @"name" : _name,
    @"source" : _source,
    @"ready" : @(_ready),
    @"reason" : OrNull(_ready ? nil : _reason),
    @"readySince" : OrNull(_ready ? Timestamp(_readySince) : nil),
    @"navigationHeader" : @(_navigationHeader),
    @"shopify" : [self shopifyEntries],
    @"blocked" : _blocked,
  };
}

- (NSDictionary<NSString *, id> *)stateEntry {
  NSMutableDictionary *entry = [[self statusEntry] mutableCopy];
  entry[@"profileId"] = _profileId;
  entry[@"detail"] = OrNull(_ready ? nil : _detail);
  return entry;
}

@end
