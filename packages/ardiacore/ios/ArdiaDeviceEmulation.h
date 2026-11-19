#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaDeviceEmulation : NSObject
+ (void)startForTab:(NSString *)tabId
             preset:(NSDictionary<NSString *, id> *)preset
         completion:(void (^)(NSDictionary<NSString *, id> *_Nullable result, NSString *_Nullable error))completion
    NS_SWIFT_NAME(start(tab:preset:completion:));
+ (void)stopForTab:(NSString *)tabId completion:(void (^)(BOOL stopped))completion NS_SWIFT_NAME(stop(tab:completion:));
+ (NSArray<NSString *> *)emulatedTabs;
+ (nullable NSDictionary<NSString *, id> *)fitWindowOfTab:(NSString *)tabId toPage:(NSSize)page NS_SWIFT_NAME(fitWindow(tab:page:));
+ (BOOL)setFrame:(NSArray<NSNumber *> *)frame ofWindowOfTab:(NSString *)tabId NS_SWIFT_NAME(setFrame(_:ofWindowOfTab:));
@end

NS_ASSUME_NONNULL_END
