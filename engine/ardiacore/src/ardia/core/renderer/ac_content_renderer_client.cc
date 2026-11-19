#include "ardia/core/renderer/ac_content_renderer_client.h"

#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <tuple>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "content/public/common/isolated_world_ids.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_frame_observer.h"
#include "content/public/renderer/render_thread.h"
#include "gin/arguments.h"
#include "gin/converter.h"
#include "gin/function_template.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "ardia/core/ac_page_limits.h"
#include "ardia/core/ac_page_worlds.h"
#include "ardia/core/ac_prerender_posts.h"
#include "ardia/core/mojom/ardiacore.mojom.h"
#include "ardia/core/renderer/ac_evaluation.h"
#include "ardia/core/renderer/ac_page_posts.h"
#include "ardia/core/renderer/ac_render_thread_observer.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/platform/web_isolated_world_info.h"
#include "third_party/blink/public/platform/web_security_origin.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_document_loader.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/mojom/frame/user_activation_notification_type.mojom.h"
#include "third_party/blink/public/mojom/script/script_evaluation_params.mojom.h"
#include "third_party/blink/public/web/web_script_execution_callback.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-persistent-handle.h"
#include "v8/include/v8-primitive.h"

namespace ardiacore {

namespace {

constexpr char kPictureInPictureCandidates[] =
    "const videos = [...document.querySelectorAll('video')].filter((v) => "
    "v.readyState > 0 && v.clientWidth * v.clientHeight > 0);";

constexpr char kHasPictureInPictureCandidateScript[] =
    "return videos.length > 0;";

constexpr char kPictureInPictureForUserScript[] =
    "videos.sort((a, b) => (b.paused ? 0 : 1) - (a.paused ? 0 : 1) || "
    "b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);"
    "if (!videos.length) return false;"
    "if (document.pictureInPictureElement === videos[0]) return true;"
    "return videos[0].requestPictureInPicture().then(() => true, () => false);";

constexpr char kArdiaPageWorldPolicy[] = "script-src 'none'; object-src 'none'";

void ConfigureArdiaPageWorld() {
  static bool configured = false;
  if (configured) {
    return;
  }
  configured = true;
  blink::WebIsolatedWorldInfo info;
  info.security_origin = blink::WebSecurityOrigin(url::Origin());
  info.content_security_policy =
      blink::WebString::FromUtf8(kArdiaPageWorldPolicy);
  info.human_readable_name = blink::WebString::FromUtf8("Ardia");
  blink::SetIsolatedWorldInfo(ISOLATED_WORLD_ID_ARDIA_PAGE, info);
}

std::string PictureInPictureScript(const char* body) {
  return std::string("(() => {") + kPictureInPictureCandidates + body + "})()";
}

blink::WebScriptSource Source(const std::string& code, const char* url) {
  return blink::WebScriptSource(blink::WebString::FromUtf8(code),
                                blink::WebURL(GURL(url)));
}

blink::WebScriptSource PageScriptSource() {
  return Source(ACRenderThreadObserver::PageScript(), "ardia://page-script");
}

class ACPageObserver : public content::RenderFrameObserver,
                       public mojom::ACPage {
 public:
  explicit ACPageObserver(content::RenderFrame* frame)
      : content::RenderFrameObserver(frame), registered_frame_(frame) {
    Observers()[frame] = this;
    frame->GetAssociatedInterfaceRegistry()->AddInterface<mojom::ACPage>(
        base::BindRepeating(&ACPageObserver::BindPage,
                            weak_factory_.GetWeakPtr()));
  }

  ~ACPageObserver() override {
    Observers().erase(registered_frame_);
    AnswerAll();
  }

  void OnDestruct() override { delete this; }

  void DidCreateScriptContext(v8::Local<v8::Context> context,
                              int32_t world_id) override {
    if (world_id != content::ISOLATED_WORLD_ID_GLOBAL) {
      return;
    }
    if (!page_color_.empty() && IsMainErrorDocument()) {
      render_frame()->GetWebFrame()->ExecuteScript(
          Source(PageColorScript(), "ardia://page-color"));
    }
    InstallPageScript(context);
  }

  static ACPageObserver* For(content::RenderFrame* frame) {
    auto it = Observers().find(frame);
    return it == Observers().end() ? nullptr : it->second;
  }

  void RunAtDocumentStart() {
    if (!IsWebDocument()) {
      return;
    }
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    if (!installed_for_web_) {
      blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
      v8::HandleScope handle_scope(frame->GetAgentGroupScheduler()->Isolate());
      v8::Local<v8::Context> context = frame->MainWorldScriptContext();
      if (!alive) {
        return;
      }
      if (!installed_for_web_ && !context.IsEmpty()) {
        InstallPageScript(context);
      }
    }
    if (alive) {
      InstallArdiaWorldScript();
    }
  }

  bool IsWebDocument() {
    const GURL url = render_frame()->GetWebFrame()->GetDocument().Url();
    return url.SchemeIsHTTPOrHTTPS() || url.SchemeIsFile();
  }

  void InstallPageScript(v8::Local<v8::Context> context) {
    if (ACRenderThreadObserver::PageScript().empty() || installing_ ||
        installed_for_web_) {
      return;
    }
    installing_ = true;
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    RunPageScript(context);
    if (alive) {
      installing_ = false;
    }
  }

  void RunPageScript(v8::Local<v8::Context> context) {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    v8::Context::Scope context_scope(context);
    page_world_.Forget();
    installed_for_web_ = IsWebDocument();
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    v8::Local<v8::Value> install =
        frame->ExecuteScriptAndReturnValue(PageScriptSource());
    if (!alive || install.IsEmpty() || !install->IsFunction()) {
      return;
    }
    if (Run(install.As<v8::Function>(), context, PageWorld::kPage) &&
        frame->MainWorldScriptContext() != context) {
      page_world_.Forget();
    }
  }

  void InstallArdiaWorldScript() {
    if (ACRenderThreadObserver::PageScript().empty()) {
      return;
    }
    ConfigureArdiaPageWorld();
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    ardia_world_.Forget();
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    v8::Local<v8::Value> install =
        frame->ExecuteScriptInIsolatedWorldAndReturnValue(
            ISOLATED_WORLD_ID_ARDIA_PAGE, PageScriptSource(),
            blink::BackForwardCacheAware::kAllow);
    if (!alive || install.IsEmpty() || !install->IsFunction()) {
      return;
    }
    v8::Local<v8::Context> context = frame->GetScriptContextFromWorldId(
        isolate, ISOLATED_WORLD_ID_ARDIA_PAGE);
    if (context.IsEmpty()) {
      return;
    }
    v8::Context::Scope context_scope(context);
    if (Run(install.As<v8::Function>(), context, PageWorld::kArdia) &&
        frame->GetScriptContextFromWorldId(
            isolate, ISOLATED_WORLD_ID_ARDIA_PAGE) != context) {
      ardia_world_.Forget();
    }
  }

  bool Run(v8::Local<v8::Function> install,
           v8::Local<v8::Context> context,
           PageWorld world) {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    v8::Local<v8::Value> args[] = {
        PostFunction(isolate, context,
                     base::BindRepeating(&ACPageObserver::PostFromWorld,
                                         weak_factory_.GetWeakPtr(), world)),
        gin::StringToV8(isolate, world == PageWorld::kPage ? "page" : "ardia")};
    v8::Local<v8::Value> receive;
    const bool ran = frame
                         ->CallFunctionEvenIfScriptDisabled(
                             install, v8::Undefined(isolate), 2, args)
                         .ToLocal(&receive);
    if (!alive || !ran || !receive->IsFunction()) {
      return false;
    }
    WorldScript& script = ScriptOf(world);
    script.receive.Reset(isolate, receive.As<v8::Function>());
    script.context.Reset(isolate, context);
    return true;
  }

  void WillReleaseScriptContext(v8::Local<v8::Context> context,
                                int32_t world_id) override {
    if (world_id == ISOLATED_WORLD_ID_ARDIA_PAGE) {
      ardia_world_.Forget();
      return;
    }
    if (world_id != content::ISOLATED_WORLD_ID_GLOBAL) {
      return;
    }
    page_world_.Forget();
    installed_for_web_ = false;
    AnswerAll();
  }

  void CallPage(const std::string& kind, const std::string& json) override {
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    for (PageWorld world : {PageWorld::kArdia, PageWorld::kPage}) {
      if (alive && PageWorldReceives(world, kind)) {
        CallWorld(world, kind, json);
      }
    }
  }

  void CallWorld(PageWorld world,
                 const std::string& kind,
                 const std::string& json) {
    WorldScript& script = ScriptOf(world);
    if (script.receive.IsEmpty()) {
      return;
    }
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Context> context = script.context.Get(isolate);
    v8::Local<v8::Function> receive = script.receive.Get(isolate);
    v8::Context::Scope context_scope(context);
    v8::Local<v8::Value> args[] = {gin::StringToV8(isolate, kind),
                                   gin::StringToV8(isolate, json)};
    std::ignore = frame->CallFunctionEvenIfScriptDisabled(
        receive, v8::Undefined(isolate), 2, args);
  }

  void Execute(const std::string& code) override {
    render_frame()->GetWebFrame()->ExecuteScript(
        Source(code, "ardia://execute"));
  }

  bool HasPictureInPictureCandidate(blink::WebLocalFrame* frame) {
    v8::HandleScope handle_scope(frame->GetAgentGroupScheduler()->Isolate());
    v8::Local<v8::Value> found = frame->ExecuteScriptInIsolatedWorldAndReturnValue(
        ISOLATED_WORLD_ID_CHROME_INTERNAL,
        Source(PictureInPictureScript(kHasPictureInPictureCandidateScript),
               "ardia://picture-in-picture-candidate"),
        blink::BackForwardCacheAware::kAllow);
    return !found.IsEmpty() && found->IsTrue();
  }

  void PictureInPictureDocument(
      PictureInPictureDocumentCallback callback) override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    const std::string document = frame->GetDocument().Token().ToString();
    if (!frame->IsOutermostMainFrame() || !HasPictureInPictureCandidate(frame) ||
        !alive || frame->GetDocument().Token().ToString() != document) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    std::move(callback).Run(document);
  }

