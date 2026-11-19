#include "ardia/core/renderer/ac_evaluation.h"

#include <iterator>

#include "chrome/common/chrome_isolated_world_ids.h"
#include "extensions/common/constants.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest.h"
#include "extensions/common/manifest_handlers/sandboxed_page_info.h"
#include "extensions/renderer/renderer_extension_registry.h"
#include "gin/converter.h"
#include "third_party/blink/public/platform/web_security_origin.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-message.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-script.h"

namespace ardiacore {

namespace {

constexpr int32_t kEvaluationWorld = ISOLATED_WORLD_ID_CHROME_INTERNAL;

constexpr char kEvaluationUrl[] = "ardia://evaluate";

bool IsOwnExtensionPage(blink::WebLocalFrame* frame) {
  const GURL url = frame->GetDocument().Url();
  if (!url.SchemeIs(extensions::kExtensionScheme)) {
    return false;
  }
  const extensions::Extension* extension =
      extensions::RendererExtensionRegistry::Get()->GetByID(url.GetHost());
  return extension &&
         extensions::Manifest::IsComponentLocation(extension->location()) &&
         !extensions::SandboxedPageInfo::IsSandboxedPage(extension,
                                                         url.GetPath()) &&
         url::Origin(frame->GetSecurityOrigin())
             .IsSameOriginWith(extension->origin());
}

std::optional<ACEvaluation> CompileInMainWorld(blink::WebLocalFrame* frame,
                                               v8::Isolate* isolate,
                                               const std::string& code) {
  v8::Local<v8::Context> context = frame->MainWorldScriptContext();
  if (context.IsEmpty()) {
    return std::nullopt;
  }
  v8::Context::Scope context_scope(context);
  v8::TryCatch try_catch(isolate);
  v8::ScriptCompiler::Source source(
      gin::StringToV8(isolate, "'use strict';\n" + code),
      v8::ScriptOrigin(gin::StringToV8(isolate, kEvaluationUrl)));
  v8::Local<v8::String> parameters[] = {gin::StringToV8(isolate, "post")};
  v8::Local<v8::Function> function;
  if (!v8::ScriptCompiler::CompileFunction(context, &source,
                                           std::size(parameters), parameters)
           .ToLocal(&function)) {
    return std::nullopt;
  }
  return ACEvaluation{context, function};
}

std::optional<ACEvaluation> CompileInIsolatedWorld(blink::WebLocalFrame* frame,
                                                   v8::Isolate* isolate,
                                                   const std::string& code) {
  v8::Local<v8::Value> function =
      frame->ExecuteScriptInIsolatedWorldAndReturnValue(
          kEvaluationWorld,
          blink::WebScriptSource(
              blink::WebString::FromUtf8("(function(post){'use strict';\n" +
                                         code + "\n})"),
              blink::WebURL(GURL(kEvaluationUrl))),
          blink::BackForwardCacheAware::kAllow);
  if (function.IsEmpty() || !function->IsFunction()) {
    return std::nullopt;
  }
  return ACEvaluation{
      frame->GetScriptContextFromWorldId(isolate, kEvaluationWorld),
      function.As<v8::Function>()};
}

}

std::optional<ACEvaluation> CompileEvaluation(blink::WebLocalFrame* frame,
                                              v8::Isolate* isolate,
                                              const std::string& code) {
  return IsOwnExtensionPage(frame)
             ? CompileInMainWorld(frame, isolate, code)
             : CompileInIsolatedWorld(frame, isolate, code);
}

}
