import XCTest
@testable import ArdiaUpdaterCore

final class StagedLaunchTests: XCTestCase {
  var scratch: URL!
  var root: URL { scratch.appendingPathComponent("Installation", isDirectory: true) }

  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory.appendingPathComponent("staged-launch-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  @discardableResult
  func app(in folder: URL) throws -> URL {
    let app = folder.appendingPathComponent("Ardia.app", isDirectory: true)
    try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: app.appendingPathComponent("Contents/MacOS/Ardia").path, contents: Data(), attributes: [.posixPermissions: 0o755])
    return app
  }

  func executable(of app: URL) -> URL { app.appendingPathComponent("Contents/MacOS/Ardia") }

  func testAStagedCopyInItsUpdateFolderIsLaunchable() throws {
    let staged = try app(in: root.appendingPathComponent("abc123"))
    XCTAssertTrue(StagedLaunch.launchable(staged, executable: executable(of: staged), under: root))
    let deeper = try app(in: root.appendingPathComponent("def456/unpacked"))
    XCTAssertTrue(StagedLaunch.launchable(deeper, executable: executable(of: deeper), under: root))
  }

  func testACopyOutsideTheUpdateFolderIsRefused() throws {
    let outside = try app(in: scratch.appendingPathComponent("elsewhere"))
    XCTAssertFalse(StagedLaunch.launchable(outside, executable: executable(of: outside), under: root))
    let loose = try app(in: root)
    XCTAssertFalse(StagedLaunch.launchable(loose, executable: executable(of: loose), under: root))
    let escaping = root.appendingPathComponent("abc123/../../elsewhere/Ardia.app")
    XCTAssertFalse(StagedLaunch.launchable(escaping, executable: executable(of: escaping), under: root))
  }

  func testALinkAnywhereOnThePathIsRefused() throws {
    let real = try app(in: scratch.appendingPathComponent("real"))
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: scratch.appendingPathComponent("real"))
    let throughFolder = root.appendingPathComponent("linked/Ardia.app")
    XCTAssertFalse(StagedLaunch.launchable(throughFolder, executable: executable(of: throughFolder), under: root))
    try FileManager.default.createDirectory(at: root.appendingPathComponent("abc123"), withIntermediateDirectories: true)
    let linkedApp = root.appendingPathComponent("abc123/Ardia.app")
    try FileManager.default.createSymbolicLink(at: linkedApp, withDestinationURL: real)
    XCTAssertFalse(StagedLaunch.launchable(linkedApp, executable: executable(of: linkedApp), under: root))
    let staged = try app(in: root.appendingPathComponent("def456"))
    try FileManager.default.removeItem(at: executable(of: staged))
    try FileManager.default.createSymbolicLink(at: executable(of: staged), withDestinationURL: URL(fileURLWithPath: "/usr/bin/true"))
    XCTAssertFalse(StagedLaunch.launchable(staged, executable: executable(of: staged), under: root))
  }

  func testOnlyTheBundlesOwnProgramIsLaunchable() throws {
    let staged = try app(in: root.appendingPathComponent("abc123"))
    let other = staged.appendingPathComponent("Contents/Resources/Ardia")
    try FileManager.default.createDirectory(at: other.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: other.path, contents: Data(), attributes: [.posixPermissions: 0o755])
    XCTAssertFalse(StagedLaunch.launchable(staged, executable: other, under: root))
    XCTAssertFalse(StagedLaunch.launchable(staged, executable: staged.appendingPathComponent("Contents/MacOS/../../../x"), under: root))
    XCTAssertFalse(StagedLaunch.launchable(staged, executable: staged.appendingPathComponent("Contents/MacOS/Missing"), under: root))
  }

  func testAMissingOrLinkedRootIsRefused() throws {
    let staged = try app(in: root.appendingPathComponent("abc123"))
    XCTAssertFalse(StagedLaunch.launchable(staged, executable: executable(of: staged), under: scratch.appendingPathComponent("missing")))
    let linkedRoot = scratch.appendingPathComponent("linked-root")
    try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: root)
    let throughRoot = linkedRoot.appendingPathComponent("abc123/Ardia.app")
    XCTAssertFalse(StagedLaunch.launchable(throughRoot, executable: executable(of: throughRoot), under: linkedRoot))
  }
}
