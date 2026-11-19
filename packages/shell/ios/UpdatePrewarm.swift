import AppKit
import ArdiaCore
import Darwin
import Sparkle

enum UpdatePrewarm {
  static let timeout: TimeInterval = 90
  static let installHold: TimeInterval = 15
  static let lastRunKey = "ACUpdatePrewarm"
  static let statusStarted = -1
  static let statusSpawnFailed = -2
  static let statusRejected = -3
  static let statusStopped = Int(SIGKILL)
  private static var started = Set<String>()
  private static var runningVersion: String?
  private static var attempt: Attempt?
  private static var generation = 0
  private static var afterRun: [() -> Void] = []
  private static var watchingQuit = false

  static func start(version: String) {
    guard !started.contains(version) else { return }
    started.insert(version)
    warm(version: version)
  }

  static func warm(version: String) {
    guard runningVersion != version, LaunchConfig.shared.switchOn("updatePrewarm"),
      let staged = stagedApp(version: version), let executable = staged.executableURL
    else { return }
    stop()
    launch(staged.bundleURL, executable: executable, version: version)
  }

  static func beforeInstall(version: String, install: @escaping () -> Void) {
    warm(version: version)
    guard runningVersion == version else { return install() }
    var waiting = true
    let proceed = {
      guard waiting else { return }
      waiting = false
      install()
    }
    afterRun.append(proceed)
    DispatchQueue.main.asyncAfter(deadline: .now() + installHold, execute: proceed)
  }

  static func stop() {
    attempt?.stop()
    attempt = nil
    runningVersion = nil
    generation += 1
  }

