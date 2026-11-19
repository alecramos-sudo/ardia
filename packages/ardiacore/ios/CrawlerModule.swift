import ExpoModulesCore

public class CrawlerModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    Self.calls.function
  }

  static func answer(_ reply: CallReply, _ error: String?) {
    reply.ok(error ?? NSNull())
  }

  static let calls = CallTable(domain: "crawler", handlers: [
    "state": { _, reply in
      WebKitTab.installCrawlerContainment()
      reply.ok(ArdiaCrawler.state())
    },
    "setProfile": { args, reply in
      WebKitTab.installCrawlerContainment()
      ArdiaCrawler.setProfile(try args.text("profileId"), enabled: try args.bool("enabled"), name: try args.optionalText("name")) { answer(reply, $0) }
    },
    "setHeader": { args, reply in
      answer(reply, ArdiaCrawler.setHeader(try args.optionalText("value"), profile: try args.text("profileId")))
    },
    "setShopifySignature": { args, reply in
      answer(reply, ArdiaCrawler.setShopifySignature(
        domain: try args.text("domain"), signatureInput: try args.text("signatureInput"), signature: try args.text("signature"),
        profile: try args.text("profileId")))
    },
    "removeShopifySignature": { args, reply in
      answer(reply, ArdiaCrawler.removeShopifySignature(domain: try args.text("domain"), profile: try args.text("profileId")))
    },
    "reset": { args, reply in
      ArdiaCrawler.reset(try args.text("profileId")) { answer(reply, $0) }
    },
  ])
}
