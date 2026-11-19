#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHOP = "signed.crawler.test";
export const OTHER = "other.crawler.test";
export const EXPIRED = "expired.crawler.test";
export const FIXTURE_HOSTS = [SHOP, OTHER, EXPIRED];
export const VENDOR_HOSTS = [
  "www.googletagmanager.com", "www.google-analytics.com", "region1.google-analytics.com", "connect.facebook.net", "www.facebook.com",
  "www.clarity.ms", "scripts.clarity.ms", "k.clarity.ms", "static.klaviyo.com", "a.klaviyo.com", "static-tracking.klaviyo.com",
  "analytics.tiktok.com", "s.pinimg.com", "ct.pinterest.com", "static.hotjar.com", "script.hotjar.com", "cdn.shopify.com",
];
export const REDIRECTS = ["/redirect-other", "/redirect-http"];
export const MUST_LOAD = ["themeCss", "themeJs", "logo", "cart", "product", "klaviyoJs", "cors"];
export const SENSITIVE_HEADERS = ["x-ardia-crawler", "signature-input", "signature", "signature-agent"];

const GA = "G-FIXTURE01";
const GTM = "GTM-FIXTURE";
const META = "100000000000001";
const KLAVIYO = "FIXTR1";
const TIKTOK = "CFIXTURE0000000000";
const PINTEREST = "2610000000001";
const HOTJAR = 1000001;
const CLARITY = "fixture01";

const tagScript = `const tag = new URLSearchParams(location.search).get("tab") || "main";
window.__fixture = window.__fixture || { assets: {}, errors: [], tag };
const mark = (name) => { window.__fixture.assets[name] = true; };`;

const snippets = `
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA}');</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM}');</script>
<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META}');fbq('track','PageView');</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${META}&ev=PageView&noscript=1"/></noscript>
<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "${CLARITY}");</script>
<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=${KLAVIYO}" onload="mark('klaviyoJs')"></script>
<script>!function(){if(!window.klaviyo){window._klOnsite=window._klOnsite||[];try{window.klaviyo=new Proxy({},{get:function(n,i){return"push"===i?function(){var n;(n=window._klOnsite).push.apply(n,arguments)}:function(){for(var n=arguments.length,o=new Array(n),w=0;w<n;w++)o[w]=arguments[w];var t="function"==typeof o[o.length-1]?o.pop():void 0,e=new Promise((function(n){window._klOnsite.push([i].concat(o,[function(i){t&&t(i),n(i)}]))}));return e}}})}catch(n){window.klaviyo=window.klaviyo||[],window.klaviyo.push=function(){var n;(n=window._klOnsite).push.apply(n,arguments)}}}}();</script>
<script>klaviyo.push(['track', 'Viewed Fixture', {tab: tag}]);</script>
<script>!function (w, d, t) {w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load('${TIKTOK}');ttq.page();}(window, document, 'ttq');</script>
<script>!function(e){if(!window.pintrk){window.pintrk = function () {window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk('load', '${PINTEREST}');pintrk('page');</script>
<script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${HOTJAR},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');</script>`;

const mainPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Crawler fixture</title>
<script>${tagScript}</script>
<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/0000/0001/t/1/assets/theme.css" onload="mark('themeCss')">
<script src="https://cdn.shopify.com/s/files/1/0000/0001/t/1/assets/theme.js" onload="mark('themeJs')"></script>
${snippets}
</head><body>
<h1>Crawler fixture</h1>
<img src="https://cdn.shopify.com/s/files/1/0000/0001/files/logo.png" onload="mark('logo')" alt="">
<iframe src="https://${SHOP}/frame?tab=frame-same" title="same-site frame"></iframe>
<iframe src="https://${OTHER}/frame?tab=frame-other" title="cross-site frame"></iframe>
<script>
fetch('/cart.js').then((r) => r.ok && mark('cart'));
fetch('/products/fixture-tee.js').then((r) => r.ok && mark('product'));
fetch('/redirect-other?from=' + tag, { mode: 'no-cors' }).catch(() => {});
fetch('https://${OTHER}/cors?from=' + tag).then((r) => r.text()).then((t) => { if (t === 'ok') mark('cors'); }, (e) => window.__fixture.errors.push('cors: ' + e));
fetch('/g/collect?v=2&tid=${GA}&en=first_party&tab=' + tag, { method: 'POST', keepalive: true }).catch(() => {});
navigator.sendBeacon('/.well-known/shopify/monorail/unstable/produce_batch?tab=' + tag, JSON.stringify({ events: [{ schema_id: 'page_view' }] }));
addEventListener('pagehide', () => navigator.sendBeacon('https://www.google-analytics.com/g/collect?v=2&tid=${GA}&en=page_hide&tab=' + tag));
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('/sw.js?tab=' + tag).then(() => navigator.serviceWorker.ready).then((r) => {
    r.active.postMessage(tag);
    window.__fixture.serviceWorker = 'ready';
  }, (e) => { window.__fixture.serviceWorker = 'failed: ' + e; });
}
window.openPopup = () => !!window.open('https://${SHOP}/popup?tab=popup', 'crawler-popup', 'width=400,height=300');
</script>
</body></html>`;

const framePage = `<!doctype html><html><head><meta charset="utf-8"><title>frame</title><script>${tagScript}</script></head><body>
<img src="https://www.facebook.com/tr?id=${META}&ev=FrameView&tab=frame" alt="">
<script>fetch('/g/collect?v=2&tid=${GA}&en=frame&tab=' + tag, { method: 'POST' }).catch(() => {});</script>
</body></html>`;

const popupPage = `<!doctype html><html><head><meta charset="utf-8"><title>popup</title><script>${tagScript}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA}');</script>
</head><body>popup<script>fetch('/g/collect?v=2&tid=${GA}&en=popup&tab=' + tag, { method: 'POST' }).catch(() => {});</script></body></html>`;

const plainPage = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${title}<script>fetch('/sub?from=${title}').catch(() => {});</script></body></html>`;

