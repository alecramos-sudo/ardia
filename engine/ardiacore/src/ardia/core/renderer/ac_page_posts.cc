#include "ardia/core/renderer/ac_page_posts.h"

#include "ardia/core/ac_page_limits.h"
#include "gin/arguments.h"
#include "gin/converter.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-primitive.h"

namespace ardiacore {

namespace {

bool FitsUtf8(v8::Isolate* isolate, v8::Local<v8::String> text, size_t limit) {
  return static_cast<size_t>(text->Length()) <= limit &&
         text->Utf8Length(isolate) <= limit;
}

}

std::optional<std::string> PostedKind(gin::Arguments* args) {
  v8::Local<v8::Value> kind;
  if (!args->GetNext(&kind) || !kind->IsString() ||
      !FitsUtf8(args->isolate(), kind.As<v8::String>(), kMaxPageMessageKind)) {
    return std::nullopt;
  }
  return gin::V8ToString(args->isolate(), kind);
}

std::optional<std::string> PostedJson(gin::Arguments* args, size_t limit) {
  v8::Local<v8::Value> value;
  if (!args->GetNext(&value) || !value->IsString()) {
    return std::string("null");
  }
  if (!FitsUtf8(args->isolate(), value.As<v8::String>(), limit)) {
    return std::nullopt;
  }
  return gin::V8ToString(args->isolate(), value);
}

}
