import ExpoModulesCore

public class FaviconsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)

    Self.calls.function
  }

  static let calls = CallTable(domain: "favicons", handlers: [
    "get": EngineCall.passing("ac_favicons_get"),
    "set": EngineCall.passing("ac_favicons_set"),
    "fetch": { args, reply in
      ArdiaFavicons.fetch(try args.text("url"), page: try args.text("page"), maxPixels: ArdiaFavicons.faviconPixels, profile: args.profile) { reply.ok($0) }
    },
  ])
}
