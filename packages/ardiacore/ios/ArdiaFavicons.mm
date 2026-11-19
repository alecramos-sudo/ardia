#import "ArdiaInternal.h"

namespace {

constexpr NSInteger kFaviconPixels = 64;

NSCache<NSString *, NSImage *> *Seen() {
  static NSCache *cache = [] {
    NSCache *c = [NSCache new];
    c.countLimit = 512;
    return c;
  }();
  return cache;
}

NSString *SeenKey(NSString *profile, NSString *url) {
  return [NSString stringWithFormat:@"%@\n%@", profile ?: @"", url];
}

NSData *PNG(NSImage *image, int pixels, int *width, int *height) {
  if (!image || image.size.width <= 0 || image.size.height <= 0) return nil;
  NSImageRep *best = nil;
  NSInteger bestSize = 0;
  for (NSImageRep *rep in image.representations) {
    NSInteger size = MAX(rep.pixelsWide, rep.pixelsHigh);
    if (size <= 0) size = NSIntegerMax;
    const bool better = !best || (bestSize < pixels ? size > bestSize : (size >= pixels && size < bestSize));
    if (better) best = rep, bestSize = size;
  }
  if (!best) return nil;
  const int side = (int)MIN((NSInteger)pixels, bestSize);
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:side pixelsHigh:side bitsPerSample:8
                                                                samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                                                                 colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  if (!context) return nil;
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  context.imageInterpolation = NSImageInterpolationHigh;
  NSSize size = best.size.width > 0 && best.size.height > 0 ? best.size : image.size;
  CGFloat scale = side / MAX(size.width, size.height);
  NSRect rect = NSMakeRect((side - size.width * scale) / 2, (side - size.height * scale) / 2, size.width * scale, size.height * scale);
  [best drawInRect:rect fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1 respectFlipped:YES hints:nil];
  [NSGraphicsContext restoreGraphicsState];
  *width = side;
  *height = side;
  return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

NSDictionary *Result(NSImage *image, NSInteger maxPixels) {
  int width = 0, height = 0;
  NSData *png = PNG(image, (int)maxPixels, &width, &height);
  if (!png.length) return nil;
  NSString *uri = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
  return @{@"uri" : uri, @"width" : @(width), @"height" : @(height)};
}

void WithLoadedProfile(NSString *profileName, void (^use)(ArdiaCoreProfile *_Nullable profile)) {
  if (ardia_host::IsPrivateProfile(profileName)) return use(ardia_host::LoadedProfile(profileName));
  ardia_host::WithProfile(profileName, use);
}

}

@implementation ArdiaFavicons

+ (NSInteger)faviconPixels {
  return kFaviconPixels;
}

+ (void)noteImage:(NSImage *)image forURL:(NSString *)url profile:(NSString *)profile {
  if (image && url.length) [Seen() setObject:image forKey:SeenKey(profile, url)];
}

+ (NSDictionary<NSString *, id> *)resultForImage:(NSImage *)image maxPixels:(NSInteger)maxPixels {
  return Result(image, maxPixels);
}

+ (void)downloadFavicon:(NSString *)url
                fromTab:(ArdiaCoreTab *)tab
                profile:(NSString *)profile
             completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if (NSImage *seen = url.length ? [Seen() objectForKey:SeenKey(profile, url)] : nil) return completion(Result(seen, kFaviconPixels));
  if (!tab || !url.length) return completion(nil);
  [tab downloadImage:url inFrame:nil maxPixels:kFaviconPixels favicon:YES completion:^(NSImage *image) {
    completion(Result(image, kFaviconPixels));
  }];
}

+ (void)fetch:(NSString *)url
          page:(NSString *)page
     maxPixels:(NSInteger)maxPixels
       profile:(NSString *)profile
    completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if (NSImage *seen = url.length ? [Seen() objectForKey:SeenKey(profile, url)] : nil) return completion(Result(seen, maxPixels));
  WithLoadedProfile(profile, ^(ArdiaCoreProfile *loaded) {
    if (!loaded || loaded.destroyed) return completion(nil);
    [loaded fetchIcon:url forPage:page maxPixels:maxPixels completion:^(NSImage *image) {
      completion(Result(image, maxPixels));
    }];
  });
}

@end
