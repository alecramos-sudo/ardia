import CryptoKit
import Darwin
import Foundation

enum PayloadPin: Equatable {
  case signed(String)
  case approved(String)

  var digest: String {
    switch self {
    case .signed(let digest), .approved(let digest): return digest
    }
  }

  var mismatch: String {
    switch self {
    case .signed: return "its files don't match the ones this Ardia was signed with"
    case .approved: return "its files changed since you approved them"
    }
  }
}

enum PluginPayload {
  static let reserved: Set<String> = [".leases", ".after-update", ".after-update-claim"]
  static let caches = "__pycache__"
  static let finderInfo = ".DS_Store"
  private static let chunk = 1 << 20

  static func isDigest(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }

  static func digest(atPath path: String) -> Result<String, FolderRefusal> {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return .failure(FolderRefusal(reason: "its folder couldn't be read")) }
    defer { close(fd) }
    return digest(of: fd)
  }

  static func digest(of folder: Int32) -> Result<String, FolderRefusal> {
    var lines: [(path: [UInt8], line: Data)] = []
    if let problem = collect(folder, relative: "", into: &lines) { return .failure(FolderRefusal(reason: problem)) }
    var listing = Data()
    for entry in lines.sorted(by: { $0.path.lexicographicallyPrecedes($1.path) }) { listing.append(entry.line) }
    return .success(hex(SHA256.hash(data: listing)))
  }

  private static func collect(_ folder: Int32, relative: String, into lines: inout [(path: [UInt8], line: Data)]) -> String? {
    let place = relative.isEmpty ? "its folder" : relative
    let listing = dup(folder)
    guard listing >= 0, let directory = fdopendir(listing) else {
      if listing >= 0 { close(listing) }
      return "\(place) couldn't be read"
    }
    defer { closedir(directory) }
    rewinddir(directory)
    var names: [String] = []
    while let entry = readdir(directory) {
      let name = withUnsafeBytes(of: entry.pointee.d_name) { String(decoding: $0.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self) }
      if name != "." && name != ".." { names.append(name) }
    }
    for name in names {
      if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return "a name in \(place) has control characters" }
      if relative.isEmpty && reserved.contains(name) { continue }
      let shown = relative.isEmpty ? name : "\(relative)/\(name)"
      var info = stat()
      guard fstatat(folder, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return "\(shown) couldn't be read" }
      switch info.st_mode & S_IFMT {
      case S_IFDIR:
        if name == caches { continue }
        let child = openat(folder, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { return "\(shown) couldn't be read" }
        defer { close(child) }
        lines.append((Array(shown.utf8), Data("d \(shown)\n".utf8)))
        if let problem = collect(child, relative: shown, into: &lines) { return problem }
      case S_IFREG:
        if name == finderInfo { continue }
        let file = openat(folder, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard file >= 0 else { return "\(shown) couldn't be read" }
        defer { close(file) }
        var opened = stat()
        guard fstat(file, &opened) == 0, (opened.st_mode & S_IFMT) == S_IFREG, opened.st_ino == info.st_ino, opened.st_dev == info.st_dev else {
          return "\(shown) changed while it was read"
        }
        guard let content = contentDigest(file) else { return "\(shown) couldn't be read" }
        lines.append((Array(shown.utf8), Data("f \(String(opened.st_mode & 0o755, radix: 8)) \(content) \(shown)\n".utf8)))
      case S_IFLNK:
        return "\(shown) is a link; a plugin's programs may not contain links"
      default:
        return "\(shown) isn't a file or a folder"
      }
    }
    return nil
  }

  private static func contentDigest(_ fd: Int32) -> String? {
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: chunk)
    while true {
      let got = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if got < 0 && errno == EINTR { continue }
      if got < 0 { return nil }
      if got == 0 { return hex(hasher.finalize()) }
      buffer.withUnsafeBytes { hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[0..<got])) }
    }
  }

  private static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
    digest.map { String(format: "%02x", $0) }.joined()
  }
}
