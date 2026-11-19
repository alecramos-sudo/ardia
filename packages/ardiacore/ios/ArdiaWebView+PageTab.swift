import AppKit

extension ArdiaWebView: PageTab {
  func startPage() {}

  func closePage() { closeBrowser() }
}
