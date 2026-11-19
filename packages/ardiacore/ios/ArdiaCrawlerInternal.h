#import "ArdiaInternal.h"
#import "ArdiaCrawler.h"

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaCrawlerProfileState : NSObject
@property(copy) NSString *profileId;
@property(copy) NSString *name;
@property(copy) NSString *source;
@property BOOL ready;
@property(copy, nullable) NSString *reason;
@property(copy, nullable) NSString *detail;
@property(nullable) NSDate *readySince;
@property BOOL navigationHeader;
@property(copy) NSArray<NSDictionary<NSString *, id> *> *shopify;
@property(copy) NSDictionary<NSString *, NSNumber *> *blocked;
@property NSUInteger generation;
@property BOOL extensionLoaded;
@property BOOL held;
@property BOOL configured;
@property BOOL containing;
@property BOOL converting;
@property BOOL blockAll;
@property BOOL deleting;
@property NSUInteger expiryTimer;
- (instancetype)initWithProfile:(NSString *)profileId source:(NSString *)source name:(NSString *)name;
- (NSDictionary<NSString *, id> *)statusEntry;
- (NSDictionary<NSString *, id> *)stateEntry;
@end

@interface ArdiaCrawlerSelfTest : NSObject <ArdiaCoreTabDelegate>
+ (void)runInProfile:(ArdiaCoreProfile *)profile
               named:(NSString *)name
          completion:(void (^)(NSString *_Nullable reason, NSString *_Nullable detail))completion;
+ (void)cancelInProfile:(NSString *)name;
@end

namespace ardia_crawler {

extern NSString *const kExtensionId;
extern NSString *const kSelfTestURL;
extern NSString *const kReasonSelfTestFailed;
extern NSString *const kReasonConfigureFailed;
extern NSString *const kReasonTimeout;
extern NSString *const kReasonRefusedNotScratch;
extern NSString *const kReasonOther;
extern NSString *const kSourceInstance;
extern NSString *const kSourceProfile;
extern const NSTimeInterval kExpiryMarginSeconds;

bool InstanceRequested();
bool InstanceAllowed();
bool RulesFailTest();
bool NetLogOn();
bool IsNetLogPage(NSString *_Nullable url);
bool NetLogPageOpen();
bool SignaturesInstalled();
NSDate *Now();
bool Sleeping();
void SetSleeping(bool sleeping);
void NoteClockOffset(NSTimeInterval seconds);
NSString *_Nullable WithheldBecause(NSDictionary<NSString *, NSString *> *entry, NSDate *now);
NSString *_Nullable ExtensionPath();
NSString *RulesVersion();
NSString *DisplayName(NSString *profile);

NSArray<NSString *> *ProfileIds();
NSDictionary<NSString *, id> *_Nullable ProfileSettings(NSString *profile);
void SaveProfileSettings(NSString *profile, NSDictionary<NSString *, id> *_Nullable settings);
bool IsCrawler(NSString *profile);
NSString *SourceOf(NSString *profile);
NSString *_Nullable HeaderFor(NSString *profile);
NSArray<NSString *> *ShopifyDomainsFor(NSString *profile);
void SignaturesFor(NSString *profile, void (^completion)(NSArray<NSDictionary<NSString *, NSString *> *> *entries, NSString *_Nullable error));

NSString *_Nullable HostOrNil(NSString *_Nullable value);
NSString *_Nullable HeaderValueProblem(NSString *_Nullable value, NSString *what);
NSDate *_Nullable ExpiryOf(NSString *signatureInput, bool *readable);
bool StoreSecret(NSString *profile, NSString *domain, NSDictionary<NSString *, NSString *> *_Nullable secret);
NSDictionary<NSString *, NSString *> *_Nullable LoadSecret(NSString *profile, NSString *domain);

NSMutableDictionary<NSString *, ArdiaCrawlerProfileState *> *States();
NSDictionary<NSString *, id> *StateSnapshot();
void Publish();
NSString *StatusPath();

void Start(NSString *profile);
void Stop(NSString *profile);
void Reset(NSString *profile, void (^done)(NSString *_Nullable problem));
void Reconfigure(NSString *profile);
void ReconfigureAll(void (^_Nullable done)(void));
void RemoveSignaturesForSleep(void (^done)(void));
ArdiaCrawlerProfileState *_Nullable Current(NSString *profile, NSUInteger generation);
NSArray<NSDictionary *> *Withholding(NSArray<NSDictionary *> *shopify, NSString *detail);
void Fail(NSString *profile, NSUInteger generation, NSString *reason, NSString *_Nullable detail, void (^_Nullable done)(void));

void BeforeDelete(NSString *profile, void (^done)(NSString *_Nullable problem));
void WhenContained(NSString *profile, void (^then)(void));
bool WipeBeforeLoad(NSString *profile, NSString *_Nullable *_Nonnull problem);
bool OwnsDataDirectory();
bool WipeCrawlerProfilesBeforeLaunch(NSString *_Nullable *_Nonnull problem);
void RefuseLoad(NSString *profile, NSString *problem);
void ForgetGoneProfiles();
void ForgetProfile(NSString *profile);
void WatchPower();
NSUInteger NextToken();
bool TokenLive(NSString *profile, NSUInteger token);
NSString *PageKey(NSString *profile);

NSString *Json(id value);
extern NSString *const kSuperseded;
void Bridge(NSString *profile, NSUInteger token, NSString *expression, void (^completion)(id _Nullable value, NSString *_Nullable error));
void BridgeBuilt(NSString *profile, NSUInteger token, void (^build)(void (^go)(NSString *_Nullable expression, NSString *_Nullable problem)),
                 void (^completion)(id _Nullable value, NSString *_Nullable error));
void AbortBridge(NSString *profile);
NSString *FailClosedExpression();
NSString *RulesetExpression();
NSString *RemoveSignatureRulesExpression();
NSString *ConfigureExpression(NSDictionary *config);
void TestBridgeFault(bool retriable);
void TestFailAll();
void TestReconfigureAll();
void TestLogRules();
void TestDelayNextSignatureRead();
void TestDelayNextSelfTest();

void Contain(NSString *profile, NSUInteger token, void (^done)(NSString *_Nullable problem));
void ClearSiteData(NSString *profile, void (^done)(void));
void ClearSiteDataWithin(NSString *profile, void (^done)(BOOL cleared));
extern NSString *const kConvertKeptOn;
void CloseNetLogPages();
bool HasPrivateSession(NSString *profile);
bool HasWebKitPages(NSString *profile);
bool IsLoading(NSString *profile);
void SetWebKitPagesQuery(BOOL (^_Nullable hasPages)(NSString *profile));
extern NSString *const kConvertSuperseded;
void Convert(NSString *profile, void (^done)(NSString *_Nullable problem));
void SetWebKitContainment(void (^_Nullable contain)(NSString *profile, void (^done)(void)), void (^_Nullable clear)(NSString *profile, void (^done)(void)));
void Terminate(NSString *profile, NSString *reason);
void RetryWaitingPages();

}

namespace ardia_host {
void StartCrawler(NSString *profile);
NSArray<ArdiaCoreTab *> *PopupTabs();
NSArray<NSString *> *ChromiumSwitchList(NSString *switches);
}

NS_ASSUME_NONNULL_END
