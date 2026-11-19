#import "ardia/core/public/ArdiaCore.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/sys_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/data_url.h"
#include "net/base/mime_sniffer.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "net/url_request/redirect_info.h"
#include "ardia/core/ardiacore_internal.h"
#include "services/data_decoder/public/cpp/data_decoder.h"
#include "services/data_decoder/public/cpp/decode_image.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/client_security_state.mojom.h"
#include "services/network/public/mojom/fetch_api.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "skia/ext/skia_utils_mac.h"
#include "third_party/blink/public/common/mime_util/mime_util.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"

namespace {

using IconCompletion = void (^)(NSImage* _Nullable);

constexpr base::TimeDelta kTimeout = base::Seconds(30);
constexpr size_t kMaxBytes = 2 * 1024 * 1024;
constexpr uint64_t kMaxDecodedBytes = 4 * 1024 * 1024;
constexpr NSInteger kMostPixels = 1024;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_icon_fetch", R"(
      semantics {
        sender: "Ardia favicons"
        description:
          "Downloads the favicon of a page the browser shows without a live "
          "tab (a restored or unloaded tab, a bookmark, a history entry), or "
          "an icon a page in a WebKit tab names. The request carries the "
          "page's origin as its initiator and never reaches a loopback or "
          "local network address."
        trigger: "The sidebar, bookmarks or history list a page with no icon."
        data: "None: no cookies, credentials or client certificates are sent."
        destination: WEBSITE
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

bool IsAvif(std::string_view body) {
  if (body.size() < 16 || body.substr(4, 4) != "ftyp") {
    return false;
  }
  const size_t box = std::min<size_t>(
      body.size(), (size_t{static_cast<uint8_t>(body[0])} << 24) |
                       (size_t{static_cast<uint8_t>(body[1])} << 16) |
                       (size_t{static_cast<uint8_t>(body[2])} << 8) |
                       size_t{static_cast<uint8_t>(body[3])});
  for (size_t at = 8; at + 4 <= box; at += at == 8 ? 8 : 4) {
    const std::string_view brand = body.substr(at, 4);
    if (brand == "avif" || brand == "avis") {
      return true;
    }
  }
  return false;
}

bool IsBitmapImage(std::string_view body) {
  if (body.empty()) {
    return false;
  }
  if (IsAvif(body)) {
    return blink::IsSupportedImageMimeType("image/avif");
  }
  if (body.starts_with(std::string_view("\x00\x00\x02\x00", 4))) {
    return true;
  }
  std::string sniffed;
  return net::SniffMimeTypeFromLocalData(body, &sniffed) &&
         (sniffed == "image/png" || sniffed == "image/jpeg" ||
          sniffed == "image/gif" || sniffed == "image/webp" ||
          sniffed == "image/x-icon" || sniffed == "image/bmp");
}

bool MixedContent(const GURL& page, const GURL& target) {
  return page.SchemeIsCryptographic() && !target.SchemeIsCryptographic();
}

bool AllowedFor(const GURL& page, const GURL& target) {
  if (!page.is_valid() || !page.SchemeIsHTTPOrHTTPS() || !target.is_valid()) {
    return false;
  }
  if (target.SchemeIs(url::kDataScheme)) {
    return true;
  }
  return target.SchemeIsHTTPOrHTTPS() && !MixedContent(page, target);
}

network::mojom::ClientSecurityStatePtr PublicClient(const GURL& page) {
  auto client = network::mojom::ClientSecurityState::New();
  client->is_web_secure_context = page.SchemeIsCryptographic();
  client->ip_address_space = network::mojom::IPAddressSpace::kPublic;
  client->local_network_access_request_policy =
      network::mojom::LocalNetworkAccessRequestPolicy::kBlock;
  return client;
}

data_decoder::DataDecoder& IconDecoder() {
  static base::NoDestructor<data_decoder::DataDecoder> decoder;
  return *decoder;
}

class IconFetch : public ProfileObserver {
 public:
  static void Start(Profile* profile,
                    const GURL& url,
                    const GURL& page,
                    int pixels,
                    IconCompletion completion) {
    auto* fetch = new IconFetch(profile, page, pixels, completion);
    if (url.SchemeIs(url::kDataScheme)) {
      fetch->DecodeDataURL(url);
    } else {
      fetch->Load(profile, url);
    }
  }

  IconFetch(const IconFetch&) = delete;
  IconFetch& operator=(const IconFetch&) = delete;

 private:
  IconFetch(Profile* profile, const GURL& page, int pixels, IconCompletion completion)
      : page_(page), pixels_(pixels), completion_(completion) {
    observation_.Observe(profile);
  }
  ~IconFetch() override = default;

  void DecodeDataURL(const GURL& url) {
    std::string mime_type, charset, data;
    if (!net::DataURL::Parse(url, &mime_type, &charset, &data)) {
      return Finish(nil);
    }
    Decode(data);
  }

  void Load(Profile* profile, const GURL& url) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = url;
    request->method = "GET";
    request->request_initiator = url::Origin::Create(page_);
    request->mode = network::mojom::RequestMode::kNoCors;
    request->credentials_mode = network::mojom::CredentialsMode::kOmitBug_775438_Workaround;
    request->destination = network::mojom::RequestDestination::kImage;
    request->trusted_params = network::ResourceRequest::TrustedParams();
    request->trusted_params->client_security_state = PublicClient(page_);
    loader_ = network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
    loader_->SetURLLoaderFactoryOptions(network::mojom::kURLLoadOptionBlockLocalRequest);
    loader_->SetTimeoutDuration(kTimeout);
    loader_->SetOnRedirectCallback(
        base::BindRepeating(&IconFetch::OnRedirect, base::Unretained(this)));
    loader_->DownloadToString(
        profile->GetDefaultStoragePartition()->GetURLLoaderFactoryForBrowserProcess().get(),
        base::BindOnce(&IconFetch::OnLoaded, base::Unretained(this)), kMaxBytes);
  }

  void OnRedirect(const GURL& url_before_redirect,
                  const net::RedirectInfo& redirect_info,
                  const network::mojom::URLResponseHead& response_head,
                  std::vector<std::string>* removed_headers) {
    const GURL& next = redirect_info.new_url;
    if (!next.SchemeIsHTTPOrHTTPS() || MixedContent(page_, next)) {
      loader_.reset();
      Finish(nil);
    }
  }

  void OnLoaded(std::optional<std::string> body) {
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const bool ok = loader_->NetError() == net::OK && body && head && head->headers &&
                    head->headers->response_code() == 200;
    loader_.reset();
    if (!ok) {
      return Finish(nil);
    }
    Decode(*body);
  }

  void Decode(std::string_view body) {
    if (!IsBitmapImage(body)) {
      return Finish(nil);
    }
    data_decoder::DecodeImage(
        &IconDecoder(), base::as_byte_span(body), data_decoder::mojom::ImageCodec::kDefault,
        true, kMaxDecodedBytes, gfx::Size(pixels_, pixels_),
        base::BindOnce(&IconFetch::OnDecoded, weak_factory_.GetWeakPtr()));
  }

  void OnDecoded(const SkBitmap& bitmap) {
    Finish(bitmap.drawsNothing() ? nil : skia::SkBitmapToNSImage(bitmap));
  }

  void OnProfileWillBeDestroyed(Profile* profile) override { Finish(nil); }

  void Finish(NSImage* _Nullable image) {
    IconCompletion completion = completion_;
    delete this;
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(image);
    });
  }

  const GURL page_;
  const int pixels_;
  IconCompletion completion_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::ScopedObservation<Profile, ProfileObserver> observation_{this};
  base::WeakPtrFactory<IconFetch> weak_factory_{this};
};

}

@implementation ArdiaCoreProfile (Icons)

- (void)fetchIcon:(NSString*)url
          forPage:(NSString*)page
        maxPixels:(NSInteger)maxPixels
       completion:(void (^)(NSImage* _Nullable image))completion {
  const GURL target(base::SysNSStringToUTF8(url ?: @""));
  const GURL from(base::SysNSStringToUTF8(page ?: @""));
  Profile* profile = self.chromeProfile;
  if (!profile || ardiacore::IsProfileDying(profile) || !AllowedFor(from, target) ||
      maxPixels <= 0) {
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(nil);
    });
    return;
  }
  IconFetch::Start(profile, target, from,
                   static_cast<int>(std::min(maxPixels, kMostPixels)), completion);
}

@end
