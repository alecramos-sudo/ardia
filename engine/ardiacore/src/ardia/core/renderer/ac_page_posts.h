#ifndef ARDIA_CORE_RENDERER_AC_PAGE_POSTS_H_
#define ARDIA_CORE_RENDERER_AC_PAGE_POSTS_H_

#include <stddef.h>

#include <optional>
#include <string>

namespace gin {
class Arguments;
}

namespace ardiacore {

std::optional<std::string> PostedKind(gin::Arguments* args);
std::optional<std::string> PostedJson(gin::Arguments* args, size_t limit);

}

#endif
