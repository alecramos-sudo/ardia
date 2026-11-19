import AppKit
import Carbon.HIToolbox
import ExpoModulesCore

final class MagnifyArea: ExpoView {
  let onMagnify = EventDispatcher()
  var enabled = true
  var passesThrough = false
  private static let areas = NSHashTable<MagnifyArea>.weakObjects()
  private static weak var owner: MagnifyArea?
  private static var claimed = false
  private static var total = 0.0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    _ = installMagnifyMonitor
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil { Self.areas.add(self) } else { Self.areas.remove(self) }
  }

  private static func area(at location: NSPoint, in window: NSWindow) -> MagnifyArea? {
    guard let hit = window.contentView?.superview?.hitTest(location) else { return nil }
    return areas.allObjects.first { $0.enabled && $0.window === window && !$0.isHiddenOrHasHiddenAncestor && hit.isDescendant(of: $0) }
  }

  static func route(window: NSWindow?, location: NSPoint, phase: NSEvent.Phase, magnification: Double) -> Bool {
    if phase.contains(.began) {
      owner = window.flatMap { area(at: location, in: $0) }
      claimed = owner != nil
      total = 0
    }
    guard claimed else { return false }
    total += magnification
    let finished = phase.contains(.ended) || phase.contains(.cancelled)
    let name = phase.contains(.ended) ? "ended" : phase.contains(.cancelled) ? "cancelled" : phase.contains(.began) ? "began" : "changed"
    let swallowed = !(owner?.passesThrough ?? false)
    owner?.onMagnify(["phase": name, "magnification": total])
    if finished {
      owner = nil
      claimed = false
    }
    return swallowed
  }

  static func devMagnify(windowId: String, x: Double, y: Double, steps: [[String: Any]]) -> [String: Any] {
    guard let window = WindowManager.shared.window(windowId), let content = window.contentView else { return ["error": "no window \(windowId)"] }
    let location = content.convert(SyntheticInput.contentPoint(x: x, top: y, in: content), to: nil)
    let hit = content.superview?.hitTest(location)
    let phases: [String: NSEvent.Phase] = ["began": .began, "changed": .changed, "ended": .ended, "cancelled": .cancelled]
    var claims: [Bool] = []
    for step in steps {
      let phase = phases[step["phase"] as? String ?? ""] ?? .changed
      claims.append(route(window: window, location: location, phase: phase, magnification: step["magnification"] as? Double ?? 0))
    }
    return ["claimed": claims, "hit": hit.map { String(describing: type(of: $0)) } ?? "nil"]
  }

  static func devMagnifyThrough(windowId: String, x: Double, y: Double, steps: [[String: Any]]) -> [String: Any] {
    guard let window = WindowManager.shared.window(windowId), let content = window.contentView else { return ["error": "no window \(windowId)"] }
    let location = content.convert(SyntheticInput.contentPoint(x: x, top: y, in: content), to: nil)
    let gesturePhases: [String: Int64] = ["began": 1, "changed": 2, "ended": 4, "cancelled": 8]
    var claims: [Bool] = []
    var receivers: [String] = []
    for step in steps {
      guard let cg = CGEvent(source: nil) else { return ["error": "no CGEvent"] }
      cg.setIntegerValueField(CGEventField(rawValue: 55)!, value: 29)
      cg.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
      cg.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)
      cg.setDoubleValueField(CGEventField(rawValue: 113)!, value: step["magnification"] as? Double ?? 0)
      cg.setIntegerValueField(CGEventField(rawValue: 132)!, value: gesturePhases[step["phase"] as? String ?? ""] ?? 2)
      guard let event = NSEvent(cgEvent: cg), event.type == .magnify else { return ["error": "not a magnify event"] }
      let swallowed = route(window: window, location: location, phase: event.phase, magnification: Double(event.magnification))
      claims.append(swallowed)
      if swallowed { continue }
      let receiver = content.superview?.hitTest(location)
      receivers.append(receiver.map { String(describing: type(of: $0)) } ?? "nil")
      receiver?.magnify(with: event)
    }
    return ["claimed": claims, "deliveredTo": Array(Set(receivers))]
  }
}

let installMagnifyMonitor: Void = {
  _ = NSEvent.addLocalMonitorForEvents(matching: [.magnify]) { event in
    MagnifyArea.route(window: event.window, location: event.locationInWindow, phase: event.phase, magnification: Double(event.magnification)) ? nil : event
  }
}()
