import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patchName = "chromium-autoplay-policy.patch";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const patch = read(`../../../engine/patches/${patchName}`);
const series = read("../../../engine/patches/series")
  .split("\n")
  .map((line) => line.split("#")[0].trim())
  .filter(Boolean)
  .map((line) => {
    const [kind, name, platform = "all"] = line.split(/\s+/);
    return { kind, name, platform };
  });
const files = new Map();
let file = null;
for (const line of patch.split("\n")) {
  const target = line.match(/^\+\+\+ b\/(\S+)/);
  if (target) files.set((file = target[1]), []);
  else if (file && line.startsWith("+")) files.get(file).push(line.slice(1).trim());
}
const added = (path) => {
  assert.ok(files.has(path), `${patchName} does not touch ${path}`);
  return files.get(path).join("\n");
};
const ios = (name) => read(`../ios/${name}`);
const core = (name) => read(`../../../engine/ardiacore/src/ardia/core/${name}`);

test("the autoplay patch is in the Mac series, ahead of ArdiaCore's layer that sets its hook", () => {
  const at = series.findIndex((step) => step.kind === "chromium" && step.name === patchName);
  assert.ok(at >= 0, `${patchName} is not in the series`);
  assert.equal(series[at].platform, "mac");
  assert.ok(at < series.findIndex((step) => step.kind === "layer" && step.name === "engine/ardiacore"));
});