  void EnterPictureInPictureForUser(
      const std::string& document,
      EnterPictureInPictureForUserCallback callback) override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    if (!frame->IsOutermostMainFrame() ||
        frame->GetDocument().Token().ToString() != document ||
        !HasPictureInPictureCandidate(frame) || !alive ||
        frame->GetDocument().Token().ToString() != document) {
      std::move(callback).Run(false);
      return;
    }
    v8::HandleScope handle_scope(frame->GetAgentGroupScheduler()->Isolate());
    const std::string script =
        PictureInPictureScript(kPictureInPictureForUserScript);
    const blink::WebScriptSource source =
        Source(script, "ardia://picture-in-picture-for-user");
    frame->NotifyUserActivation(
        blink::mojom::UserActivationNotificationType::kInteraction);
    frame->RequestExecuteScript(
        ISOLATED_WORLD_ID_CHROME_INTERNAL, base::span_from_ref(source),
        blink::mojom::UserActivationOption::kDoNotActivate,
        blink::mojom::EvaluationTiming::kSynchronous,
        blink::mojom::LoadEventBlockingOption::kDoNotBlock,
        base::BindOnce(
            [](EnterPictureInPictureForUserCallback callback,
               std::optional<base::Value> result, base::TimeTicks) {
              std::move(callback).Run(result && result->is_bool() &&
                                      result->GetBool());
            },
            std::move(callback)),
        blink::BackForwardCacheAware::kAllow,
        blink::mojom::WantResultOption::kWantResult,
        blink::mojom::PromiseResultOption::kAwait, blink::WebString());
    if (alive) {
      frame->ConsumeTransientUserActivation();
    }
  }

