#include "ardia/core/ac_autoplay.h"

#include <optional>
#include <set>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/mojom/ardiacore.mojom.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/content_settings_observer.h"
#include "components/content_settings/core/browser/content_settings_type_set.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings.h"
#include "components/content_settings/core/common/content_settings_pattern.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "content/public/browser/disallow_activation_reason.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/page_user_data.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardiacore {

namespace {

bool g_block_everywhere = false;

HostContentSettingsMap* SettingsFor(content::WebContents* contents) {
  return contents ? HostContentSettingsMapFactory::GetForProfile(
                        Profile::FromBrowserContext(
                            contents->GetBrowserContext()))
                  : nullptr;
}

bool BlockedAt(content::WebContents* contents, const url::Origin& top_level) {
  const GURL url = top_level.GetTupleOrPrecursorTupleIfOpaque().GetURL();
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  HostContentSettingsMap* settings = SettingsFor(contents);
  if (!settings) {
    return false;
  }
  content_settings::SettingInfo info;
  const ContentSetting value = settings->GetContentSetting(
      url, url, ContentSettingsType::AUTOPLAY, &info);
  return value == CONTENT_SETTING_BLOCK ||
         (g_block_everywhere && info.primary_pattern.MatchesAllHosts());
}

class AutoplayPage : public content::PageUserData<AutoplayPage> {
 public:
  std::optional<bool> blocked;

 private:
  friend class content::PageUserData<AutoplayPage>;
  explicit AutoplayPage(content::Page& page)
      : content::PageUserData<AutoplayPage>(page) {}
  PAGE_USER_DATA_KEY_DECL();
};

PAGE_USER_DATA_KEY_IMPL(AutoplayPage);

bool InBackForwardCache(content::RenderFrameHost* frame) {
  return frame->IsInLifecycleState(
      content::RenderFrameHost::LifecycleState::kInBackForwardCache);
}

void Send(content::RenderFrameHost* frame, bool blocked) {
  if (!frame || !frame->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<mojom::ACPage> page;
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&page);
  page->SetAutoplayBlocked(blocked);
}

void Tell(content::WebContents* contents, content::RenderFrameHost* frame) {
  if (!frame || InBackForwardCache(frame)) {
    return;
  }
  const bool blocked = BlockedAt(
      contents, frame->GetOutermostMainFrame()->GetLastCommittedOrigin());
  AutoplayPage::GetOrCreateForPage(frame->GetPage())->blocked = blocked;
  Send(frame, blocked);
}

void EvictIfChanged(content::WebContents* contents,
                    content::RenderFrameHost* frame) {
  if (frame->GetParentOrOuterDocument()) {
    return;
  }
  const bool blocked = BlockedAt(contents, frame->GetLastCommittedOrigin());
  AutoplayPage* page = AutoplayPage::GetForPage(frame->GetPage());
  if (page && page->blocked.has_value() && *page->blocked != blocked) {
    frame->IsInactiveAndDisallowActivation(
        content::kMinEmbedderDisallowActivationReason);
  }
}

class AutoplayFollower : public content::WebContentsObserver,
                         public content::WebContentsUserData<AutoplayFollower>,
                         public content_settings::Observer {
 public:
  AutoplayFollower(const AutoplayFollower&) = delete;
  AutoplayFollower& operator=(const AutoplayFollower&) = delete;
  ~AutoplayFollower() override {
    Live().erase(this);
    StopObserving();
  }

  static std::set<AutoplayFollower*>& Live() {
    static base::NoDestructor<std::set<AutoplayFollower*>> live;
    return *live;
  }

  void TellEveryFrame() {
    content::WebContents* contents = web_contents();
    if (!contents) {
      return;
    }
    std::vector<content::RenderFrameHost*> cached;
    contents->ForEachRenderFrameHost(
        [contents, &cached](content::RenderFrameHost* frame) {
          if (InBackForwardCache(frame)) {
            cached.push_back(frame);
          } else {
            Tell(contents, frame);
          }
        });
    for (content::RenderFrameHost* frame : cached) {
      EvictIfChanged(contents, frame);
    }
    for (content::NavigationHandle* handle : committing_) {
      content::RenderFrameHost* outer = handle->GetParentFrameOrOuterDocument();
      Send(handle->GetRenderFrameHost(),
           BlockedAt(contents,
                     outer ? outer->GetOutermostMainFrame()
                                 ->GetLastCommittedOrigin()
                           : handle->GetOriginToCommit().value_or(
                                 url::Origin())));
    }
  }

 private:
  friend class content::WebContentsUserData<AutoplayFollower>;

  explicit AutoplayFollower(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<AutoplayFollower>(*contents),
        settings_(SettingsFor(contents)) {
    if (settings_) {
      settings_->AddObserver(this);
    }
    Live().insert(this);
    TellEveryFrame();
  }

  void ReadyToCommitNavigation(content::NavigationHandle* handle) override {
    if (!handle->IsSameDocument()) {
      committing_.insert(handle);
    }
  }

  void DidFinishNavigation(content::NavigationHandle* handle) override {
    committing_.erase(handle);
    if (!handle->HasCommitted() || handle->IsSameDocument()) {
      return;
    }
    content::WebContents* contents = web_contents();
    content::RenderFrameHost* frame = handle->GetRenderFrameHost();
    if (handle->IsServedFromBackForwardCache() ||
        handle->IsPrerenderedPageActivation()) {
      frame->ForEachRenderFrameHost(
          [contents](content::RenderFrameHost* each) { Tell(contents, each); });
      return;
    }
    Tell(contents, frame);
  }

  void OnContentSettingChanged(const ContentSettingsPattern& primary_pattern,
                               const ContentSettingsPattern& secondary_pattern,
                               ContentSettingsTypeSet types) override {
    if (types.Contains(ContentSettingsType::AUTOPLAY)) {
      TellEveryFrame();
    }
  }

  void WebContentsDestroyed() override { StopObserving(); }

  void StopObserving() {
    if (settings_) {
      settings_->RemoveObserver(this);
    }
    settings_ = nullptr;
  }

  raw_ptr<HostContentSettingsMap> settings_;
  std::set<raw_ptr<content::NavigationHandle>> committing_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(AutoplayFollower);

}

void InstallAutoplayPolicy() {
  g_ardia_autoplay_blocked = [](content::WebContents* contents,
                                const url::Origin& top_level) {
    return contents && BlockedAt(contents, top_level);
  };
}

void WatchAutoplay(content::WebContents* contents) {
  if (contents && !AutoplayFollower::FromWebContents(contents)) {
    AutoplayFollower::CreateForWebContents(contents);
  }
}

void SetBlockAutoplayEverywhere(bool enabled) {
  if (enabled == g_block_everywhere) {
    return;
  }
  g_block_everywhere = enabled;
  for (AutoplayFollower* follower :
       std::set<AutoplayFollower*>(AutoplayFollower::Live())) {
    if (AutoplayFollower::Live().contains(follower)) {
      follower->TellEveryFrame();
    }
  }
}

bool BlocksAutoplayEverywhere() {
  return g_block_everywhere;
}

}