  static func signedLikeThisApp(_ bundle: URL) -> Bool {
    guard let requirement = ownRequirement else { return false }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else { return false }
    return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures), requirement) == errSecSuccess
  }

  static func runsAsThisApp(_ pid: pid_t) -> Bool {
    guard let requirement = ownRequirement else { return false }
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess, let code else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }

  private static let ownRequirement: SecRequirement? = {
    var running: SecCode?
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
      SecCodeCopyStaticCode(running, [], &code) == errSecSuccess, let code,
      SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess
    else { return nil }
    return requirement
  }()

  private typealias DisclaimResponsibility = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

  private static let disclaimResponsibility: DisclaimResponsibility? =
    dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim").map { unsafeBitCast($0, to: DisclaimResponsibility.self) }

  private static func spawnSuspended(_ executable: URL, environment: [String: String]) throws -> pid_t {
    guard let disclaim = disclaimResponsibility else { throw POSIXError(.ENOSYS) }
    var attributes: posix_spawnattr_t?
    try succeeded(posix_spawnattr_init(&attributes))
    defer { posix_spawnattr_destroy(&attributes) }
    var noSignals = sigset_t()
    sigemptyset(&noSignals)
    var allSignals = sigset_t()
    sigfillset(&allSignals)
    try succeeded(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)))
    try succeeded(posix_spawnattr_setsigmask(&attributes, &noSignals))
    try succeeded(posix_spawnattr_setsigdefault(&attributes, &allSignals))
    try succeeded(disclaim(&attributes, 1))
    var actions: posix_spawn_file_actions_t?
    try succeeded(posix_spawn_file_actions_init(&actions))
    defer { posix_spawn_file_actions_destroy(&actions) }
    for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
      try succeeded(posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == STDIN_FILENO ? O_RDONLY : O_WRONLY, 0))
    }
    let arguments: [UnsafeMutablePointer<CChar>?] = [strdup(executable.path), nil]
    let variables: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { (arguments + variables).forEach { free($0) } }
    var pid: pid_t = 0
    try succeeded(posix_spawn(&pid, executable.path, &actions, &attributes, arguments, variables))
    return pid
  }

  private static func succeeded(_ result: Int32) throws {
    guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: result) ?? .EINVAL) }
  }

  private final class Attempt {
    let version: String
    private let began = Date()
    private let lock = NSLock()
    private var settled = false
    private var pid: pid_t = 0
    private var exitWatch: DispatchSourceProcess?

    init(version: String) {
      self.version = version
      UpdatePrewarm.save(version: version, status: UpdatePrewarm.statusStarted, ms: 0)
    }

    var running: Bool {
      lock.lock()
      defer { lock.unlock() }
      return !settled && pid != 0
    }

    func spawn(_ start: () throws -> pid_t, ended: @escaping () -> Void) throws -> pid_t? {
      lock.lock()
      defer { lock.unlock() }
      guard !settled else { return nil }
      let child = try start()
      pid = child
      let watch = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .global(qos: .utility))
      watch.setEventHandler {
        self.reap(child)
        ended()
      }
      exitWatch = watch
      watch.resume()
      return child
    }

    func resume(_ child: pid_t) {
      lock.lock()
      defer { lock.unlock() }
      if !settled { kill(child, SIGCONT) }
    }

    func reject(_ child: pid_t) {
      lock.lock()
      defer { lock.unlock() }
      if !settled { kill(child, SIGKILL) }
      settle(status: UpdatePrewarm.statusRejected)
    }

    func stop() {
      lock.lock()
      defer { lock.unlock() }
      if !settled, pid != 0 { kill(pid, SIGKILL) }
      settle(status: UpdatePrewarm.statusStopped)
    }

    func record(status: Int) {
      lock.lock()
      defer { lock.unlock() }
      settle(status: status)
    }

    private func reap(_ child: pid_t) {
      lock.lock()
      defer { lock.unlock() }
      var status: Int32 = 0
      let reaped = waitpid(child, &status, 0) == child
      exitWatch?.cancel()
      exitWatch = nil
      settle(status: reaped ? Self.ending(status) : UpdatePrewarm.statusStopped)
    }

    private static func ending(_ status: Int32) -> Int {
      let signal = status & 0x7f
      return Int(signal == 0 ? (status >> 8) & 0xff : signal)
    }

    private func settle(status: Int) {
      guard !settled else { return }
      settled = true
      pid = 0
      let ms = Int(Date().timeIntervalSince(began) * 1000)
      UpdatePrewarm.save(version: version, status: status, ms: ms)
      NSLog("Ardia: prewarmed update \(version) in \(ms) ms (status \(status))")
    }
  }

  private static func save(version: String, status: Int, ms: Int) {
    UserDefaults.standard.set(["build": version, "at": Date().timeIntervalSince1970 * 1000, "ms": ms, "status": status], forKey: lastRunKey)
  }

  private static func launch(_ bundle: URL, executable: URL, version: String) {
    if !watchingQuit {
      watchingQuit = true
      NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in stop() }
    }
    generation += 1
    let current = generation
    let tried = Attempt(version: version)
    attempt = tried
    runningVersion = version
    var env = LaunchConfig.shared.environmentForChildProcesses.filter { !$0.key.hasPrefix("DYLD_") }
    env["ARDIA_PREWARM"] = "1"
    DispatchQueue.global(qos: .utility).async {
      guard let root = StagedUpdateCopies.installationRoot(), StagedLaunch.launchable(bundle, executable: executable, under: root),
        signedLikeThisApp(bundle)
      else {
        tried.record(status: statusRejected)
        NSLog("Ardia: not prewarming \(bundle.path): it isn't a plain copy in Sparkle's folder signed like this app")
        return DispatchQueue.main.async { finish(current) }
      }
      let child: pid_t
      do {
        let ended = {
          DispatchQueue.main.async { finish(current) }
          DispatchQueue.global(qos: .utility).async { StagedUpdateCopies.unregister(bundle) }
        }
        guard let spawned = try tried.spawn({ try spawnSuspended(executable, environment: env) }, ended: ended) else { return }
        child = spawned
      } catch {
        tried.record(status: statusSpawnFailed)
        NSLog("Ardia: couldn't prewarm update \(version): \(error.localizedDescription)")
        return DispatchQueue.main.async { finish(current) }
      }
      guard runsAsThisApp(child) else {
        NSLog("Ardia: not prewarming \(bundle.path): the program it started isn't signed like this app")
        return tried.reject(child)
      }
      tried.resume(child)
      DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
        guard attempt === tried, tried.running else { return }
        NSLog("Ardia: update prewarm still running after \(Int(timeout)) s; stopping it")
        stop()
      }
    }
  }

  private static func finish(_ which: Int) {
    guard which == generation else { return }
    runningVersion = nil
    attempt = nil
    let waiting = afterRun
    afterRun = []
    waiting.forEach { $0() }
  }

  static func stagedApp(version: String, bundleId: String? = Bundle.main.bundleIdentifier, caches: URL? = StagedUpdateCopies.userCaches) -> Bundle? {
    stagedApps(bundleId: bundleId, caches: caches)
      .filter { $0.bundle.infoDictionary?["CFBundleVersion"] as? String == version }
      .max { $0.modified < $1.modified }?.bundle
  }

  static func stagedApps(bundleId: String? = Bundle.main.bundleIdentifier, caches: URL? = StagedUpdateCopies.userCaches) -> [(bundle: Bundle, modified: Date)] {
    StagedUpdateCopies.copies(bundleId: bundleId, caches: caches).filter { staged in
      staged.bundle.executableURL.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false
    }
  }
}