  void Evaluate(const std::string& code, EvaluateCallback callback) override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    const std::optional<ACEvaluation> evaluation =
        CompileEvaluation(frame, isolate, code);
    if (!evaluation) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    v8::Context::Scope context_scope(evaluation->context);
    const int id = ++last_evaluation_;
    evaluations_[id] = std::move(callback);
    v8::Local<v8::Value> post = PostFunction(
        isolate, evaluation->context,
        base::BindRepeating(&ACPageObserver::PostResult,
                            weak_factory_.GetWeakPtr(), id));
    v8::Local<v8::Value> result;
    base::WeakPtr<ACPageObserver> alive = weak_factory_.GetWeakPtr();
    const bool ran = frame
                         ->CallFunctionEvenIfScriptDisabled(
                             evaluation->function, v8::Undefined(isolate), 1,
                             &post)
                         .ToLocal(&result);
    if (alive && !ran) {
      Answer(id, std::nullopt);
    }
  }

  void SetPageColor(const std::string& color) override {
    const bool valid = color.size() <= 16 &&
                       std::all_of(color.begin(), color.end(), [](char c) {
                         return c >= 'a' && c <= 'z';
                       });
    const std::string next = valid ? color : std::string();
    if (next == page_color_) {
      return;
    }
    page_color_ = next;
    if (IsMainErrorDocument()) {
      render_frame()->GetWebFrame()->ExecuteScript(
          Source(PageColorScript(), "ardia://page-color"));
    }
  }

  void SetAutoplayBlocked(bool blocked) override {
    render_frame()->GetWebFrame()->SetArdiaAutoplayBlocked(blocked);
  }

  void NoteMediaCommand() override {
    render_frame()->GetWebFrame()->NoteArdiaMediaCommand();
  }

 private:
  struct WorldScript {
    void Forget() {
      receive.Reset();
      context.Reset();
    }
    v8::Global<v8::Function> receive;
    v8::Global<v8::Context> context;
  };

  WorldScript& ScriptOf(PageWorld world) {
    return world == PageWorld::kPage ? page_world_ : ardia_world_;
  }

  static std::map<content::RenderFrame*, ACPageObserver*>& Observers() {
    static base::NoDestructor<std::map<content::RenderFrame*, ACPageObserver*>>
        observers;
    return *observers;
  }

  bool IsMainErrorDocument() {
    if (!render_frame()->IsMainFrame()) {
      return false;
    }
    blink::WebDocumentLoader* loader =
        render_frame()->GetWebFrame()->GetDocumentLoader();
    return loader && loader->HasUnreachableURL();
  }

  std::string PageColorScript() const {
    const std::string set =
        page_color_.empty()
            ? std::string("delete window.ardiaPageColor;")
            : "window.ardiaPageColor = \"" + page_color_ + "\";";
    return set + " window.dispatchEvent(new Event(\"ardiapagecolor\"));";
  }

  void BindPage(mojo::PendingAssociatedReceiver<mojom::ACPage> receiver) {
    page_receivers_.Add(this, std::move(receiver));
  }

  v8::Local<v8::Value> PostFunction(
      v8::Isolate* isolate,
      v8::Local<v8::Context> context,
      base::RepeatingCallback<void(gin::Arguments*)> post) {
    return gin::CreateFunctionTemplate(isolate, std::move(post))
        ->GetFunction(context)
        .ToLocalChecked();
  }

  void PostResult(int evaluation, gin::Arguments* args) {
    const std::optional<std::string> kind = PostedKind(args);
    if (kind != "result") {
      return;
    }
    Answer(evaluation, PostedJson(args, kMaxEvaluationResultBytes));
  }

  void PostFromWorld(PageWorld world, gin::Arguments* args) {
    const std::optional<std::string> posted = PostedKind(args);
    if (!posted || !PageWorldMayPost(world, *posted)) {
      return;
    }
    const std::string& kind = *posted;
    const std::optional<std::string> message =
        PostedJson(args, MaxPageMessageBytes(kind));
    if (!message) {
      return;
    }
    const std::string& json = *message;
    blink::WebDocument document = render_frame()->GetWebFrame()->GetDocument();
    switch (prerender_posts_.Take(document.Token(), document.IsPrerendering(),
                                  kind, json)) {
      case PrerenderPosts<blink::DocumentToken>::Verdict::kSend:
        SendToHost(kind, json);
        return;
      case PrerenderPosts<blink::DocumentToken>::Verdict::kHold:
        return;
      case PrerenderPosts<blink::DocumentToken>::Verdict::kHoldUntilActivated:
        document.AddPostPrerenderingActivationStep(base::BindOnce(
            &ACPageObserver::SendPrerenderPosts, weak_factory_.GetWeakPtr(),
            document.Token()));
        return;
    }
  }

  void SendToHost(const std::string& kind, const std::string& json) {
    if (!host_.is_bound()) {
      render_frame()->GetRemoteAssociatedInterfaces()->GetInterface(&host_);
    }
    host_->Post(kind, json);
  }

  void SendPrerenderPosts(blink::DocumentToken document) {
    for (const auto& [kind, json] : prerender_posts_.Release(document)) {
      SendToHost(kind, json);
    }
  }

  void Answer(int id, std::optional<std::string> json) {
    auto it = evaluations_.find(id);
    if (it == evaluations_.end()) {
      return;
    }
    EvaluateCallback callback = std::move(it->second);
    evaluations_.erase(it);
    std::move(callback).Run(std::move(json));
  }

  void AnswerAll() {
    std::map<int, EvaluateCallback> pending = std::move(evaluations_);
    evaluations_.clear();
    for (auto& [id, callback] : pending) {
      std::move(callback).Run(std::nullopt);
    }
  }

  mojo::AssociatedReceiverSet<mojom::ACPage> page_receivers_;
  mojo::AssociatedRemote<mojom::ACPageHost> host_;
  PrerenderPosts<blink::DocumentToken> prerender_posts_;
  WorldScript page_world_;
  WorldScript ardia_world_;
  std::map<int, EvaluateCallback> evaluations_;
  int last_evaluation_ = 0;
  std::string page_color_;
  bool installed_for_web_ = false;
  bool installing_ = false;
  raw_ptr<content::RenderFrame> registered_frame_;
  base::WeakPtrFactory<ACPageObserver> weak_factory_{this};
};

}

ACContentRendererClient::ACContentRendererClient() = default;
ACContentRendererClient::~ACContentRendererClient() = default;

void ACContentRendererClient::RenderThreadStarted() {
  ChromeContentRendererClient::RenderThreadStarted();
  observer_ = std::make_unique<ACRenderThreadObserver>();
  content::RenderThread::Get()->AddObserver(observer_.get());
}

void ACContentRendererClient::RenderFrameCreated(
    content::RenderFrame* render_frame) {
  ChromeContentRendererClient::RenderFrameCreated(render_frame);
  new ACPageObserver(render_frame);
}

void ACContentRendererClient::RunScriptsAtDocumentStart(
    content::RenderFrame* render_frame) {
  if (ACPageObserver* observer = ACPageObserver::For(render_frame)) {
    observer->RunAtDocumentStart();
  }
  ChromeContentRendererClient::RunScriptsAtDocumentStart(render_frame);
}

}
