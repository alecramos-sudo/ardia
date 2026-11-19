#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaScratchDirectory : NSObject

@property(class, readonly) NSUInteger linkDepth;
@property(class, readonly) NSUInteger entriesChecked;

+ (nullable NSString *)claim:(NSString *)requested
                   apartFrom:(NSString *)installed
                     refusal:(NSString *_Nullable *_Nullable)refusal;
+ (BOOL)entry:(NSString *)path leaves:(NSString *)root orReaches:(NSString *)installed;

@end

NS_ASSUME_NONNULL_END
