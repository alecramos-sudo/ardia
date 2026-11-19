#import "ardia/core/public/ArdiaCore.h"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "services/media_session/public/cpp/media_image.h"
#include "services/media_session/public/cpp/media_metadata.h"
#include "services/media_session/public/cpp/media_position.h"
#include "services/media_session/public/mojom/media_session.mojom.h"
#include "skia/ext/skia_utils_mac.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"
#include "url/url_constants.h"
#include "ardia/core/ac_page_channel.h"
#import "ardia/core/ardiacore_tab_internal.h"

namespace {

using ImageCompletion = void (^)(NSImage* _Nullable);
using media_session::mojom::MediaSessionImageType;

constexpr int kMostPixels = 1024;
constexpr base::TimeDelta kArtworkDeclaredWithin = base::Seconds(2);

void Answer(ImageCompletion completion, const SkBitmap& bitmap) {
  NSImage* image = bitmap.drawsNothing() ? nil : skia::SkBitmapToNSImage(bitmap);
  dispatch_async(dispatch_get_main_queue(), ^{
    completion(image);
  });
}

bool PageImageURL(const GURL& url) {
  return url.is_valid() && (url.SchemeIsHTTPOrHTTPS() || url.SchemeIs(url::kDataScheme));
}

content::RenderFrameHost* LiveFrame(content::WebContents* contents, NSString* frameId) {
  content::RenderFrameHost* found = nullptr;
  if (!frameId.length) {
    found = contents->GetPrimaryMainFrame();
  } else {
    const std::string wanted = base::SysNSStringToUTF8(frameId);
    contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
        [&](content::RenderFrameHost* frame) {
          if (!found && ardiacore::PageChannel::FrameId(frame) == wanted) {
            found = frame;
          }
        });
  }
  return found && found->IsRenderFrameLive() ? found : nullptr;
}

SkBitmap LargestBitmap(const std::vector<SkBitmap>& bitmaps) {
  const SkBitmap* largest = nullptr;
  for (const SkBitmap& bitmap : bitmaps) {
    if (bitmap.drawsNothing()) {
      continue;
    }
    if (!largest || int64_t{bitmap.width()} * bitmap.height() >
                        int64_t{largest->width()} * largest->height()) {
      largest = &bitmap;
    }
  }
  return largest ? *largest : SkBitmap();
}

void AnswerLargest(ImageCompletion completion,
                   int,
                   int,
                   const GURL&,
                   const std::vector<SkBitmap>& bitmaps,
                   const std::vector<gfx::Size>&) {
  Answer(completion, LargestBitmap(bitmaps));
}

class ArtworkLookup : public media_session::mojom::MediaSessionObserver {
 public:
  static void Start(content::WebContents* contents,
                    content::MediaSession* session,
                    const GURL& url,
                    int pixels,
                    ImageCompletion completion) {
    auto* lookup = new ArtworkLookup(contents, url, pixels, completion);
    session->AddObserver(lookup->receiver_.BindNewPipeAndPassRemote());
    lookup->receiver_.set_disconnect_handler(
        base::BindOnce(&ArtworkLookup::Finish, base::Unretained(lookup), SkBitmap()));
    lookup->undeclared_.Start(
        FROM_HERE, kArtworkDeclaredWithin,
        base::BindOnce(&ArtworkLookup::Finish, base::Unretained(lookup), SkBitmap()));
  }

  ArtworkLookup(const ArtworkLookup&) = delete;
  ArtworkLookup& operator=(const ArtworkLookup&) = delete;

 private:
  ArtworkLookup(content::WebContents* contents,
                const GURL& url,
                int pixels,
                ImageCompletion completion)
      : contents_(contents->GetWeakPtr()),
        url_(url),
        pixels_(pixels),
        completion_(completion) {}
  ~ArtworkLookup() override = default;

  void MediaSessionInfoChanged(media_session::mojom::MediaSessionInfoPtr info) override {}
  void MediaSessionMetadataChanged(
      const std::optional<media_session::MediaMetadata>& metadata) override {}
  void MediaSessionActionsChanged(
      const std::vector<media_session::mojom::MediaSessionAction>& actions) override {}
  void MediaSessionPositionChanged(
      const std::optional<media_session::MediaPosition>& position) override {}

  void MediaSessionImagesChanged(
      const base::flat_map<MediaSessionImageType, std::vector<media_session::MediaImage>>&
          images) override {
    const auto artwork = images.find(MediaSessionImageType::kArtwork);
    if (artwork == images.end()) {
      return;
    }
    const auto declared =
        std::ranges::find(artwork->second, url_, &media_session::MediaImage::src);
    if (declared == artwork->second.end()) {
      return;
    }
    content::MediaSession* session =
        contents_ ? content::MediaSession::GetIfExists(contents_.get()) : nullptr;
    if (!session) {
      return Finish(SkBitmap());
    }
    const media_session::MediaImage image = *declared;
    undeclared_.Stop();
    receiver_.reset();
    session->GetMediaImageBitmap(
        image, 0, pixels_, base::BindOnce(&ArtworkLookup::Finish, base::Unretained(this)));
  }

  void Finish(const SkBitmap& bitmap) {
    Answer(completion_, bitmap);
    delete this;
  }

  base::WeakPtr<content::WebContents> contents_;
  const GURL url_;
  const int pixels_;
  ImageCompletion completion_;
  base::OneShotTimer undeclared_;
  mojo::Receiver<media_session::mojom::MediaSessionObserver> receiver_{this};
};

}

@implementation ArdiaCoreTab (Images)

- (void)downloadImage:(NSString*)url
              inFrame:(NSString*)frameId
            maxPixels:(NSInteger)maxPixels
              favicon:(BOOL)favicon
           completion:(void (^)(NSImage* _Nullable image))completion {
  const GURL target(base::SysNSStringToUTF8(url ?: @""));
  content::RenderFrameHost* frame =
      _contents && PageImageURL(target) && maxPixels > 0 ? LiveFrame(_contents, frameId) : nullptr;
  if (!frame) {
    return Answer(completion, SkBitmap());
  }
  const int pixels = static_cast<int>(std::min<NSInteger>(maxPixels, kMostPixels));
  _contents->DownloadImageInFrame(
      frame->GetGlobalId(), target, favicon, gfx::Size(pixels, pixels),
      static_cast<uint32_t>(pixels), false,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&AnswerLargest, completion), 0, 0, GURL(), std::vector<SkBitmap>(),
          std::vector<gfx::Size>()));
}

- (void)downloadArtwork:(NSString*)url
              maxPixels:(NSInteger)maxPixels
             completion:(void (^)(NSImage* _Nullable image))completion {
  const GURL target(base::SysNSStringToUTF8(url ?: @""));
  content::MediaSession* session =
      _contents && PageImageURL(target) && maxPixels > 0
          ? content::MediaSession::GetIfExists(_contents)
          : nullptr;
  if (!session) {
    return Answer(completion, SkBitmap());
  }
  ArtworkLookup::Start(_contents, session, target,
                       static_cast<int>(std::min<NSInteger>(maxPixels, kMostPixels)), completion);
}

@end
