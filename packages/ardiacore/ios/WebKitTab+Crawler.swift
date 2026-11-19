import WebKit

extension WebKitTab {
  static let crawlerSiteData = ["siteData", "cache"]

  private static let crawlerContainment: Void = {
    ArdiaCrawler.setWebKitContainment({ profile, done in
      let hub = WebKitHub.shared
      for tab in hub.transfers.liveTabs where ArdiaCrawler.refusesWebKit(tab.profile) { tab.close() }
      hub.transfers.closeViews(using: hub.stores.dataStore(for: profile))
      done()
    }, clear: { profile, done in
      WebKitHub.shared.clearBrowsingData(profile: profile, types: crawlerSiteData, since: 0, completion: done)
    })
    ArdiaCrawler.setWebKitPagesQuery { profile in
      let hub = WebKitHub.shared
      let store = hub.stores.dataStore(for: profile)
      return hub.transfers.liveTabs.contains { $0.profile == profile || $0.profile.hasSuffix("@" + profile) }
        || hub.transfers.views.contains { $0.configuration.websiteDataStore === store }
        || hub.downloads.hasUnfinished(profile: profile)
    }
  }()

  static func installCrawlerContainment() { _ = crawlerContainment }

  var crawlerRefuses: Bool {
    guard ArdiaCrawler.refusesWebKit(profile) else { return false }
    NSLog("[crawler] refused a WebKit page in crawler profile \"%@\": crawler profiles are Chromium only", profile)
    return true
  }
}
