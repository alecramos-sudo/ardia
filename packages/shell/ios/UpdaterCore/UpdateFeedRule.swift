import Foundation

enum UpdateFeedRule {
  static func accepts(_ feed: String, plainHTTP: Bool) -> Bool {
    guard let url = URL(string: feed.trimmingCharacters(in: .whitespaces)), let scheme = url.scheme?.lowercased(),
      let host = url.host, !host.isEmpty, url.user == nil, url.password == nil
    else { return false }
    return scheme == "https" || (plainHTTP && scheme == "http")
  }
}
