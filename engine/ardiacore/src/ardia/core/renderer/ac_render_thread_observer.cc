#include "ardia/core/renderer/ac_render_thread_observer.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"

namespace ardiacore {

namespace {

std::string& Script() {
  static base::NoDestructor<std::string> script;
  return *script;
}

}

const std::string& ACRenderThreadObserver::PageScript() {
  return Script();
}

void ACRenderThreadObserver::RegisterMojoInterfaces(
    blink::AssociatedInterfaceRegistry* associated_interfaces) {
  associated_interfaces->AddInterface<mojom::ACRendererConfig>(
      base::BindRepeating(&ACRenderThreadObserver::Bind,
                          base::Unretained(this)));
}

void ACRenderThreadObserver::UnregisterMojoInterfaces(
    blink::AssociatedInterfaceRegistry* associated_interfaces) {
  associated_interfaces->RemoveInterface(mojom::ACRendererConfig::Name_);
}

void ACRenderThreadObserver::SetPageScript(const std::string& script) {
  Script() = script;
}

void ACRenderThreadObserver::Bind(
    mojo::PendingAssociatedReceiver<mojom::ACRendererConfig> receiver) {
  receivers_.Add(this, std::move(receiver));
}

}
