#ifndef ARDIA_CORE_AC_PAGE_WORLDS_H_
#define ARDIA_CORE_AC_PAGE_WORLDS_H_

#include <stddef.h>

#include <string_view>

namespace ardiacore {

enum class PageWorld { kPage, kArdia };

inline constexpr std::string_view kPageWorldPosts[] = {
    "appBadge",
    "displayMedia",
    "displayMediaHello",
    "drm",
    "newTabLink",
    "notification",
    "notificationClose",
    "nowPlaying",
    "pipTrace",
};

inline constexpr std::string_view kPageWorldCalls[] = {
    "config",
    "displayMedia",
    "media",
    "notification",
};

template <size_t N>
constexpr bool ListsKind(const std::string_view (&kinds)[N],
                         std::string_view kind) {
  for (std::string_view listed : kinds) {
    if (listed == kind) {
      return true;
    }
  }
  return false;
}

constexpr bool PageWorldMayPost(PageWorld world, std::string_view kind) {
  return world == PageWorld::kArdia || ListsKind(kPageWorldPosts, kind);
}

constexpr bool PageWorldReceives(PageWorld world, std::string_view kind) {
  const bool page_world_kind = ListsKind(kPageWorldCalls, kind);
  return world == PageWorld::kPage ? page_world_kind
                                   : !page_world_kind || kind == "config";
}

}

#endif