test("the autoplay patch adds no comments", () => {
  const comments = [...files.values()].flat().filter((line) => /^\/[/*]|\s\/\/(?! nogncheck$)/.test(line) && !line.startsWith("/*can_use_device_bound_session_js_api=*/"));
  assert.deepEqual(comments, []);
});

test("the browser decides before the document runs, from the tab's top-level origin", () => {
  const request = added("content/browser/renderer_host/navigation_request.cc");
  assert.match(request, /bool \(\*g_ardia_autoplay_blocked\)\(content::WebContents\* contents,\s*const url::Origin& top_level\) = nullptr;/);
  assert.match(request, /commit_params->ardia_autoplay_blocked = g_ardia_autoplay_blocked\(/);
  assert.match(request, /GetParentFrameOrOuterDocument\(\)->GetOutermostMainFrame\(\)/);
  assert.match(added("third_party/blink/public/mojom/navigation/navigation_params.mojom"), /^bool ardia_autoplay_blocked = false;$/m);
  assert.match(added("third_party/blink/renderer/core/loader/document_loader.cc"), /AutoplayPolicy::ArdiaSetFrameBlocked\(\*frame_, \*ardia_autoplay_blocked_,\s*false\);/);
  assert.match(added("third_party/blink/renderer/core/frame/web_local_frame_impl.cc"), /AutoplayPolicy::ArdiaInheritFrameBlocked\(/);
});

test("Blink refuses every start the user didn't ask for, muted ones and the autoplay attribute included", () => {
  const policy = added("third_party/blink/renderer/core/html/media/autoplay_policy.cc");
  assert.match(policy, /if \(element_->paused\(\) && ArdiaRefusesPlay\(\)\) \{\nreturn DOMExceptionCode::kNotAllowedError;/);
  assert.match(policy, /if \(ArdiaRefusesPlay\(\)\) \{\nreturn false;/);
  assert.match(policy, /if \(self->ShouldAutoplay\(\) && !self->ArdiaRefusesPlay\(\)\) \{/);
  assert.match(added("third_party/blink/renderer/core/html/media/html_media_element.cc"), /if \(paused_ && autoplay_policy_->ArdiaRefusesPlay\(\)\) \{/);
  for (const path of ["third_party/blink/renderer/core/input/event_handler.cc", "third_party/blink/renderer/core/input/keyboard_event_manager.cc", "third_party/blink/renderer/core/input/pointer_event_manager.cc", "third_party/blink/renderer/modules/mediasession/media_session.cc"])
    assert.match(added(path), /AutoplayPolicy::ArdiaNoteUsedHere\(/, `${path} doesn't count trusted input as the user's ask`);
  assert.match(added("third_party/blink/renderer/core/input/keyboard_event_manager.cc"), /WebInputEvent::kMetaKey/);
});

test("Web Audio follows the same answer: no start the user didn't ask for, and a live Block suspends what runs", () => {
  assert.match(added("third_party/blink/renderer/core/html/media/autoplay_policy.h"), /class CORE_EXPORT ArdiaAutoplayClient : public GarbageCollectedMixin \{\npublic:\nvirtual void ArdiaAutoplayRefused\(\) = 0;/);
  assert.match(added("third_party/blink/renderer/core/html/media/autoplay_policy.cc"), /for \(ArdiaAutoplayClient\* client : clients\) \{\nclient->ArdiaAutoplayRefused\(\);/);
  assert.match(added("third_party/blink/renderer/modules/webaudio/audio_context.h"), /^public ArdiaAutoplayClient,$/m);
  const context = added("third_party/blink/renderer/modules/webaudio/audio_context.cc");
  assert.match(context, /AutoplayPolicy::ArdiaAddClient\(\*window\.document\(\), this\);/);
  assert.match(context, /if \(ArdiaRefusesWindow\(GetWindow\(\)\)\) \{\nreturn false;\n\}/);
  assert.match(context, /if \(!user_gesture_required_ && !ArdiaBlocksWindow\(GetWindow\(\)\)\) \{/);
  assert.match(context, /if \(ArdiaRefusesWindow\(GetWindow\(\)\)\) \{\nshould_transition_to_running_after_interruption_ = false;\nSetContextState\(V8AudioContextState::Enum::kSuspended\);\nreturn;/);
  assert.match(context, /void AudioContext::ArdiaAutoplayRefused\(\) \{[^]*?pending_initial_transition_to_running_ = false;\nsink_transition_flag_was_running_ = false;\nSuspendRendering\(\);/);
  assert.match(context, /^\} else if \(IsPullingAudioGraph\(\) \|\| !ArdiaRefusesWindow\(GetWindow\(\)\)\) \{$/m);
});

test("ArdiaCore installs the decision, follows every tab and tells open pages when a setting changes", () => {
  assert.match(core("ac_content_hooks.h"), /extern bool \(\*g_ardia_autoplay_blocked\)\(content::WebContents\* contents,\s*const url::Origin& top_level\);/);
  assert.match(core("ac_seams.mm"), /InstallAutoplayPolicy\(\);/);
  assert.match(core("ac_tab_bridge.mm"), /WatchAutoplay\(contents\);/);
  const autoplay = core("ac_autoplay.cc");
  assert.match(autoplay, /ContentSettingsType::AUTOPLAY/);
  assert.match(autoplay, /info\.primary_pattern\.MatchesAllHosts\(\)/);
  assert.match(autoplay, /page->SetAutoplayBlocked\(blocked\);/);
  assert.match(core("mojom/ardiacore.mojom"), /SetAutoplayBlocked\(bool blocked\);\n\s*NoteMediaCommand\(\);/);
  assert.match(core("renderer/ac_content_renderer_client.cc"), /SetArdiaAutoplayBlocked\(blocked\)/);
});

test("the Mac's page script no longer gates autoplay: the hello config carries no blockAutoplay", () => {
  const messages = ios("ArdiaWebView+PageMessages.mm");
  assert.doesNotMatch(messages, /blockAutoplay/);
  assert.match(messages, /ArdiaCoreEngine\.blocksAutoplayEverywhere = enabled;/);
  assert.doesNotMatch(ios("page_script.js"), /didn't interact with the document first/);
});

test("Ardia's play control is the user's ask in the frame it plays", () => {
  assert.match(ios("ArdiaWebView+PageCommands.mm"), /\[_tab grantMediaPlayToFrame:_reports\.nowPlaying\.frame \?: @""\]/);
  assert.match(core("ac_page_channel.mm"), /page->NoteMediaCommand\(\);/);
  assert.match(core("renderer/ac_content_renderer_client.cc"), /NoteArdiaMediaCommand\(\)/);
  assert.match(added("third_party/blink/renderer/core/html/media/autoplay_policy.cc"), /void AutoplayPolicy::ArdiaNoteMediaCommand\(LocalFrame& frame\) \{\nArdiaNoteUsedHere\(&frame\);\nLocalFrame::NotifyUserActivation\(/);
});

test("docs/engine-build.md lists the autoplay patch", () => {
  assert.ok(read("../../../docs/engine-build.md").includes(`| \`${patchName}\` |`), `docs/engine-build.md has no row for ${patchName}`);
});
