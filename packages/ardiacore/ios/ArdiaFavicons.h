#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFavicons : NSObject
@property(class, readonly) NSInteger faviconPixels;
+ (void)fetch:(NSString *)url
          page:(NSString *)page
     maxPixels:(NSInteger)maxPixels
       profile:(NSString *)profile
    completion:(void (^)(NSDictionary<NSString *, id> *_Nullable result))completion
    NS_SWIFT_NAME(fetch(_:page:maxPixels:profile:completion:));
@end

NS_ASSUME_NONNULL_END
