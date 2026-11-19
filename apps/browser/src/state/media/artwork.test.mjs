import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const artwork = await import("./artwork.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const ART = "https://music.test/cover.png";

function playingTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const tab = S().newTab(w, { url: "https://music.test/", background: true });
  const asked = [];
  const answers = [];
  webviews.set(tab, { downloadArtwork: async (url, pixels) => (asked.push([url, pixels]), answers.shift() ?? null) });
  return { tab, asked, answers };
}

test("Playing now artwork is asked of the tab's media session once per track", async () => {
  const { tab, asked, answers } = playingTab();
  answers.push({ uri: "data:image/png;base64,AA==", width: 256, height: 256 });
  artwork.loadArtwork(tab, ART);
  artwork.loadArtwork(tab, ART);
  await tick();
  artwork.loadArtwork(tab, ART);
  assert.deepEqual(asked, [[ART, 256]]);
  assert.equal(artwork.artworkEntry(tab, ART)?.uri, "data:image/png;base64,AA==");
  webviews.delete(tab);
});

test("artwork the session wouldn't give a muted tab is asked again once the tab's sound comes back", async () => {
  const { tab, asked, answers } = playingTab();
  S().setMuted([tab], true);
  artwork.loadArtwork(tab, ART);
  await tick();
  assert.equal(artwork.artworkEntry(tab, ART)?.uri, null);
  artwork.loadArtwork(tab, ART);
  assert.equal(asked.length, 1, "a miss isn't asked again while nothing changed");
  S().setMuted([tab], false);
  assert.equal(artwork.artworkEntry(tab, ART), undefined, "unmuting forgets the miss");
  answers.push({ uri: "data:image/png;base64,AQ==", width: 256, height: 256 });
  artwork.loadArtwork(tab, ART);
  await tick();
  assert.equal(artwork.artworkEntry(tab, ART)?.uri, "data:image/png;base64,AQ==");
  assert.equal(asked.length, 2);
  webviews.delete(tab);
});

test("a closed tab's artwork is forgotten", async () => {
  const { tab, answers } = playingTab();
  answers.push({ uri: "data:image/png;base64,AA==", width: 256, height: 256 });
  artwork.loadArtwork(tab, ART);
  await tick();
  S().closeTab(tab);
  assert.equal(artwork.artworkEntry(tab, ART), undefined);
  webviews.delete(tab);
});
