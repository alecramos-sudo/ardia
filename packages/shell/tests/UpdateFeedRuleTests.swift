import XCTest
@testable import ArdiaUpdaterCore

final class UpdateFeedRuleTests: XCTestCase {
  func testAnHttpsFeedIsTakenInEveryBuild() {
    XCTAssertTrue(UpdateFeedRule.accepts("https://ardia.dev/appcast.xml", plainHTTP: false))
    XCTAssertTrue(UpdateFeedRule.accepts("https://ardia.mini/fork/appcast.xml", plainHTTP: false))
    XCTAssertTrue(UpdateFeedRule.accepts(" HTTPS://ardia.dev/appcast.xml ", plainHTTP: false))
  }

  func testPlainHttpIsTakenOnlyWhereItIsAllowed() {
    XCTAssertFalse(UpdateFeedRule.accepts("http://ardia.dev/appcast.xml", plainHTTP: false))
    XCTAssertFalse(UpdateFeedRule.accepts("http://127.0.0.1:8000/appcast.xml", plainHTTP: false))
    XCTAssertTrue(UpdateFeedRule.accepts("http://127.0.0.1:8000/appcast.xml", plainHTTP: true))
  }

  func testAnythingElseIsRefused() {
    for feed in ["", "appcast.xml", "file:///tmp/appcast.xml", "ftp://ardia.dev/appcast.xml", "https://", "https:///appcast.xml",
                 "https://user:secret@ardia.dev/appcast.xml", "javascript:alert(1)"] {
      XCTAssertFalse(UpdateFeedRule.accepts(feed, plainHTTP: true), feed)
    }
  }
}
