# Crawler mode

Ardia Fork only, on `t3/fork-crawler-mode` and, carried onto the Chromium 158 base, `t3/fork-crawler-mode-m158`; not
released. Approved 2026-11-18 with the owner's choices below. Mac only: Linux and Windows have no crawler pod, so
`PLATFORM_FEATURES.crawlerProfiles` is off there and Settings doesn't show it.

The `ardia` command left this repo: it is the Command Line plugin in ardia-browser/plugins (`docs/cli.md`). Its crawler
pieces (`ardia crawler status|reset`, `ardia browse --profile`) were written for the old `apps/cli` and aren't in the
pinned plugin yet, so on this base only the app side (control socket `crawler.profile` and `crawler.reset`, the status
file) and the launcher work until the plugin carries them. `scripts/crawler/run-proof.mjs` takes `--cli DIR` (a plugins
checkout's `plugins/cli` with those commands) for its five CLI checks, or `--skip-cli` to list them as SKIP.

## Using it

An agent crawl on a hidden scratch instance:

```
scripts/agent/crawler-launch <Ardia.app> [--header VALUE] [--shopify-signatures FILE] [--net-log FILE] [--metro HOST:PORT]
→ {"pid": 123, "port": 9333, "dataDir": "…/runs/…", "netLog": null, "ready": true}
agent-browser --cdp 9333 open "https://<store>/?utm_campaign=ardia-crawl-<run>"
```

It prints the port only once every crawler profile is ready; otherwise it quits the instance it started and exits
non-zero. `--no-crawler` starts the same instance without crawler mode, for a control run. The signatures file is
`[{"domain", "signatureInput", "signature"}]`, a regular 0600 file owned by you.

A Crawler profile in the everyday Fork: Settings › Profiles, under All profiles, › Crawler profiles › New Crawler Profile… makes a new
profile (named "Crawler" unless you change it) that is a crawler profile from the start, before any tab, private
window or WebKit page can exist in it. An existing profile can't become one, and a crawler profile can't stop being
one: delete the profile instead, which also removes its signatures. Add the store's Shopify signature on its page. Agents use `ardia browse --profile <name> open <url>`, and `ardia crawler reset --profile
<name>` between runs. `ardia crawler status --wait 30` says whether it's ready and what it blocked.

Limits:
- Network prediction (DNS prefetch, preconnect) stays on: turning it off per profile needs an engine call. It counts
  nothing, but a preconnect can open a connection to a tracker host.
- A NetLog records request headers. With any crawler profile (or instance mode), `chrome://net-export` and
  `chrome://net-internals` don't open in any profile, under any spelling (`chrome:`, `chrome-untrusted:`, `ardia:`,
  `about:`, nested `view-source:`, any case, paths and queries), and one already open is closed before a crawler
  profile starts. A `net-log` switch in the launch (`--log-net-log`, `--net-log-capture-mode`, any `net-log…`, bare or
  dashed) means no signature is installed, so a `--net-log` run has none; run the signed crawl without it.
- A full-CDP client on a scratch instance (the crawler itself) can read request headers, signatures included, through
  the DevTools Network domain. That is by design: it is the trusted driver of that instance.
- Crawler profiles are Chromium only and have no private windows: WebKit defaults, site rules and "Open in WebKit"
  don't apply to them, and native WebKit tabs refuse them.
