import Foundation

enum StagedLaunch {
  static func launchable(_ bundle: URL, executable: URL, under root: URL) -> Bool {
    let base = root.standardizedFileURL
    let parts = bundle.standardizedFileURL.pathComponents
    guard kind(base) == S_IFDIR, bundle.pathExtension == "app", parts.count >= base.pathComponents.count + 2,
      Array(parts.prefix(base.pathComponents.count)) == base.pathComponents
    else { return false }
    var folder = base
    for name in parts.dropFirst(base.pathComponents.count) + ["Contents", "MacOS"] {
      folder.appendPathComponent(name, isDirectory: true)
      guard kind(folder) == S_IFDIR else { return false }
    }
    let program = executable.standardizedFileURL
    return program.deletingLastPathComponent().pathComponents == folder.pathComponents && kind(program) == S_IFREG
  }

  private static func kind(_ url: URL) -> mode_t? {
    var info = stat()
    guard lstat(url.path, &info) == 0 else { return nil }
    return info.st_mode & S_IFMT
  }
}