const serviceWorker = `const hit = (en, tab) => fetch('https://www.google-analytics.com/g/collect?v=2&tid=${GA}&en=' + en + '&tab=' + tab, { mode: 'no-cors', keepalive: true }).catch(() => {});
const tab = new URL(location.href).searchParams.get('tab') || 'sw';
self.addEventListener('install', (event) => { self.skipWaiting(); event.waitUntil(hit('sw_install', tab)); });
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => event.waitUntil(hit('sw_message', String(event.data))));`;

const vendorScripts = {
  "www.googletagmanager.com/gtag/js": `(() => { const dl = window.dataLayer || []; const id = new URL(document.currentScript.src).searchParams.get('id'); const tab = (window.__fixture || {}).tag || '';
    navigator.sendBeacon('https://region1.google-analytics.com/g/collect?v=2&tid=' + id + '&en=page_view&tab=' + tab);
    fetch('https://www.google-analytics.com/g/collect?v=2&tid=' + id + '&en=user_engagement&tab=' + tab, { mode: 'no-cors', keepalive: true }).catch(() => {}); window.__gtagSeen = dl.length; })();`,
  "www.googletagmanager.com/gtm.js": `(() => { const tab = (window.__fixture || {}).tag || ''; const img = new Image(); img.src = 'https://www.google-analytics.com/j/collect?v=1&tid=UA-FIXTURE-1&t=pageview&tab=' + tab; })();`,
  "connect.facebook.net/en_US/fbevents.js": `(() => { const tab = (window.__fixture || {}).tag || ''; for (const call of (window.fbq && window.fbq.queue) || []) if (call[0] === 'track') { const img = new Image(); img.src = 'https://www.facebook.com/tr?id=${META}&ev=' + call[1] + '&tab=' + tab; } })();`,
  "www.clarity.ms/tag": `(() => { const s = document.createElement('script'); s.src = 'https://scripts.clarity.ms/0.8.0/clarity.js'; document.head.appendChild(s); })();`,
  "scripts.clarity.ms/0.8.0/clarity.js": `fetch('https://k.clarity.ms/collect', { method: 'POST', body: 'fixture', mode: 'no-cors' }).catch(() => {});`,
  "static.klaviyo.com/onsite/js/klaviyo.js": `(() => { const tab = (window.__fixture || {}).tag || ''; window.__klaviyoForms = true;
    for (const call of window._klOnsite || []) if (call[0] === 'track') fetch('https://a.klaviyo.com/client/events/?company_id=${KLAVIYO}&tab=' + tab, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ metric: call[1] }) }).catch(() => {});
    fetch('https://a.klaviyo.com/onsite/track-analytics?company_id=${KLAVIYO}&tab=' + tab, { method: 'POST', mode: 'no-cors' }).catch(() => {});
    const s = document.createElement('script'); s.src = 'https://static-tracking.klaviyo.com/onsite/js/tracking.js'; document.head.appendChild(s); })();`,
  "analytics.tiktok.com/i18n/pixel/events.js": `fetch('https://analytics.tiktok.com/api/v2/pixel?sdkid=${TIKTOK}&tab=' + ((window.__fixture || {}).tag || ''), { method: 'POST', mode: 'no-cors' }).catch(() => {});`,
  "s.pinimg.com/ct/core.js": `(() => { const img = new Image(); img.src = 'https://ct.pinterest.com/v3/?tid=${PINTEREST}&event=init&tab=' + ((window.__fixture || {}).tag || ''); })();`,
  "static.hotjar.com/c/hotjar-": `(() => { const s = document.createElement('script'); s.src = 'https://script.hotjar.com/modules.fixture.js'; document.head.appendChild(s); })();`,
  "cdn.shopify.com/s/files/1/0000/0001/t/1/assets/theme.js": `window.__themeLoaded = true;`,
};

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function vendorScript(host, path) {
  const key = Object.keys(vendorScripts).find((prefix) => `${host}${path}`.startsWith(prefix));
  return key ? vendorScripts[key] : null;
}

