#import <Foundation/Foundation.h>

@class ArdiaCoreTab;

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaCrawler : NSObject
@property(class, readonly) BOOL instanceMode;
+ (NSDictionary<NSString *, id> *)state NS_SWIFT_NAME(state());
+ (BOOL)isCrawlerProfile:(NSString *)profileId NS_SWIFT_NAME(isCrawlerProfile(_:));
+ (BOOL)isReadyProfile:(NSString *)profileId NS_SWIFT_NAME(isReady(_:));
+ (BOOL)refusesTabsInProfile:(nullable NSString *)profileId NS_SWIFT_NAME(refusesTabs(_:));
+ (BOOL)refusesTab:(ArdiaCoreTab *)tab NS_SWIFT_NAME(refuses(tab:));
+ (BOOL)refusesWebKitInProfile:(nullable NSString *)profileId NS_SWIFT_NAME(refusesWebKit(_:));
+ (BOOL)refusesURL:(nullable NSString *)url NS_SWIFT_NAME(refuses(url:));
+ (void)setWebKitContainment:(void (^)(NSString *profile, void (^done)(void)))contain
                       clear:(void (^)(NSString *profile, void (^done)(void)))clear NS_SWIFT_NAME(setWebKitContainment(_:clear:));
+ (void)setWebKitPagesQuery:(BOOL (^)(NSString *profile))hasPages NS_SWIFT_NAME(setWebKitPagesQuery(_:));
+ (void)setProfile:(NSString *)profileId
           enabled:(BOOL)enabled
              name:(nullable NSString *)name
        completion:(void (^)(NSString *_Nullable problem))completion NS_SWIFT_NAME(setProfile(_:enabled:name:completion:));
+ (nullable NSString *)setHeader:(nullable NSString *)value profile:(NSString *)profileId NS_SWIFT_NAME(setHeader(_:profile:));
+ (nullable NSString *)setShopifySignature:(NSString *)domain
                            signatureInput:(NSString *)signatureInput
                                 signature:(NSString *)signature
                                   profile:(NSString *)profileId
    NS_SWIFT_NAME(setShopifySignature(domain:signatureInput:signature:profile:));
+ (nullable NSString *)removeShopifySignature:(NSString *)domain profile:(NSString *)profileId
    NS_SWIFT_NAME(removeShopifySignature(domain:profile:));
+ (void)reset:(NSString *)profileId completion:(void (^)(NSString *_Nullable problem))completion NS_SWIFT_NAME(reset(_:completion:));
@end

NS_ASSUME_NONNULL_END