- A crawler profile is ephemeral apart from its signatures (in the keychain): before the engine loads it, at every
  launch, its site storage folders (Service Worker, IndexedDB, Local Storage, Cookies, caches and the like, never the
  profile folder itself) are deleted on disk, so no worker from an earlier run can start; the runtime clear under the
  navigation hold stays as a second layer. In instance mode every profile folder of the scratch data dir is wiped the
  same way. The wipe only works inside plain directories: a profile folder (or its Caches twin) that is a symlink or
  resolves outside the data folder, a name that isn't a single path component, a folder it can't list or an item it
  can't remove all count as failures. A failed wipe refuses that profile's load and reports it not ready ("its storage
  couldn't be cleared before loading"); in instance mode the app doesn't start at all (exit 78). The process that wipes
  holds an exclusive lock on `Chromium/ArdiaCrawlerOwner.lock` for its lifetime; every Ardia process tries to take it
  at startup, crawler mode or not, and the folder only counts as owned while no other live process holds Chromium's
  own `SingletonLock` there, so a crawler launch on a folder another Ardia is using wipes nothing and stops.
  `crawler=on` without a scratch `ARDIA_DATA_DIR` exits 78 before the data folder or Chromium is touched.
  Accepted limit: the folder checks and the deletes are separate path operations, so a process already running as the
  same user could swap a checked folder for a symlink in between; that's outside the threat model. Clear Crawler Data does the same mid-session: the
  fail-closed rule first, then its tabs close and the app waits until they are destroyed (unload handlers get up to
  about 4 s), then the data is cleared, then the fail-closed rule is replaced and the self-test runs again.
- Blocked counts come from DNR's `getMatchedRules`: a recent window (about 5 minutes on closed pages), not a lifetime total.
- A ready crawler profile keeps a hidden `chrome-extension://jphbnffonbejilmcbfhnpjfmblejpcgc/bridge.html` tab; filter it
  out of CDP target lists.

| Decision | Choice | When |
| --- | --- | --- |
| Entry points | A launch mode for hidden scratch instances **and** a Crawler profile in the everyday Fork | Owner, 2026-11-18, this thread |
| Signature | Shopify's own mechanism (Web Bot Auth, per domain) on Shopify stores, plus `X-Ardia-Crawler` on navigations; user agent unchanged | Owner asked "how does Shopify want it", 2026-11-18 |
| Klaviyo | Block its tracking, keep its forms | Owner, 2026-11-18 |
| GA4 dashboard check | Skipped; the NetLog proof covers GA4 | Owner chose "Build it", 2026-11-18 |
| Engine | No change under `engine/`: it is hashed into the engine key, and this Mac has no Chromium tree, so the Fork must keep the prebuilt engine | This session, 2026-11-18 |
| Crawler profiles | A per-profile switch on any profile but the original one, plus "New Crawler Profile…" as a shortcut; turning on converts a live profile block-first, turning off keeps its label and signatures | Owner: "bring back the switch", 2026-11-19; commit 15458cdc5 onward |
| Last resort | When a crawler profile can establish neither a confirmed block-all rule nor destroyed pages with cleared data, Ardia quits (exit 78), in the everyday Fork too | This session, commit 681a599cb, 2026-11-19 |
| Fail closed | Containment (block-all rule, close tabs, wait, clear; quit a scratch instance), since no engine-level network barrier exists | Codex review rounds 1–4, 2026-11-18 and 2026-11-19 |
| Review status | Codex (gpt-6.1-sol) security review: SHIP on the full range after nine rounds for the creation-only design and seven more for the switch, no open findings; run-proof 46/46 on the same commit | Commit 885d1893e, 2026-11-19 |
| Dev-store before/after | Passed on the first read: crawler and signed and agent-browser runs made no session; the control made one (see Dev-store result); 24-hour re-read scheduled | 2026-11-19 16:47 UTC |

## The goal

An agent (agent-browser, the QA skills) drives the Fork over the DevTools protocol through a client's storefront, and
the client's analytics record nothing: no GA4 session, no Shopify session or page view, no Meta, Clarity or Klaviyo
event. A crawl also identifies itself the way the site wants.

A signature alone doesn't keep a crawl out of analytics. GA4 and Shopify don't filter custom user agents or headers by
default, and most trackers never see request headers anyway: they run in the page and send their own beacons. So
crawler mode's real work is **blocking tracking requests before they leave the browser**. The signature is a label on top.

What it can't stop: tracking a client's server does by itself (order and cart webhooks feeding GA4 or Meta, CDN request
analytics). That needs a per-client check, listed below.

No second agent in the browser. Crawler mode is a browser setting; the existing tools drive it.

## What the code has today

- **DNR and a navigation hold already exist.** The bundled content blocker is uBlock Origin, loaded per profile as a
  component extension (`ArdiaContentBlocker.mm`, `loadComponentExtension:`). ArdiaCore can hold a profile's navigations
  until an extension's declarativeNetRequest rulesets are in force (`holdNavigationsUntilRulesetsOf:`).
- **That hold fails open.** After 10 s, or when rulesets fail to load, held navigations go ahead without blocking
  (`ac_navigation_hold.mm`, `Hold::Release`). Fine for an ad blocker, not for crawler mode, and changing it is an engine
  change. Crawler mode adds its own fail-closed check on top (below).
- **The tab layer reports what's needed:** `tab:didFailLoad:code:description:` (the net error code) and
  `tab:didBlockRequests:lastURL:`.
- **The real-profile CDP path can't set headers or intercept requests.** `ardia browse`'s token path refuses
  `Network.setExtraHTTPHeaders`, `Fetch.*` and `Emulation.setUserAgentOverride` (`docs/cli.md`, "Gated by the token
  policy"), and `Target.createTarget` with a `browserContextId`. So the browser has to enforce blocking and the signature
  itself, and opening a tab in another profile goes through the control socket.
- **Full CDP needs a scratch data dir.** `ARDIA_REMOTE_DEBUGGING_PORT` only works on the mock keychain.
- **Why not reuse uBlock's tracker lists:** they're the user's settings (allowlists, lists turned off), and their
  coverage of first-party paths like Shopify's monorail isn't ours to guarantee. Crawler mode has its own ruleset that no
  setting turns off.

## Design

### 1. Two entry points, one mechanism

A **crawler profile** is a profile where the crawler extension is loaded, its readiness is checked, and its headers are
set. There are two ways to get one:

- **Scratch instance (agent-browser, full CDP).** `ARDIA_INSTANCE crawler=on` makes every profile in that instance a
  crawler profile. Refused unless the data dir is a scratch dir, as for the DevTools port.

  ```
  scripts/agent/crawler-launch <Fork.app> [--signature <value>] [--shopify-signatures <file>]
  → {"pid": …, "port": 9333, "dataDir": "/…/crawl-…", "ready": true}
  agent-browser --cdp 9333 open "https://<store>/?utm_campaign=ardia-crawl-<run>"
  ```

  The launcher prints the port only once the status file says ready, and kills the instance and exits non-zero if it
  never does.

- **Crawler profile in the everyday Fork (`ardia browse`, token path).** Settings › Profiles gets "Crawler profile" on a
  profile (off by default; a new profile named "Crawler" is the expected use). Its sidebar and switcher show a Crawler
  badge, so nobody browses in it by accident. `ardia browse --profile <name> open <url>` opens its tab there through the
  control socket and then attaches. `ardia crawler reset --profile <name>` clears its cookies and storage between runs.

### 2. Blocking: a built-in DNR extension

`packages/ardiacore/extensions/ardia-crawler/`: a Manifest V3 component extension (`declarativeNetRequest`,
`declarativeNetRequestFeedback`) with a fixed id from its manifest key, loaded only into crawler profiles, hidden from the
Extensions page, and not something the user can turn off. DNR covers scripts, XHR and fetch, `sendBeacon`, pixels,
iframes, WebSockets, and requests from service workers, popups and new windows, across the whole profile, including
targets CDP never attached to.

One static ruleset, `trackers`, generated from a readable source list in the repo.

**a. Hosts, blocked outright**

| Vendor | Hosts |
| --- | --- |
| Google (GA4, GTM, Ads) | `google-analytics.com`, `analytics.google.com`, `googletagmanager.com`, `doubleclick.net`, `googleadservices.com`, `googlesyndication.com`, `www.google.com/ccm/collect`, `www.google.com/pagead/` |
| Shopify | `monorail-edge.shopifysvc.com`, `error-analytics-sessions-production.shopifysvc.com` |
| Meta | `connect.facebook.net`, `www.facebook.com/tr` |
| Microsoft | `clarity.ms` (and subdomains), `bat.bing.com` |
| Klaviyo (tracking only) | `a.klaviyo.com/client/events`, `a.klaviyo.com/onsite/track-analytics`, `static-tracking.klaviyo.com`; `klaviyo.js` and forms stay working |
| Others | TikTok, Pinterest, Snap, Reddit, X, LinkedIn pixels; Hotjar, FullStory, Lucky Orange, Heap, Segment, Mixpanel, Amplitude, PostHog; Triple Whale, Northbeam, Elevar `hits.getelevar.com`, Attentive events; Cloudflare Web Analytics, Plausible, Fathom |

**b. Paths, on any host** (first-party proxies and server-side tagging endpoints a host list misses):

| Pattern | What it is |
| --- | --- |
| `/.well-known/shopify/monorail/` | Shopify's first-party analytics (sessions, page views) |
| `/cdn/wpm/`, `/wpm@`, `/web-pixels@`, `/cdn/shopifycloud/web-pixels-manager/` | Shopify's Web Pixels Manager, which runs every customer-event pixel |
| `/s/trekkie.storefront.`, `/cdn/shopifycloud/perf-kit/` | Shopify's older tracker and its performance beacons |
| `/g/collect`, `/j/collect`, `/mp/collect`, `collect?v=2&tid=G-` | GA4 hits, on Google or a first-party proxy |
| `/gtm.js?id=GTM-`, `/gtag/js?id=` | GTM and gtag loaders served first-party |
| `/tr?id=…&ev=`, `/tr/?id=` | Meta pixel through a proxy |
| `/matomo.php`, `/piwik.php`, `/_vercel/insights/` | Self-hosted analytics |

Each source entry has a fixture URL that must match it, and there's a list of URLs that must not match (theme assets on
`cdn.shopify.com`, `/cart.js`, `/cart/add.js`, `/products/<handle>.js`, checkout, `shop.app` login, Klaviyo's form
script). Blocking GTM also breaks what a site loads through it, so **crawler mode can't be used to QA the tags
themselves**; do that without it, on a dev store.

**c. Less leakage.** Crawler profiles turn off network prediction (DNS prefetch, preconnect) and prerendering, so a
`<link rel=preconnect>` to a tracker doesn't open a connection. It counts nothing, but it would muddy the proof.

### 3. Fail closed, without an engine change

The existing hold covers the first navigations. On top of it, a crawler profile isn't **ready** until a self-test
passes: the ruleset also blocks `ardia-crawler-selftest.invalid` as a main frame, and the app loads that host in a hidden
tab. `ERR_BLOCKED_BY_CLIENT` (-20) proves the ruleset is in force (DNR loads a ruleset as a whole); a DNS error or a
timeout means it isn't. Header rules have to be confirmed too (the extension answers with its session rule count).

Until ready: the launcher doesn't print the port, `ardia browse --profile` refuses, and the app won't open tabs in the
profile. If it never gets ready, the status file says why. A real engine-level strict hold is a follow-up for upstream,
where the engine is built.

### 4. The signature, the way each site wants it

- **Shopify: Web Bot Auth.** Shopify's documented way to let a merchant's own crawlers and test tools through
  ([help center](https://help.shopify.com/en/manual/promoting-marketing/seo/crawling-your-store)): in the store's admin,
  Online Store › Preferences › Crawler access › Create signature, for one connected domain, valid up to 3 months. Every
  request to that domain carries three headers: `Signature-Input`, `Signature` and `Signature-Agent: "https://shopify.com"`.
  Without it Shopify rate-limits and challenges crawlers. Shopify doesn't say signed traffic leaves analytics, so it's
  for access, not for hiding; test T5 measures it.
  - Crawler mode sends them only to the signature's exact domain, on every request type there, as Shopify asks. The
    values are credentials: kept in the keychain for a Crawler profile, read from a 0600 file for a scratch instance,
    held in DNR session rules (in memory, never written to the profile), never logged, and the status file shows only the
    domain and the expiry (read from `expires=` in `Signature-Input`). An expired one is reported and not sent.
  - Checkout on another domain needs its own signature, as Shopify notes.
- **Everything else:** `X-Ardia-Crawler: <value>` (default `qa; run=<run id>`) on top-level and iframe navigations only,
  so it can't cause a CORS preflight and doesn't go to third-party CDNs. Server logs, Cloudflare rules and a client's sGTM
  see it on every page load.
- **User agent unchanged.** Shopify's mechanism doesn't use it, and a changed one risks bot challenges and pages that
  differ from what customers get.
- The run id also goes in the landing URL as `utm_campaign=ardia-crawl-<run>`, which is how T5 finds a run's sessions.

### 5. Status and telemetry

- `<data dir>/crawler/status.json`, written by the app (0600), read by `ardia crawler status` and the launcher. Counts,
  domains and dates only, no URLs, never a signature value.
- Telemetry per AGENTS.md: a crawler-profile launch counter and a "crawler not ready" error event, on the existing usage
  and error events, inside the consent model, listed in the "What's Sent" copy. The Fork reports nothing to ardia.dev
  (`4f10b945d`), so the status file is the real readout.

## Contract between the pieces

**Launch keys** (`ARDIA_INSTANCE`, scratch data dir only): `crawler=on`, `crawlerHeader=<value>`,
`crawlerShopifySignatures=<path>`. The file is `[{"domain", "signatureInput", "signature"}]`, must be a regular 0600
file owned by the user, and is read once at launch.

**Extension messages** (sent by the pod the way `ArdiaContentBlocker` calls uBO):

- `{"what": "configure", "navigationHeader": "<value>" | null, "shopify": [{"domain", "signatureInput", "signature"}]}`
  → `{"ok": true, "sessionRules": <n>}`. Replaces all session rules.
- `{"what": "stats"}` → `{"blocked": {"<vendor>": <n>}, "rulesVersion": "<v>"}` (`getMatchedRules`, rule ids mapped
  to vendors by a table the generator writes).

**Status file** `<data dir>/crawler/status.json`:

```json
{
  "version": 1,
  "pid": 51234,
  "startedAt": "2026-11-18T21:04:04Z",
  "rulesVersion": "2026-11-18.1",
  "profiles": {
    "<profile id>": {
      "name": "Crawler",
      "source": "instance" | "profile",
      "ready": true,
      "reason": null,
      "readySince": "2026-11-18T21:04:05Z",
      "navigationHeader": true,
      "shopify": [{"domain": "shop.example.com", "expires": "2027-02-16T00:00:00Z", "sent": true, "detail": null}],
      "blocked": {"google": 12, "shopify": 30}
    }
  }
}
```

- `pid` and `startedAt` are the process that wrote the file and its launch time: a file whose `pid` isn't running, or
  runs with a different start time, is stale (a crashed or quit instance).
- `shopify[].detail` says why a signature isn't sent: `"expired"` (expired, or under 60 s left: a timer stops sending
  it 60 s before `expires`), `"its expiry can't be read"`, `"NetLog is on"` (a `net-log` switch in the
  switches or arguments, read the way the launch reads them), `"NetLog may be recording"` (a NetLog page was open), `"not installed"`
  (configure succeeded but the rule for it isn't in the session rules it read back),
  `"the Mac is going to sleep"`, `"crawler mode isn't ready"`, or `"not loaded"`; `null` when sent.
- Signature lifetime follows the wall clock: the expiry timer is a wall-clock deadline; before sleep the app removes
  every signature and lets sleep go ahead only once that's done; after wake or a clock change it reinstalls only the
  ones still valid. A reconfigure that fails there fails closed. A test instance drives these with
  `notifyutil -p com.ardia.test.crawler.<pid>.sleep|wake`, and `notifyutil -s com.ardia.test.crawler.<pid>.clock
  <seconds> -p com.ardia.test.crawler.<pid>.clock` for a clock jump forward. The same prefix also takes
  `retryNextBridge` (the next bridge call gets a retriable error and retries 1.5 s later), `failNextBridge`, `fail`
  (every crawler profile fails), `reconfigure` and `logRules` (session rule ids and request labels, never signature
  values, to the log).
- `sent` is what is actually installed: after `configure`, the app reads the session rules back and marks sent only
  the domains that have a signature rule.
- Not ready is fail closed. In instance mode the app writes the file and quits (exit 78) as soon as a profile ends not
  ready for any reason but still starting. In profile mode, when a profile that was ready fails later, the app installs
  the block-all rule first, then closes every tab of that profile (WebKit pages too), waits until they're destroyed,
  clears its site data, refuses new ones natively until it's ready, and only then releases the navigation hold. When
  the extension never loaded at startup no page has run in it, because navigations were held. A profile that isn't
  ready within 8 s of its hold is `timeout`, before the engine's own 10 s hold ends.
- Every rule change for a profile (rulesets, configure, the fail-closed rule) goes through one queue per profile, and
  each step carries the lifecycle token it was made for: a step whose token is stale is dropped before every retry,
  page creation and script run, so an obsolete configure can't land after a newer step.
- Before sleep the app covers every loaded crawler profile, starting, ready or failing, and supersedes any pending
  configure; it reinstalls each profile's header with no signatures, reading no credentials, within 20 s;
  if that isn't confirmed it installs the block-all rule, closes the profile's tabs and waits for them to go. Sleep is
  acknowledged only after one of the two.
- `crawler.setProfile` with `enabled: true` turns any profile but the original one (the engine's `Default`, which
  loads before crawler mode can clear it) into a crawler profile. It's refused while the profile is loading, has a
  private window or has a WebKit tab ("Close this profile's private windows first", "… WebKit tabs first"). An unloaded
  profile is only marked, and wiped on disk before it loads. A loaded one is converted: the crawler extension loads and
  its block-all rule must be confirmed within 10 s, and only then are its tabs closed, waited for and its site data
  cleared before the normal start and self-test; if the extension or the rule fails, the switch stays off and nothing
  is closed. The switch reports on only once those old pages are destroyed and the data is cleared: that, not the rule
  confirmation, is the boundary, since a connection opened before it (a WebSocket, say) lives until its page goes.
  While it converts, Clear Crawler Data and the switch itself are refused ("still turning on"), and a conversion that a
  newer operation (deleting the profile) overtakes never rolls anything back. A WebKit page counts whether it's a live
  tab or a view parked or offered in a tab transfer, and so does an unfinished WebKit download; resuming a WebKit
  download is refused in a crawler profile. If a page outlives the 6 s close deadline (a monotonic clock) or the data
  clear doesn't answer within 20 s, the switch stays on but the profile stays blocked and not ready ("crawler mode is
  on but not ready: …"); it recovers only through Clear Crawler Data, which contains it again. Clear Crawler Data
  itself first needs the block-everything rule confirmed, as turning on does, or it changes nothing. Containment counts
  as done only with that rule in force or with every page destroyed and the data cleared. Deleting a crawler profile
  whose containment fails keeps it a blocked crawler profile and reports the deletion failed; the app retries the
  orphaned data at next launch. An expiring signature is removed on its own timer whatever state the profile is in:
  on a profile that isn't ready only the signature rules go, keeping the block-all rule.
- Last resort: when a crawler profile can establish neither safety condition (a confirmed block-everything rule, or
  every page destroyed with its data cleared), Ardia quits rather than leave it uncontained, in the everyday Fork as in
  a scratch instance (exit 78, the reason logged). That takes two failures at once, the extension bridge failing to
  install a rule while a page survives its close or the clear stalls, or an expiring signature that can't be removed
  with no block rule in force. Label and signature
  changes wait while a profile converts, contains or is deleted, and before sleep a converting profile (which holds no
  signatures yet) keeps its block-all rule. `enabled: false` stops crawler mode (the extension unloads with its rules) and keeps the profile's label and
  signatures for next time. Deleting the profile contains it first (block-all rule, close
  its tabs, wait until they're destroyed, clear its data), then removes its crawler settings and signatures, unloads the
  extension and hands the profile to Chromium for deletion.
- When a signature reaches its expiry margin, the profile is first reconfigured with no signatures and no keychain read,
  then the still-valid ones are read back; a keychain read that hasn't answered in 10 s counts as no signatures.
- A configure reads its credentials inside the fenced queue step, and a newer configure request supersedes any older
  one, so a slow keychain read can't reinstall a signature that was removed meanwhile.

## What gets built

| Piece | Where |
| --- | --- |
| Extension, source list, generator, fixtures, unit test | `packages/ardiacore/extensions/ardia-crawler/`, its generator under `packages/ardiacore/scripts/` |
| Crawler profiles: load, self-test, session rules, prediction off, status file, launch keys | `packages/ardiacore/ios/ArdiaCrawler*.mm`, its Expo module, `ArdiaLaunchConfig` |
| Crawler profile setting, badge, signatures in Settings, telemetry | `apps/browser/src` (settings rows, profiles state, telemetry) |
| `ardia crawler status\|reset\|signature`, `ardia browse --profile` | The Command Line plugin (ardia-browser/plugins, `plugins/cli`); written for the old `apps/cli`, not carried yet |
| Launcher and proof harness (fixture server, NetLog check, dev-store readout) | `scripts/agent/crawler-launch`, `scripts/crawler/` |
| Docs | `docs/crawler-mode.md` (this note becomes it), env table in `docs/agent-brief.md` |

## Server-side tracking: the per-client check

Blocking in the browser can't stop events a server sends by itself. Before crawling a client store, check:

1. **Never complete a checkout.** Orders reach GA4, Meta CAPI, Klaviyo and attribution apps server-side.
2. **Cart webhooks.** Littledata and similar apps send `add_to_cart` server-side from Shopify's cart webhooks, so an
   add-to-cart can still count. Check the store's apps; skip add-to-cart there, or use a dev store.
3. **Server-side containers.** Elevar, Stape or a client sGTM fed by webhooks rather than the browser. Their browser-fed
   endpoints are blocked by the path rules; their webhook-fed events aren't.
4. **Request-level analytics.** Cloudflare or CDN analytics count requests; the signature headers are what let a client
   filter those.
5. **Klaviyo profiles.** Submitting a signup form creates a real profile. Follow the email-signup testing rules.

## Test plan

Every test runs on a hidden scratch instance (`open -g -n`, `ARDIA_BACKGROUND=1`, its own data dir and port), never the
owner's Fork. The proof doesn't rely on the browser's own word: Chrome's NetLog (`--log-net-log=<file>`, allowed on a
scratch instance) records every request the network stack sends, including service workers and beacons no CDP session
saw. **Each test also runs once with crawler mode off, as a control**: if the control doesn't show the trackers, the
detector is broken and a clean result means nothing.

| # | Test | Pass when |
| --- | --- | --- |
| T1 | Ruleset unit test (no build) | Every fixture tracker URL matches a rule, no must-not-block URL does, all regexes compile, within DNR's limits |
| T2 | **Local fixture page**: real snippets for gtag, GTM, Meta, Clarity, Klaviyo, TikTok, Pinterest, Hotjar; a first-party `/g/collect`; a monorail beacon; `sendBeacon` on pagehide; a service worker that fetches GA; an iframe; a popup; a tab opened over CDP but never attached | Crawler on: NetLog has zero requests to any blocked host or path, CDP shows `ERR_BLOCKED_BY_CLIENT`, the status counts match. Control: all of them appear in NetLog |
| T3 | Signatures | The fixture server sees `X-Ardia-Crawler` on top-level, iframe and popup navigations, not on subresources or third parties; Shopify headers go to the signed domain on every request and nowhere else; no CORS errors; an expired signature isn't sent and is reported |
| T4 | Fail closed (`ARDIA_TEST crawlerRulesFail=1` and a delayed load) | Status `ready: false` with the reason, the launcher exits non-zero with no port, `ardia browse --profile` refuses, NetLog has no request to the fixture |
| T5 | **Dev store before and after**, in ShopifyQL | The crawl's runs have 0 sessions; the control's run has at least 1 |
| T6 | Site still works | On the dev store with crawler on: home, collections, products, search and add-to-cart work; console errors are only the blocked trackers |
| T7 | Both entry points end to end | `agent-browser --cdp <port>` on a scratch instance, and `ardia browse --profile Crawler` on a Crawler profile, each run a QA-skill crawl of the dev store unchanged |

### T5 in detail: Shopify's own numbers

Checked 2026-11-18: the dev store's admin app has `read_reports`, and ShopifyQL answers grouped by `utm_campaign` and
`landing_page_path`. The dev store already gets 24 to 38 sessions a day from other testing, so the run is found by its tag, not
totals. The store has a password page.

1. Baseline: `FROM sessions SHOW sessions, pageviews GROUP BY utm_campaign SINCE today`.
2. **Crawl, crawler on**, fresh scratch instance, landing on `/?utm_campaign=ardia-crawl-<run>`, about 20 pages (home,
   collections, products, search, cart, add-to-cart; no checkout). Keep the NetLog.
3. **Crawl, crawler on, with the dev store's Web Bot Auth signature**, `utm_campaign=ardia-signed-<run>`.
4. **Control, crawler off**, a separate fresh instance, `utm_campaign=ardia-control-<run>`, run last so nothing shares cookies.
5. Read ShopifyQL at about 15 minutes, 2 hours and 24 hours; the 24-hour read is the one that counts.

Pass: `ardia-crawl-<run>` and `ardia-signed-<run>` never appear, and `ardia-control-<run>` does. If the control doesn't
appear either, Shopify filtered the hidden instance as a bot: the result is inconclusive, not a pass, and the control
reruns in a visible window on a spare desktop.

GA4, Meta, Clarity and Klaviyo aren't on the dev stores, so for them the proof is T2's NetLog: an event that never left
the machine can't be counted.

### Dev-store result

Run 2026-11-19 against the build of commit 1e269a308, 19 navigations each (home on a tagged URL, five collections, ten
products, search, an add-to-cart, the cart), uBlock off in every run so only the crawler ruleset blocked. Each run
logged in on the dev store's password page over DevTools and aborted the post-login redirect, then opened its tagged landing URL.

| Run (UTC) | Crawler mode | Tracker requests that left (NetLog / DevTools) | Shopify sessions (ShopifyQL, read at 16:47) |
| --- | --- | --- | --- |
| crawl, 16:36 | on | 0 / 0 (298 blocked) | none |
| signed, 16:41 | on, with the dev store's Web Bot Auth signature (all three headers reached the store) | not logged (no NetLog with signatures) / 0 (297 blocked) | none |
| control, 16:43 | off | 613 (monorail `produce_batch`, web pixels, perf-kit, OTLP) | 1 session, 19 page views, at 16:43 |
| agent-browser, 16:46 | on, driven by `agent-browser --cdp` (6 pages and a snapshot) | 0 (117 blocked) | none |

Add-to-cart answered 200 and every page loaded in the crawler runs (T6). No password or signature value appears in any
file the runs wrote. The control's session landed on `/password` with no campaign: on a password-protected store
Shopify tracks the password page itself, so the session starts there before the tagged landing. The runs are told
apart by the minute and the page-view count rather than by `utm_campaign`. The dev store runs only Shopify's own trackers, so
GA4, Meta, Clarity and Klaviyo are covered by T2's fixture, not this store. Re-reads at about 2 hours and 24 hours are
scheduled in the crawler-mode thread.