function respond(req, res) {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  const url = new URL(req.url, `https://${host || SHOP}`);
  const path = url.pathname;
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
    res.end(body);
  };
  if (req.method === "OPTIONS") return send(204, "text/plain", "", { "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  if (FIXTURE_HOSTS.includes(host)) {
    if (path === "/" ) return send(200, "text/html; charset=utf-8", mainPage);
    if (path === "/frame") return send(200, "text/html; charset=utf-8", framePage);
    if (path === "/popup") return send(200, "text/html; charset=utf-8", popupPage);
    if (path === "/sw.js") return send(200, "text/javascript", serviceWorker, { "service-worker-allowed": "/" });
    if (path === "/cors") return send(200, "text/plain", "ok", { "access-control-allow-origin": "*" });
    if (path === "/redirect-other") return send(302, "text/plain", "", { location: `https://${OTHER}/landed${url.search || "?"}&via=redirect-other`, "access-control-allow-origin": "*" });
    if (path === "/redirect-http") return send(302, "text/plain", "", { location: `http://${SHOP}/landed${url.search || "?"}&via=redirect-http`, "access-control-allow-origin": "*" });
    if (path === "/landed") return send(200, "text/html; charset=utf-8", plainPage("landed"), { "access-control-allow-origin": "*" });
    if (path === "/cart.js") return send(200, "application/json", JSON.stringify({ items: [], item_count: 0 }));
    if (path.startsWith("/products/") && path.endsWith(".js")) return send(200, "application/json", JSON.stringify({ handle: "fixture-tee" }));
    if (path === "/g/collect" || path.startsWith("/.well-known/shopify/monorail/")) return send(204, "text/plain", "");
    if (path === "/favicon.ico") return send(204, "image/x-icon", "");
    return send(200, "text/html; charset=utf-8", plainPage(path.slice(1).replace(/[^a-z0-9-]/gi, "") || "page"));
  }
  const script = vendorScript(host, path);
  if (script) return send(200, "text/javascript", script, { "access-control-allow-origin": "*" });
  if (path.endsWith(".css")) return send(200, "text/css", "body { margin: 0 }");
  if (path.endsWith(".png") || path.endsWith(".gif") || host === "www.facebook.com" || host === "ct.pinterest.com") return send(200, "image/gif", GIF);
  if (path.endsWith(".js")) return send(200, "text/javascript", "void 0;", { "access-control-allow-origin": "*" });
  return send(204, "text/plain", "", { "access-control-allow-origin": "*" });
}

export function requestRecord(req, at = Date.now()) {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  const url = new URL(req.url, "https://fixture.invalid");
  const present = Object.fromEntries(SENSITIVE_HEADERS.map((name) => [name, req.headers[name] !== undefined]));
  return {
    at, scheme: req.socket?.encrypted ? "https" : "http", method: req.method, host, path: url.pathname, query: url.search, dest: req.headers["sec-fetch-dest"] ?? null,
    mode: req.headers["sec-fetch-mode"] ?? null, crawlerHeader: present["x-ardia-crawler"], signatureInput: present["signature-input"],
    signature: present.signature, signatureAgent: present["signature-agent"],
  };
}

function certificate(dir) {
  const key = join(dir, "fixture-key.pem");
  const cert = join(dir, "fixture-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=crawler.test", "-days", "2",
      "-addext", `subjectAltName=${[...FIXTURE_HOSTS, ...VENDOR_HOSTS].map((h) => `DNS:${h}`).join(",")}`, "-keyout", key, "-out", cert],
    { stdio: "ignore", timeout: 30000 });
    chmodSync(key, 0o600);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export async function startFixtureServer({ dir, log = join(dir, "fixture-requests.jsonl") } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(log, "", { mode: 0o600 });
  const seen = [];
  const handle = (req, res) => {
    const record = requestRecord(req);
    seen.push(record);
    appendFileSync(log, `${JSON.stringify(record)}\n`);
    try {
      respond(req, res);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  };
  const tls = createServer(certificate(dir), handle);
  const plain = createHttpServer(handle);
  const sockets = new Set();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("readable", () => {
      const first = socket.read();
      if (!first) return socket.destroy();
      socket.unshift(first);
      (first[0] === 0x16 ? tls : plain).emit("connection", socket);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  const hostRules = [...FIXTURE_HOSTS, ...VENDOR_HOSTS].map((host) => `MAP ${host} 127.0.0.1:${port}`).join(",");
  return {
    port,
    log,
    hostRules,
    switches: [`--host-rules=${hostRules}`, "--ignore-certificate-errors"],
    requests: () => [...seen],
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || dir === "-h" || dir === "--help") {
    process.stdout.write("usage: scripts/crawler/fixture-server.mjs <dir>  serves the crawler fixture on 127.0.0.1 (HTTPS, random port), logs to <dir>/fixture-requests.jsonl, prints {port, log, switches}\n");
    process.exit(dir ? 0 : 64);
  }
  const fixture = await startFixtureServer({ dir: resolve(dir) });
  process.stdout.write(`${JSON.stringify({ port: fixture.port, log: fixture.log, switches: fixture.switches })}\n`);
  const stop = () => fixture.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
