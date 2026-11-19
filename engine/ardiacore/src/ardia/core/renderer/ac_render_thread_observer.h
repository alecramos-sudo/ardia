#ifndef ARDIA_CORE_RENDERER_AC_RENDER_THREAD_OBSERVER_H_
#define ARDIA_CORE_RENDERER_AC_RENDER_THREAD_OBSERVER_H_

#include <string>

#include "ardia/core/mojom/ardiacore.mojom.h"
#include "content/public/renderer/render_thread_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"

namespace ardiacore {

class ACRenderThreadObserver : public content::RenderThreadObserver,
                               public mojom::ACRendererConfig {
 public:
  static const std::string& PageScript();

  void RegisterMojoInterfaces(
      blink::AssociatedInterfaceRegistry* associated_interfaces) override;
  void UnregisterMojoInterfaces(
      blink::AssociatedInterfaceRegistry* associated_interfaces) override;

  void SetPageScript(const std::string& script) override;

 private:
  void Bind(mojo::PendingAssociatedReceiver<mojom::ACRendererConfig> receiver);

  mojo::AssociatedReceiverSet<mojom::ACRendererConfig> receivers_;
};

}

#endif
