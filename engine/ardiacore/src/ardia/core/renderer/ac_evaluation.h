#ifndef ARDIA_CORE_RENDERER_AC_EVALUATION_H_
#define ARDIA_CORE_RENDERER_AC_EVALUATION_H_

#include <optional>
#include <string>

#include "v8/include/v8-context.h"
#include "v8/include/v8-forward.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-local-handle.h"

namespace blink {
class WebLocalFrame;
}

namespace ardiacore {

struct ACEvaluation {
  v8::Local<v8::Context> context;
  v8::Local<v8::Function> function;
};

std::optional<ACEvaluation> CompileEvaluation(blink::WebLocalFrame* frame,
                                              v8::Isolate* isolate,
                                              const std::string& code);

}

#endif
