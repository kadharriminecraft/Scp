/* SCP WIKI WORKER - Cloudflare Worker: pure JSON render + asset API for
   the SCP Wiki. Deploy: dash.cloudflare.com -> Workers & Pages -> Create
   Worker -> paste this file -> Deploy (from any device that can open the
   dashboard). Opening the worker URL shows a small JSON status object -
   that is expected: this worker serves NO pages. The browser app is the
   separate single-file scp-browser.html, which paints the real wiki
   inside a sandboxed iframe using /api/render packages from this worker
   (/api/asset for images and fonts; /api/random via Crom - search was removed entirely in v3.5).
   Optional env vars: DEFAULT_SITE, EXTRA_HOSTS (comma-separated hosts). */

/* =====================================================================
   SCP WIKI WORKER - Cloudflare Worker: pure JSON render + asset API
   =====================================================================
   Purpose:
     The single-file mobile browser app (scp-browser.html) shows the REAL
     SCP Wiki - actual pages, actual themes, actual layout - but every
     byte flows through this worker as JSON. The phone never contacts
     scp-wiki.wikidot.com, and the worker never serves a web page:
     it returns a JSON "render package" and the app paints it inside a
     sandboxed iframe. Opening the worker URL itself just shows a small
     JSON status object - that is by design.

   URL scheme (everything the worker serves):
     /  (and /__worker/ping)   ->  JSON status + endpoint list
     /api/render?t=<token>     ->  JSON render package:
         { ok, url, finalUrl, title, icon, html, assets }
         - the REAL page HTML, fetched upstream (redirects followed)
         - ads / trackers / ALL scripts / machinery frames removed
         - stylesheets fetched + @import chains INLINED server-side
           (~10 upstream fetches total - well inside the 50-subrequest
           cap of the free plan; themes always make it through)
         - css url() assets point straight at /api/asset so the
           browser lazily loads exactly the fonts/images it renders
         - <img> tags use lazy tokens (the bridge swaps in blobs)
         - links absolutized so in-app navigation just works
         - a tiny "bridge" script injected for clicks/scroll
     /api/asset?t=<token>      ->  raw asset proxy (images, fonts,
         files) with CORS. HTML content is refused (415) - the worker
         never mirrors pages.
     /api/frame?t=<token>      ->  content-iframe proxy (games like
         the SCP-6634 Godot engine, interwiki widgets, embeds) with
         scripts INTACT and all subresources + runtime fetches/XHRs
         re-pointed at /api/asset
     /api/random               ->  JSON random page (Crom GraphQL,
         accepts &site=<wiki-host> to target the branch you browse)
     /api/search               ->  REMOVED in v3.5. Search is gone by
         design everywhere; the wiki's own search button is rendered
         but intentionally non-functional.
     anything else             ->  JSON 404 with the endpoint list

   OPAQUE TOKENS (v3.6): the ?t= parameters are XOR-obfuscated +
   base64url'd absolute upstream urls, so no upstream hostname (e.g.
   ironshears.github.io) is readable in any request the phone makes -
   organization filters that decode query strings and category-block
   hosts were killing the 6634 game frame even though it already
   flowed through this worker. ?url= is still accepted everywhere
   for backward compatibility.

   Security:
     Pages are only rendered for the SCP / Wikidot host family (NOT an
     open proxy). Assets may come from public hosts (fonts, embedded
         images) but never from private networks or ad domains.

   Deploy:
     Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste
     this whole file -> Deploy (from any device/network that can open
     dash.cloudflare.com). Then open scp-browser.html on the phone and
     paste the worker URL (https://name.account.workers.dev) once.
     Optional environment variables:
       DEFAULT_SITE  (default: scp-wiki.wikidot.com)
       EXTRA_HOSTS   (comma-separated extra hosts, subdomains included)
   ===================================================================== */

export default { fetch: handle };

const VERSION = '3.6.0';
const DEFAULT_SITE_DEFAULT = 'scp-wiki.wikidot.com';
const CROM_GRAPHQL = 'https://api.crom.avn.sh/graphql';

/* ------------------------------------------------------------------ */
/* Opaque request tokens                                               */
/* ------------------------------------------------------------------ */
/* Every upstream URL this worker embeds in a response (iframe srcs,
   css url()s, frame-shim fetches, the app's own api calls) is
   XOR-obfuscated + base64url'd as ?t=<token> so NO upstream hostname
   is ever readable in a request query string. Organization content
   filters commonly decode query params and category-block hosts like
   github.io (the SCP-6634 game) even though the request itself goes
   to this worker. The key is shared verbatim with bridge.js and
   browser.js (build.mjs asserts all three match). ?url= remains
   accepted on every endpoint for backward compatibility. */
const TOK_KEY = 'scpwtok-3-6-0-A7fQ9z';

function encTok(u) {
  const bytes = new TextEncoder().encode(String(u));
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ^ TOK_KEY.charCodeAt(i % TOK_KEY.length));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decTok(t) {
  try {
    const s = atob(String(t || '').replace(/-/g, '+').replace(/_/g, '/').trim());
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      bytes[i] = s.charCodeAt(i) ^ TOK_KEY.charCodeAt(i % TOK_KEY.length);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) { return null; }
}

/* Read the target url from either the opaque token (?t=) or the
   legacy plaintext param (?url=). Returns null when absent/invalid. */
function targetFromQuery(url) {
  const t = url.searchParams.get('t');
  if (t) {
    const dec = decTok(t);
    if (dec && /^https?:\/\//i.test(dec)) return dec;
    return null;
  }
  return url.searchParams.get('url');
}

/* Hosts whose PAGES may be rendered. Suffixes cover *.wikidot.com. */
const EXACT_HOSTS = [
  'scp-wiki.wikidot.com',
  'scpwiki.com',
  'www.scpwiki.com',
  'cdn.scpwiki.com',
  'interwiki.scpwiki.com',
  'www.wikidot.com',
  'wdfiles.com',
];
const HOST_SUFFIXES = ['.wikidot.com', '.wdfiles.com'];
const WIKIDOT_CDN_RE = /^d3g0gp89917ko\d\.cloudfront\.net$/; // wikidot's JS/CSS distros

/* Ad / tracking domains whose tags are removed from pages. */
const AD_DOMAINS = [
  'hadronid.net', 'facebook.com', 'facebook.net', 'doubleclick.net',
  'googlesyndication.com', 'googletagmanager.com', 'googletagservices.com',
  'google-analytics.com', 'nitropay.com', 'onesignal.com',
  'confiant-integrations.net', 'adnxs.com', 'ml314.com', 'id5-sync.com',
  'ad.gt', 'p7cloud.net', 'adsrvr.org', 'criteo.com', 'amazon-adsystem.com',
  'casalemedia.com', 'taboola.com', 'pubmatic.com', 'rubiconproject.com',
  'sharethrough.com', 'openx.net', '33across.com', 'bidswitch.net',
  'media.net', 'demdex.net', 'agkn.com', 'moatads.com', 'adsafeprotected.com',
  'triplelift.com', 'yieldmo.com', 'gumgum.com', 'smartadserver.com',
  'd3j8vl19c1131u.cloudfront.net',
  /* id-sync pixels seen in live fixture <img> tags */
  'tapad.com', 'turn.com', 'sonobi.com', '360yield.com', 'rqtrk.eu',
  'cpx.to', 'adsymptotic.com', 'lijit.com',
];
function isAdDomain(host) {
  host = String(host || '').toLowerCase();
  return AD_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}
const AD_MARKERS_RE = /(nitroAds|OneSignal|dataLayer|googletag|gtag\(|fbevents|aspan|confiant|prebid|adnxs|hadronid|nitropay|_pbjs|apstag|__tcfapi|doubleclick|adsbygoogle|adservice)/i;

const UPSTREAM_TIMEOUT = 25000;
const MAX_HTML = 6 * 1024 * 1024;
const MAX_ASSET = 30 * 1024 * 1024;
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 1x1 transparent GIF used as the placeholder for tokenized images. */
const PX_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function defaultSite(env) {
  const s = env && env.DEFAULT_SITE ? String(env.DEFAULT_SITE).trim().toLowerCase() : '';
  return s || DEFAULT_SITE_DEFAULT;
}

function hostAllowed(host, env) {
  host = String(host || '').toLowerCase().split(':')[0].replace(/\.$/, '');
  if (!host || host.startsWith('.')) return false;
  const extra = (env && env.EXTRA_HOSTS ? String(env.EXTRA_HOSTS) : '')
    .split(',').map(s => s.trim().toLowerCase().split(':')[0]).filter(Boolean);
  if (EXACT_HOSTS.includes(host) || extra.includes(host)) return true;
  if (HOST_SUFFIXES.some(s => host.endsWith(s))) return true;
  if (WIKIDOT_CDN_RE.test(host)) return true;
  if (extra.some(s => host === s || host.endsWith('.' + s))) return true;
  return false;
}

function isPrivateHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    return false;
  }
  if (h.endsWith('.internal') || h.endsWith('.local') || h === 'metadata.google.internal') return true;
  return false;
}

/* Asset URLs: any PUBLIC http(s) host that is not an ad domain.
   (Pages are restricted to the wiki family; assets like Google Fonts
   or embedded external images are allowed through.) */
function assetUrlOk(u, env) {
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
  const h = u.hostname.toLowerCase();
  if (isPrivateHost(h)) return false;
  if (isAdDomain(h)) return false;
  return true;
}

function decodeEnt(s) {
  return String(s).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (err) { return m; }
    }
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    return map[e.toLowerCase()] || m;
  });
}

function encodeEnt(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Attribute helpers that operate on a single tag string. */
function attrVal(tag, name) {
  const re = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = String(tag).match(re);
  if (!m) return null;
  return decodeEnt(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]));
}

function setAttr(tag, name, val) {
  const enc = encodeEnt(String(val));
  const re = new RegExp('\\s' + name + '\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s"\'>]+)', 'i');
  if (re.test(tag)) return tag.replace(re, ' ' + name + '="' + enc + '"');
  const tail = tag.match(/\s*\/?\s*>$/);
  if (!tail) return tag;
  const selfClose = /\/\s*>$/.test(tail[0]);
  return tag.slice(0, tag.length - tail[0].length) + ' ' + name + '="' + enc + '"' + (selfClose ? '/>' : '>');
}

function removeAttr(tag, name) {
  const re = new RegExp('\\s' + name + '\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s"\'>]+)', 'i');
  return tag.replace(re, '');
}

function absUrl(val, base) {
  const v = String(val == null ? '' : val).trim();
  if (!v) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch (e) { return null; }
}

/* File-ish links (wikidot attachments) open through /api/asset, not
   as pages. */
function isFileLink(absHref) {
  try {
    const u = new URL(absHref);
    const h = u.hostname.toLowerCase();
    if (h === 'wdfiles.com' || h.endsWith('.wdfiles.com')) return true;
    if (h === 'cdn.scpwiki.com') return true;
    if (WIKIDOT_CDN_RE.test(h)) return true;
    if (u.pathname.startsWith('/local--files/')) return true;
  } catch (e) {}
  return false;
}

function isAdTag(tagText, body) {
  const m = String(tagText).match(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || [];
  const url = m[1] !== undefined ? m[1] : m[2];
  if (url) {
    const host = (url.match(/^(?:https?:)?\/\/([^/"'\s?#]+)/i) || [])[1];
    if (host && isAdDomain(host)) return true;
  }
  return AD_MARKERS_RE.test(String(tagText) + ' ' + String(body || ''));
}

/* The wiki emits a "default theme failed to load" warning div that its own
   scripts remove once the theme is live; our scripts are stripped, so the
   banner would otherwise show on every page. Cut the whole (nested) div. */
function removeThemeBanner(html) {
  const MARK = '<div>The SCP Wiki\'s default theme failed to load';
  const i = html.indexOf(MARK);
  if (i === -1) return html;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = i;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0].charAt(1) === '/' ? -1 : 1;
    if (depth === 0) return html.slice(0, i) + html.slice(m.index + m[0].length);
  }
  return html;
}

function json(obj, status, extra) {
  const h = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-scp-proxy': VERSION,
  };
  if (extra) Object.assign(h, extra);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

function jsonErr(status, error, detail) {
  const body = { ok: false, error: String(error || 'error') };
  if (detail) body.detail = String(detail);
  return json(body, status);
}

async function fetchWithTimeout(url, init, ms) {
  return await Promise.race([
    fetch(new Request(url, init)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('upstream timeout')), ms || UPSTREAM_TIMEOUT)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Small-asset inlining + asset memory cache                           */
/* ------------------------------------------------------------------ */

/* CSS chrome (header bands, logos, icons, small fonts) used to arrive
   as tokens, fetched one-by-one through /api/asset only AFTER the page
   painted - a slow straggler held the whole batch (the "header has no
   color" + "images trickle in" effect). Now assets under the size cap
   are fetched server-side while the CSS is inlined and embedded as
   data: URIs directly in the stylesheet: they arrive with the render
   package itself, zero extra round trips. Anything bigger, slower, or
   over the per-render budget stays a token for the client to fetch. */
/* (css url() assets are no longer fetched or inlined here - they ship
   as direct /api/asset URLs and the browser lazy-loads them; see
   inlineCss. Only <img> tags still use client-side tokens.) */

const BLOB_MEM = new Map();       /* url -> {at, status, ct, etag, buf} full assets */
const BLOB_MEM_TTL = 10 * 60 * 1000;
const BLOB_MEM_MAX_BYTES = 24 * 1024 * 1024;
const BLOB_MEM_MAX_ITEMS = 72;
const BLOB_MEM_BYTES = 3 * 1024 * 1024;   /* per-asset cache cap */
const BUF_INFLIGHT = new Map();    /* url -> promise (dedupes warm-up vs client) */


const WARM_MAX = 15;                     /* images prefetched per render */


let blobMemTotal = 0;
function blobMemTrim() {
  while (BLOB_MEM.size > BLOB_MEM_MAX_ITEMS || blobMemTotal > BLOB_MEM_MAX_BYTES) {
    const k = BLOB_MEM.keys().next().value;
    if (k === undefined) break;
    const e = BLOB_MEM.get(k);
    BLOB_MEM.delete(k);
    blobMemTotal -= e.buf.byteLength;
  }
}

function originOf(u) {
  try { return new URL(u).origin + '/'; } catch (e) { return u; }
}

/* Buffered asset fetch shared by warm-up and /api/asset so a client
   request landing during a warm-up rides the SAME upstream fetch. */
function fetchAssetBuffered(upstream, init) {
  let p = BUF_INFLIGHT.get(upstream);
  if (!p) {
    p = fetchWithTimeout(upstream, init, UPSTREAM_TIMEOUT).then(async res => {
      return {
        status: res.status,
        ct: (res.headers.get('content-type') || '').toLowerCase(),
        etag: res.headers.get('etag') || '',
        lastMod: res.headers.get('last-modified') || '',
        cl: +(res.headers.get('content-length') || 0),
        buf: await res.arrayBuffer(),
      };
    });
    BUF_INFLIGHT.set(upstream, p);
    p.then(() => BUF_INFLIGHT.delete(upstream), () => BUF_INFLIGHT.delete(upstream));
  }
  return p;
}

/* Warm the image cache right after a render package is built: the
   client asks for these a few hundred ms later and hits memory instead
   of the (slow) wdfiles origin. Keeps well under the 50-subrequest
   budget per invocation. */
const WARM_FONT_MAX = 6;
function warmAssets(assets) {
  const urls = [];
  const fonts = [];
  for (const k in assets) {
    const u = assets[k];
    if (BLOB_MEM.has(u)) continue;
    const clean = String(u).split('#')[0];
    if (/\.(png|gif|jpe?g|webp|svg|ico|bmp)$/i.test(clean)) {
      if (urls.length >= WARM_MAX) continue;
      urls.push(u);
    } else if (/\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(clean) && fonts.length < WARM_FONT_MAX) {
      /* theme webfonts (sigma pulls the whole rsms Inter superfamily):
         the bridge fetches every font token right after paint - have
         them already in isolate memory so they land in one burst */
      fonts.push(u);
    }
  }
  urls.push(...fonts);
  let i = 0;
  return (async function next() {
    if (i >= urls.length) return;
    const batch = urls.slice(i, i + 4);
    i += 4;
    await Promise.all(batch.map(async u => {
      try {
        const e = await fetchAssetBuffered(u, {
          method: 'GET',
          headers: { 'accept': 'image/*,*/*;q=0.8', 'user-agent': UA_MOBILE, 'referer': originOf(u) },
          redirect: 'follow',
        });
        if (e.status === 200 && e.buf.byteLength && e.buf.byteLength <= BLOB_MEM_BYTES &&
            !/html/.test(e.ct)) {
          BLOB_MEM.set(u, { at: Date.now(), status: e.status, ct: e.ct, etag: e.etag, lastMod: e.lastMod, buf: e.buf });
          blobMemTotal += e.buf.byteLength;
          blobMemTrim();
        }
      } catch (err) { /* warm-up is best-effort */ }
    }));
    return next();
  })();
}

/* ------------------------------------------------------------------ */
/* CSS fetching + inlining                                             */
/* ------------------------------------------------------------------ */

const CSS_CACHE = new Map();       /* url -> {at, text} raw css */
const CSS_INFLIGHT = new Map();    /* url -> promise */
const CSS_TTL = 6 * 3600 * 1000;
const CSS_MAX = 300;

function cssCacheTrim() {
  if (CSS_CACHE.size <= CSS_MAX) return;
  const keys = Array.from(CSS_CACHE.keys());
  for (let i = 0; i < keys.length - CSS_MAX; i++) CSS_CACHE.delete(keys[i]);
}

async function fetchCssRaw(url) {
  const hit = CSS_CACHE.get(url);
  if (hit && Date.now() - hit.at < CSS_TTL) return hit.text;
  const inflight = CSS_INFLIGHT.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'accept': 'text/css,*/*;q=0.1', 'user-agent': UA_MOBILE, 'referer': new URL(url).origin + '/' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('css http ' + res.status);
    const ctype = res.headers.get('content-type') || '';
    if (/html/i.test(ctype)) throw new Error('css endpoint returned html');
    const text = await res.text();
    CSS_CACHE.set(url, { at: Date.now(), text });
    cssCacheTrim();
    return text;
  })();
  CSS_INFLIGHT.set(url, p);
  try { return await p; } finally { CSS_INFLIGHT.delete(url); }
}

/* Inline @import chains (server-side fetches) and point url()
   references at this worker's /api/asset endpoint.

   SUBREQUEST BUDGET: Cloudflare Workers allow 50 upstream fetches per
   request on the free plan. A single themed page can reference 300+
   css assets (font superfamilies like Inter or Sofia-Sans alone are
   100-180 files), so fetching or inlining them here is impossible -
   instead every url() becomes a DIRECT worker URL. The browser then
   loads exactly what it needs, lazily and natively: fonts are fetched
   only when a rule actually matches rendered text (font-family +
   weight + unicode-range), background images only when painted, and
   /api/asset answers with access-control-allow-origin:* so the
   sandboxed (null-origin) frame can load them all. Result: a full
   render needs ~10 upstream fetches (page + css @import texts),
   ~40 below the cap, and the client only ever downloads fonts it
   truly renders with. */
async function inlineCss(css, base, env, R, depth) {
  css = String(css);
  /* 1. collect + resolve @imports (recursive) */
  const imports = [];
  css = css.replace(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)|(?:"([^"]*)"|'([^']*)'))([^;]*);/gi,
    (m, g1, g2, g3, g4, g5) => {
      const raw = g1 !== undefined ? g1 : (g2 !== undefined ? g2 : (g3 !== undefined ? g3 : (g4 !== undefined ? g4 : g5)));
      const abs = raw != null ? absUrl(String(raw).trim(), base) : null;
      if (!abs || !assetUrlOk(new URL(abs), env) || depth >= 4) return '/* scpw: import skipped */';
      imports.push(abs);
      return '\x00I' + (imports.length - 1) + '\x00';
    });
  if (imports.length) {
    const texts = await Promise.all(imports.map(u =>
      fetchCssRaw(u).then(t => inlineCss(t, u, env, R, depth + 1)).catch(() => null)));
    for (let i = 0; i < imports.length; i++) {
      css = css.split('\x00I' + i + '\x00').join(texts[i] == null ? '' : texts[i]);
    }
  }
  /* 2. url() references -> direct /api/asset URLs (zero upstream
         fetches here; the browser lazy-loads what it actually uses).
         @import statements WITHOUT a trailing semicolon (wikidot theme
         blocks ship several) fall through to this pass as well and
         become native cross-origin @imports - fully supported. */
  css = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi, (m, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : (sq !== undefined ? sq : uq);
    if (raw == null || !raw) return m;
    const t = String(raw).trim();
    if (/^(data:|about:)/i.test(t)) return m;
    const abs = absUrl(t, base);
    if (!abs || !assetUrlOk(new URL(abs), env)) return 'url("about:blank")';
    return 'url("' + frameAsset(abs, R.origin) + '")';
  });
  return css;
}

/* ------------------------------------------------------------------ */
/* HTML render engine                                                  */
/* ------------------------------------------------------------------ */

const BRIDGE_SRC = "/* SCPW BRIDGE - injected into every rendered page by the worker.\n   Runs inside a sandboxed iframe (unique origin, scripts allowed).\n   Responsibilities:\n     - lazy-load <img> assets through the worker (/api/asset blobs);\n       css url() assets load natively via direct worker URLs\n     - report navigation clicks / form submits to the parent browser\n     - reimplement the wiki interactions that need JS (collapsibles,\n       tabviews, the sigma-9 side-bar menu, top-bar dropdowns,\n       footnote hover popups) because the page's own scripts are\n       stripped\n     - report scroll position + accept parent commands (scrollTo,\n       zoom, focus mode)\n     - the wiki's own search box is intentionally non-functional\n   The worker appends an init call:  SCPW_INIT({w, a, u})   */\n\n(function () {\n  'use strict';\n\n  var CFG = null;          /* {w: worker origin, a: {token: url}, u: page url} */\n  var CACHE = {};          /* token -> blob url ('' = failed) */\n  var parentWin = window.parent;\n\n  function send(msg) {\n    try { parentWin.postMessage(msg, '*'); } catch (e) {}\n  }\n\n  /* ---------------- asset pipeline (through the worker) ---------------- */\n\n  /* Opaque request tokens: the upstream URL is XOR-obfuscated +\n     base64url'd so no upstream hostname is readable in a request query\n     string (organization filters decode query params and may block\n     them by category even though the request itself goes to the worker).\n     Key matches worker.mjs / browser.js (build.mjs asserts it). */\n  var TOK_KEY = 'scpwtok-3-6-0-A7fQ9z';\n  function encTok(u) {\n    try {\n      var b = new TextEncoder().encode(String(u));\n      var s = '';\n      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ^ TOK_KEY.charCodeAt(i % TOK_KEY.length));\n      return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n    } catch (e) { return ''; }\n  }\n\n  function fetchAsset(url) {\n    return fetch(CFG.w + '/api/asset?t=' + encTok(url), {\n      credentials: 'omit',\n    }).then(function (r) {\n      if (!r.ok) throw new Error('asset http ' + r.status);\n      return r.blob();\n    }).then(function (b) {\n      return URL.createObjectURL(b);\n    });\n  }\n\n  function resolveToken(tok) {\n    var c = CACHE[tok];\n    if (c !== undefined) return (c && typeof c.then === 'function') ? c : Promise.resolve(c);\n    var url = CFG.a[tok];\n    if (!url) return Promise.resolve('');\n    var p = fetchAsset(url).then(function (u) {\n      CACHE[tok] = u;\n      return u;\n    }, function () {\n      CACHE[tok] = '';\n      return '';\n    });\n    CACHE[tok] = p;\n    return p;\n  }\n\n  /* Images: placeholder src is a 1px gif; data-scpw holds the token.\n     The blob is decoded BEFORE the swap so the intrinsic size is known:\n     width/height attributes (lowest CSS priority, so site styles still\n     win) are written in the SAME frame as src. The placeholder then\n     already occupies the final box and no layout shift happens when\n     the pixels land - this is what made the text jitter while pages\n     settled.\n     The written height ATTRIBUTE alone would distort any image whose\n     CSS constrains only the width (sigma-9's .scp-image-block img has\n     width:100% and no height) - so every image the bridge sizes is also\n     marked data-scpw-r, and init() adds :where(img[data-scpw-r]){height:auto}.\n     Zero specificity means any real site height rule still wins; the\n     attribute hint is overridden and the attrs' aspect-ratio keeps the\n     reserved box proportional. */\n  function swapImage(el) {\n    var tok = el.getAttribute('data-scpw');\n    if (!tok) return;\n    resolveToken(tok).then(function (u) {\n      el.removeAttribute('data-scpw');\n      if (!u) { el.classList.add('scpw-broken'); return; }\n      var probe = new Image();\n      probe.onload = function () {\n        if (probe.naturalWidth && probe.naturalHeight &&\n            !el.hasAttribute('width') && !el.hasAttribute('height')) {\n          el.setAttribute('width', probe.naturalWidth);\n          el.setAttribute('height', probe.naturalHeight);\n          el.setAttribute('data-scpw-r', '');\n        }\n        el.src = u;\n        el.classList.remove('scpw-broken');\n      };\n      probe.onerror = function () {\n        el.src = u;\n        el.classList.remove('scpw-broken');\n      };\n      probe.src = u;   /* blob is already fetched: decode is near-instant */\n    });\n  }\n\n  function activateImages() {\n    var imgs = document.querySelectorAll('img[data-scpw]');\n    var list = Array.prototype.slice.call(imgs);\n    if (!('IntersectionObserver' in window)) {\n      list.forEach(function (el) { swapImage(el); });\n      return;\n    }\n    /* generous margin: images arrive well before they scroll into\n       view, so late loads never visibly move the text; entries that\n       already intersect fire immediately at observe time */\n    var io = new IntersectionObserver(function (entries) {\n      entries.forEach(function (e) {\n        if (e.isIntersecting) { io.unobserve(e.target); swapImage(e.target); }\n      });\n    }, { rootMargin: '1500px 0px' });\n    list.forEach(function (el) { io.observe(el); });\n  }\n\n  /* CSS url() references (stylesheets, inline styles) no longer run\n     through tokens: the worker points them straight at its /api/asset\n     endpoint, so the browser natively lazy-loads exactly the fonts and\n     background images the page actually renders with - no bridge pass\n     needed. Only <img> tags still use the token + blob pipeline above. */\n\n  /* ---------------- interactions the wiki JS used to provide ----------- */\n\n  /* Sigma-9 side bar (the fixed ≡ button, top-left). The real site opens\n     it with a #side-bar fragment + CSS :target rules; inside a sandboxed\n     srcdoc frame fragment navigation never happens, so the bridge drives\n     the same open/close state with a class + equivalent CSS. */\n\n  function sbIsOpen() {\n    return document.documentElement.classList.contains('scpw-sb');\n  }\n\n  function sbOpen() {\n    if (sbIsOpen()) return;\n    document.documentElement.classList.add('scpw-sb');\n  }\n\n  function sbClose() {\n    document.documentElement.classList.remove('scpw-sb');\n  }\n\n  function scrollToAnchor(id) {\n    id = String(id).replace(/^#/, '');\n    if (!id) return;\n    var el = document.getElementById(id);\n    if (!el) {\n      var named = document.getElementsByName(id);\n      if (named && named.length) el = named[0];\n    }\n    if (el && el.scrollIntoView) el.scrollIntoView(true);\n  }\n\n  /* dropdown parents in the top bar: their \"javascript:;\" hrefs are\n     stripped by the worker, so the bridge toggles the submenu itself */\n  function toggleMenu(li) {\n    var parent = li.parentNode;\n    var willOpen = !li.classList.contains('scpw-open');\n    if (parent && parent.querySelectorAll) {\n      parent.querySelectorAll('li.scpw-open').forEach(function (o) {\n        if (o !== li) o.classList.remove('scpw-open');\n      });\n    }\n    li.classList.toggle('scpw-open', willOpen);\n  }\n\n  function tabviewInit() {\n    document.querySelectorAll('.yui-navset').forEach(function (set) {\n      var lis = set.querySelectorAll('.yui-nav li');\n      var panes = set.querySelectorAll('.yui-content > div');\n      var anyOn = false;\n      for (var i = 0; i < panes.length; i++) { if (panes[i].classList.contains('scpw-on')) anyOn = true; }\n      if (!anyOn) { selectTab(set, 0); }\n    });\n  }\n\n  function selectTab(set, idx) {\n    var lis = set.querySelectorAll('.yui-nav li');\n    var panes = set.querySelectorAll('.yui-content > div');\n    for (var i = 0; i < lis.length; i++) {\n      lis[i].classList.toggle('selected', i === idx);\n      lis[i].classList.toggle('scpw-on', i === idx);\n    }\n    for (var j = 0; j < panes.length; j++) {\n      panes[j].classList.toggle('scpw-on', j === idx);\n      panes[j].classList.toggle('selected', j === idx);\n    }\n  }\n\n  function init() {\n    /* focus-mode styles + tabview styles + broken-image styles */\n    var css = document.createElement('style');\n    css.textContent =\n      'html.scpw-focus #navi-bar,html.scpw-focus #navi-bar-shadow,' +\n      'html.scpw-focus #header,html.scpw-focus #top-bar,' +\n      'html.scpw-focus #side-bar,html.scpw-focus #search-top-box,' +\n      'html.scpw-focus #login-status,html.scpw-focus #footer,' +\n      'html.scpw-focus #page-info,html.scpw-focus .page-tags,' +\n      'html.scpw-focus #footer-bar-below,html.scpw-focus #footer-below' +\n      '{display:none!important}' +\n      'html.scpw-focus #container-wrap{margin-top:0!important}' +\n      'html.scpw-focus #content-wrap{margin:0!important}' +\n      'html.scpw-focus #main-content{margin:0!important}' +\n      '.yui-navset .yui-content>div{display:none}' +\n      '.yui-navset .yui-content>div.scpw-on{display:block}' +\n      '.scpw-broken{opacity:.15!important}' +\n      'a.scpw-file::after{content:\" \\\\2193\";font-size:.8em;opacity:.6}' +\n      /* wikidot hover tooltips (edit/flag/report hover text) are positioned\n         and toggled by the site's own JS, which never runs here - without\n         it they would sit visibly over the page like stray dialogs */\n      '#odialog-hovertips,.hovertip{display:none!important}' +\n      /* side-bar open state (class twin of sigma-9's #side-bar:target) */\n      'html.scpw-sb #side-bar{display:block!important;position:fixed!important;' +\n      'top:0!important;left:0!important;width:15rem!important;max-width:82vw;' +\n      'height:100%!important;overflow-y:auto!important;z-index:9990!important;margin:0!important}' +\n      'html.scpw-sb #side-bar .close-menu{display:block!important;position:fixed!important;' +\n      'top:0!important;left:0!important;width:100%!important;height:100%!important;' +\n      'background:rgba(0,0,0,.35);z-index:-1;margin:0!important;padding:0!important;border:0}' +\n      /* top-bar dropdowns on touch */\n      '#top-bar li.scpw-open>ul{display:block!important;position:relative!important;float:none!important}' +\n      '.mobile-top-bar li.scpw-open>ul{display:block!important;position:relative!important;float:none!important}' +\n      /* proportional boxes for bridge-measured images: overrides the\n         written height ATTRIBUTE (author css beats presentational hints)\n         while every real site rule still wins on specificity */\n      ':where(img[data-scpw-r]){height:auto}' +\n      /* footnote popup card (see showFootnotePop) */\n      '#scpw-fnpop{position:fixed;z-index:99999;background:#fffdf4;color:#222;' +\n      'border:1px solid #b8b6a4;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.4);' +\n      'max-width:340px;max-height:40vh;overflow-y:auto;padding:10px 13px 12px;' +\n      'font:13px/1.55 -apple-system,\"Segoe UI\",Roboto,sans-serif;text-align:left}' +\n      '#scpw-fnpop .fnpT{font-weight:700;font-size:10.5px;letter-spacing:1px;' +\n      'text-transform:uppercase;color:#8a8776;margin-bottom:5px}' +\n      '#scpw-fnpop .fnpB p{margin:0 0 .55em}' +\n      '#scpw-fnpop .fnpB p:last-child{margin-bottom:0}' +\n      '#scpw-fnpop .fnpB img{max-width:100%;height:auto}' +\n      '#scpw-fnpop .fnpGo{display:block;margin-top:7px;font-size:11.5px;color:#901c1c;' +\n      'font-weight:600;text-decoration:underline}';\n    (document.head || document.documentElement).appendChild(css);\n\n    tabviewInit();\n    activateImages();\n    sendReady();\n  }\n\n  /* ---------------- footnote popups ------------------------------------\n\n     Wikidot [[footnote]] blocks render as superscript references whose\n     tap handler (WIKIDOT...scrollToReference) the worker preserved as\n     data-scpw-scroll. On the live site tapping one opens a hover dialog\n     with the footnote text; the bridge reproduces that: tap a ref and a\n     small card pops up next to it (tap anywhere to dismiss, tap \"show\n     below\" to jump to the footnotes block). Back-links inside the\n     footnotes block keep the plain scroll-to-reference behavior. */\n\n  var fnPop = null;\n  var fnPopTarget = '';\n\n  function closeFootnotePop() {\n    if (!fnPop) return;\n    try { fnPop.parentNode.removeChild(fnPop); } catch (e) {}\n    fnPop = null;\n    fnPopTarget = '';\n  }\n\n  function footnoteBody(target) {\n    var el = document.getElementById(target);\n    if (!el) return null;\n    if (!/footnote-\\d+$/.test(target) && !/(^|\\s)footnote-footer(\\s|$)/.test(el.className || '')) return null;\n    return el;\n  }\n\n  function showFootnotePop(ref, target) {\n    closeFootnotePop();\n    var el = footnoteBody(target);\n    if (!el) return false;\n    var num = (target.match(/(\\d+)$/) || [])[1] || '';\n    var body = el.cloneNode(true);\n    /* drop the leading back-link anchor (its number is shown in the title) */\n    var first = body.querySelector('a');\n    if (first && first.parentNode === body) first.parentNode.removeChild(first);\n    var card = document.createElement('div');\n    card.id = 'scpw-fnpop';\n    card.innerHTML = '<div class=\"fnpT\">Footnote' + (num ? ' ' + num : '') + '</div>' +\n      '<div class=\"fnpB\"></div>' +\n      '<span class=\"fnpGo\">show in footnotes \\u2193</span>';\n    card.querySelector('.fnpB').innerHTML = body.innerHTML;\n    document.body.appendChild(card);\n    fnPop = card;\n    fnPopTarget = target;\n    /* place under the tapped ref (or above it when tight at the bottom),\n       ALWAYS clamped fully inside the viewport - position:fixed keeps\n       it on screen while the page scrolls under it */\n    var r = ref.getBoundingClientRect();\n    var vw = window.innerWidth, vh = window.innerHeight;\n    var cw = Math.min(340, vw - 20);\n    card.style.maxWidth = cw + 'px';\n    var left = Math.max(10, Math.min(r.left, vw - cw - 10));\n    var below = r.bottom + 8;\n    var ch = card.offsetHeight;\n    var top;\n    if (below + ch > vh - 10 && r.top - ch - 8 > 10) {\n      top = r.top - ch - 8;\n    } else {\n      top = below;\n    }\n    card.style.top = Math.max(10, Math.min(top, vh - ch - 10)) + 'px';\n    card.style.left = left + 'px';\n    return true;\n  }\n\n  function sendReady() {\n    var d = document.documentElement;\n    send({\n      scpw: 'ready',\n      title: document.title || '',\n      url: CFG.u,\n      scrollH: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),\n      y: window.scrollY || 0,\n    });\n  }\n\n  /* ---------------- click routing (capture phase) ---------------- */\n\n  document.addEventListener('click', function (e) {\n    if (e.defaultPrevented) return;\n    var t = e.target;\n    var closest = (t && t.closest) ? t.closest.bind(t) : null;\n    if (!closest) return;\n\n    /* an open footnote popup closes on ANY tap. This listener runs in\n       the CAPTURE phase, so the \"show in footnotes\" jump is handled\n       right here (a listener on the link itself would be cut off by\n       the capture-phase stopPropagation below) */\n    if (fnPop) {\n      var onPop = t.closest && t.closest('#scpw-fnpop');\n      var jump = onPop && t.closest && t.closest('.fnpGo');\n      var jumpTo = fnPopTarget;\n      closeFootnotePop();\n      if (jump) {\n        e.preventDefault(); e.stopPropagation();\n        scrollToAnchor(jumpTo);\n        return;\n      }\n      if (onPop) { e.preventDefault(); e.stopPropagation(); return; }\n    }\n\n    /* tabview tabs */\n    var tabLink = closest('.yui-nav a');\n    if (tabLink) {\n      var set = tabLink.closest('.yui-navset');\n      if (set) {\n        e.preventDefault(); e.stopPropagation();\n        var lis = set.querySelectorAll('.yui-nav li');\n        var li = tabLink.closest('li');\n        var idx = Array.prototype.indexOf.call(lis, li);\n        selectTab(set, idx < 0 ? 0 : idx);\n        return;\n      }\n    }\n\n    /* collapsible blocks (wikidot [[collapsible]] - \"+ Reveal ...\"\n       links). State lives in the inline display of the two halves:\n       folded visible + unfolded display:none means CLOSED; one tap swaps\n       them (the reveal link sits in .folded, the hide link inside\n       .unfolded-link). */\n    var clps = closest('.collapsible-block-link');\n    if (clps) {\n      var block = clps.closest('.collapsible-block');\n      if (block) {\n        e.preventDefault(); e.stopPropagation();\n        var folded = block.querySelector('.collapsible-block-folded');\n        var unfolded = block.querySelector('.collapsible-block-unfolded');\n        if (folded && unfolded) {\n          /* inline display '' = open (the reveal state we write back),\n             'none' = closed; real wikidot markup always ships the\n             inline display:none on the unfolded half */\n          var closed = unfolded.style.display === 'none';\n          folded.style.display = closed ? 'none' : '';\n          unfolded.style.display = closed ? '' : 'none';\n        }\n        return;\n      }\n    }\n\n    /* in-page scroll targets preserved by the worker from the page's tap\n       handlers - the superscript footnote references on thousands of\n       articles carry data-scpw-scroll. Footnote refs pop up their text\n       in a card (like the live site's hover dialog); everything else\n       (back-links, other scroll targets) just scrolls. */\n    var scrl = closest('[data-scpw-scroll]');\n    if (scrl) {\n      e.preventDefault(); e.stopPropagation();\n      var fnTarget = scrl.getAttribute('data-scpw-scroll');\n      if (showFootnotePop(scrl, fnTarget)) return;\n      scrollToAnchor(fnTarget);\n      return;\n    }\n\n    /* file downloads (worker-marked) */\n    var fileLink = closest('a[data-scpw-file]');\n    if (fileLink) {\n      e.preventDefault(); e.stopPropagation();\n      send({ scpw: 'file', href: fileLink.getAttribute('data-scpw-file') });\n      return;\n    }\n\n    /* form submit buttons: the frame sandbox blocks real form submission\n       (no allow-forms), so the bridge resolves the form itself. Must run\n       before the no-href/link branches below. */\n    var subBtn = null;\n    if ((t.tagName === 'INPUT' || t.tagName === 'BUTTON') && t.closest && t.closest('form')) {\n      var sTy = String(t.getAttribute('type') || (t.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();\n      if (sTy === 'submit' || sTy === 'image') subBtn = t;\n    }\n    if (subBtn) {\n      e.preventDefault(); e.stopPropagation();\n      handleForm(subBtn.closest('form'), subBtn);\n      return;\n    }\n\n    /* dropdown parents (wikidot \"javascript:;\" links - href stripped) */\n    var anyA = closest('a');\n    if (anyA && !anyA.getAttribute('href')) {\n      var li = anyA.closest('li');\n      if (li && li.querySelector('ul')) {\n        e.preventDefault(); e.stopPropagation();\n        toggleMenu(li);\n        return;\n      }\n    }\n\n    /* normal links */\n    var a = closest('a[href]');\n    if (!a) return;\n    var href = a.getAttribute('href') || '';\n    if (!href) return;\n    if (href.charAt(0) === '#') {\n      /* fragment links never navigate inside the sandbox: the sigma side\n         bar menu, its close scrim and in-page anchors are handled here */\n      e.preventDefault(); e.stopPropagation();\n      var frag = href.slice(1);\n      if (closest('.close-menu')) { sbClose(); return; }\n      if (frag === 'side-bar') { if (sbIsOpen()) sbClose(); else sbOpen(); return; }\n      if (!frag) { sbClose(); return; }\n      scrollToAnchor(frag);\n      return;\n    }\n    if (/^(javascript|mailto|tel|sms|about|data|blob):/i.test(href)) {\n      e.preventDefault();\n      if (/^mailto:|^tel:/i.test(href)) send({ scpw: 'ext', href: href, kind: 'contact' });\n      return;\n    }\n    e.preventDefault();\n    send({ scpw: 'nav', href: href });\n  }, true);\n\n  /* ---------------- forms (GET becomes navigation) ----------------\n\n     The sandboxed frame has no allow-forms, so real submit events never\n     fire: submit-button clicks and Enter-in-textfield are captured instead\n     and resolved here. The submit listener stays as a backstop. */\n\n  function handleForm(f, submitter) {\n    if (!f || !f.tagName || f.tagName.toUpperCase() !== 'FORM') return;\n    var method = (f.getAttribute('method') || 'get').toLowerCase();\n    var action = f.getAttribute('action') || CFG.u;\n    /* wikidot's search box carries a placeholder action (\"dummy\") that\n       its own scripts would rewrite at runtime. Search is intentionally\n       non-functional in this build: swallow the submit, do nothing. */\n    if (/\\/dummy\\/?$/.test(action) || f.id === 'search-top-box-form') {\n      return;\n    }\n    if (method !== 'get') {\n      send({ scpw: 'blocked', reason: 'post', href: action });\n      return;\n    }\n    try {\n      var qs = new URLSearchParams();\n      new FormData(f).forEach(function (v, k) {\n        if (typeof v === 'string') qs.append(k, v);\n      });\n      if (submitter && submitter.name) qs.append(submitter.name, submitter.value || '');\n      var q = qs.toString();\n      send({ scpw: 'nav', href: action + (q ? (action.indexOf('?') > -1 ? '&' : '?') + q : '') });\n    } catch (err) {\n      send({ scpw: 'blocked', reason: 'form', href: action });\n    }\n  }\n\n  /* Enter in a text field = implicit form submission */\n  document.addEventListener('keydown', function (e) {\n    if (e.key !== 'Enter' || e.defaultPrevented) return;\n    var t = e.target;\n    if (!t || !t.closest || t.tagName !== 'INPUT') return;\n    var ty = String(t.getAttribute('type') || 'text').toLowerCase();\n    if (!/^(text|search|email|url|number|tel|password)$/.test(ty)) return;\n    var form = t.closest('form');\n    if (!form) return;\n    e.preventDefault(); e.stopPropagation();\n    handleForm(form, null);\n  }, true);\n\n  document.addEventListener('submit', function (e) {\n    e.preventDefault(); e.stopPropagation();\n    handleForm(e.target, null);\n  }, true);\n\n  /* ---------------- scroll reporting ---------------- */\n\n  var lastSent = 0;\n  function reportScroll(force) {\n    var now = Date.now();\n    if (!force && now - lastSent < 250) return;\n    lastSent = now;\n    var d = document.documentElement;\n    send({\n      scpw: 'scroll',\n      y: Math.round(window.scrollY || document.body.scrollTop || 0),\n      h: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),\n    });\n  }\n  window.addEventListener('scroll', function () { reportScroll(false); }, { passive: true });\n\n  /* ---------------- nested content frames ----------------\n\n     The worker keeps real content iframes (the SCP-6634 game, the\n     interwiki language widget) in rendered pages and proxies them\n     through /api/frame with a shim that posts link taps to its parent -\n     this frame. Relay those to the app like ordinary link clicks. */\n  window.addEventListener('message', function (e) {\n    var d = e.data;\n    if (!d || d.scpw !== 'frame-nav') return;\n    if (typeof d.href === 'string' && d.href) send({ scpw: 'nav', href: d.href });\n  });\n\n  /* ---------------- parent commands ---------------- */\n\n  window.addEventListener('message', function (e) {\n    var d = e.data;\n    if (!d || d.scpw !== 'cmd') return;\n    if (d.op === 'scrollTo') {\n      window.scrollTo(0, d.y || 0);\n    } else if (d.op === 'anchor') {\n      var id = String(d.a || '').replace(/^#/, '');\n      if (id) {\n        var el = document.getElementById(id);\n        if (!el) {\n          var named = document.getElementsByName(id);\n          if (named && named.length) el = named[0];\n        }\n        if (el && el.scrollIntoView) el.scrollIntoView(true);\n        else window.scrollTo(0, 0);\n      }\n    } else if (d.op === 'zoom') {\n      /* Scale the ARTICLE COLUMN, not the whole document: Black\n         Highlighter-family themes size their chrome (the sticky mobile\n         top bar, the header band) with 100vw, and a body zoom leaves\n         those painting at zoom x 100vw - visibly cut off at the right\n         edge of the screen. #main-content is wikidot's article column\n         on every page; zooming it keeps the text-size control while\n         the site chrome renders exactly like the real site. */\n      var z = d.z || 1;\n      var mc = document.getElementById('main-content');\n      if (mc) {\n        document.body.style.zoom = '';\n        mc.style.zoom = z;\n      } else {\n        document.body.style.zoom = z;\n      }\n      var vp = document.querySelector('meta[name=viewport]');\n      if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1');\n    } else if (d.op === 'focus') {\n      document.documentElement.classList.toggle('scpw-focus', !!d.on);\n    } else if (d.op === 'ping') {\n      sendReady();\n    } else if (d.op === 'top') {\n      window.scrollTo(0, 0);\n    }\n  });\n\n  /* ---------------- boot ---------------- */\n\n  window.SCPW_INIT = function (cfg) {\n    CFG = cfg || {};\n    if (document.readyState === 'loading') {\n      document.addEventListener('DOMContentLoaded', function () { init(); });\n    } else {\n      init();\n    }\n  };\n})();\n";

/* ------------------------------------------------------------------ */
/* Content-iframe policy (used by /api/render)                        */
/* ------------------------------------------------------------------ */

/* Decide the fate of one <iframe attrs="..."> from a rendered page.
   Returns the replacement tag ('' = removed). Content iframes (the
   SCP-6634 game, interwiki widgets, video embeds) are rewritten to the
   worker's /api/frame proxy; hidden theme-machinery frames, ad/consent
   frames, srcdoc frames and invisible 0x0 trackers are dropped. */
function frameTag(attrs, R, env, workerOrigin) {
  const raw = '<iframe' + (attrs || '') + '>';
  if (attrVal(raw, 'data-scpw-frame') != null) return raw;   /* idempotent */

  if (attrVal(raw, 'srcdoc') != null) return '';
  const src = attrVal(raw, 'src');
  if (src == null || !String(src).trim()) return '';

  /* hidden interwiki styleFrames are wikidot's theme loader: the real
     site's JS fetches their ?theme=<css url> and injects it as a
     stylesheet. The frame itself dies, but the theme it would load is
     harvested here (priority keeps the cascade order) and inlined by
     rewriteDocument - this is how pages like scp-6000/6634/L093 get
     their redtape / basalt / classic themes. */
  const sfm = String(src).match(/styleFrame\.html/i);
  if (sfm) {
    try {
      const tm = String(src).match(/[?&]theme=([^&]+)/);
      if (tm) {
        const theme = decodeURIComponent(tm[1]);
        const pm = String(src).match(/[?&]priority=(-?\d+)/);
        (R.extraStyles = R.extraStyles || []).push({
          priority: pm ? +pm[1] : 0,
          href: theme,
        });
      }
    } catch (e) {}
    return '';
  }

  const style = attrVal(raw, 'style') || '';
  if (/display\s*:\s*none/i.test(style)) return '';          /* hidden */
  if (/(?:^|[;\s])(?:width|height)\s*:\s*0(?:px)?\s*(?:;|$)/i.test(style)) return '';
  const w = attrVal(raw, 'width'), h = attrVal(raw, 'height');
  if (w === '0' || h === '0' || w === '0px' || h === '0px') return '';

  if (isAdTag(raw)) return '';                               /* ad/consent hosts + markers */

  const abs = absUrl(src, R.base);
  if (!abs) return '';
  let u;
  try { u = new URL(abs); } catch (e) { return ''; }
  if (!assetUrlOk(u, env)) return '';                        /* private / ad hosts */
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';

  let out = ('<iframe' + (attrs || '')).replace(/\s*\/?\s*$/, '') + '>';
  /* drop event handlers, page sandbox and srcdoc fallback text */
  out = out.replace(/\s(?:on[a-z]+|sandbox|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = setAttr(out, 'src', workerOrigin + '/api/frame?t=' + encTok(abs));
  out = setAttr(out, 'data-scpw-frame', '');
  out = setAttr(out, 'loading', 'lazy');
  /* MUST be a closed empty element: an unclosed <iframe> would make the
     HTML parser treat everything after it as raw fallback text, killing
     the rest of the document (this exact bug ate whole articles) */
  return out + '</iframe>';
}

function makeRewriter(finalUrl) {
  const R = {
    base: finalUrl,
    noFragBase: String(finalUrl).split('#')[0],
    map: {},          /* token -> absolute asset url */
    n: 0,
    title: '',
    icon: '',
    token(abs) {
      for (const k in this.map) if (this.map[k] === abs) return k;
      const t = 'SCPW_A' + (this.n++);
      this.map[t] = abs;
      return t;
    },
  };
  return R;
}

/* The full document pipeline. Returns the rewritten HTML string. */
async function rewriteDocument(html, R, env, workerOrigin) {
  html = String(html);
  R.origin = workerOrigin;   /* css url() rewrites point at this worker */

  /* --- 1. remove ALL scripts (the page's JS never runs client-side) --- */
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/?>/gi, '');

  /* --- 2. frames: content iframes survive, machinery dies ---------

     Real embedded content (the SCP-6634 Godot game on
     ironshears.github.io, the interwiki.scpwiki.com language widget,
     video embeds) is KEPT and pointed at /api/frame, which proxies the
     frame document with its scripts intact. Hidden style-loader
     iframes, ad/consent frames, srcdoc frames and 0x0 tracker frames
     are still dropped - exactly what the page's own CSS/JS hides or
     removes on the live site. */
  html = html.replace(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe\s*>/gi,
    (m, attrs) => frameTag(attrs, R, env, workerOrigin));
  html = html.replace(/<iframe\b((?![^>]*data-scpw-frame)[^>]*?)\/?>/gi,
    (m, attrs) => frameTag(attrs, R, env, workerOrigin));
  html = html.replace(/<(object|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<\/?(object|embed|noscript|base|frame|frameset|applet|source|track|template)\b[^>]*\/?>/gi, '');

  /* --- 3. remove ad / tracker img + link tags + empty ad-holder divs --- */
  html = html.replace(/<img\b[^>]*\/?>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<link\b[^>]*\/?>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<div\b[^>]*\bid="(confiant_tag_holder|wad-\d+|atContainer|ad-container|ad-slot)"[^>]*>\s*<\/div>/gi, '');
  html = removeThemeBanner(html);

  /* --- 4. strip inline event handlers + srcset, but first rescue the
         ones that carry real behavior: footnote references call
         WIKIDOT.page.utils.scrollToReference('footnote-N') - with the
         onclick gone the superscript links would be dead. The target
         id survives as data-scpw-scroll and the bridge scrolls on tap. --- */
  html = html.replace(/\sonclick\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, all, dq, sq) => {
    const code = dq !== undefined ? dq : sq;
    const mm = String(code).match(/scrollToReference\(\s*['"]([^'"]+)['"]\s*\)/);
    if (mm) return ' data-scpw-scroll="' + encodeEnt(mm[1]) + '"';
    return '';
  });
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  /* --- 5. remove refresh / CSP metas --- */
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');

  /* --- 6. collect <style> blocks + stylesheet links; drop other links ---
         Placeholders use \x00 sentinels that never appear in real HTML
         and are fully replaced before the document is returned. */
  const styleJobs = [];   /* {attrs, css, media} for inline blocks */
  const linkJobs = [];    /* {href} for stylesheet links */
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (m, attrs, css) => {
    if (/\bncmp|onesignal\b/i.test(css)) return '';      /* dead consent-banner css */
    styleJobs.push({ attrs: attrs || '', css });
    return '\x00S' + (styleJobs.length - 1) + '\x00';
  });
  html = html.replace(/<link\b[^>]*\/?>/gi, (tag) => {
    const rel = attrVal(tag, 'rel') || '';
    if (/\bstylesheet\b/i.test(rel)) {
      const href = attrVal(tag, 'href');
      if (href) {
        linkJobs.push({ href, media: attrVal(tag, 'media') || '' });
        return '\x00L' + (linkJobs.length - 1) + '\x00';
      }
      return '';
    }
    if (!R.icon && /\bicon\b/i.test(rel) && !/apple-touch/i.test(rel)) {
      const href = attrVal(tag, 'href');
      const abs = href ? absUrl(href, R.base) : null;
      if (abs && assetUrlOk(new URL(abs), env)) R.icon = abs;
    }
    return ''; /* manifest, prefetch, alternate, icons... not needed */
  });

  /* --- 7. process all css (style blocks + fetched link stylesheets) --- */
  const processed = await Promise.all(styleJobs.map(j =>
    inlineCss(j.css, R.base, env, R, 0).catch(() => j.css)));
  const linkCss = await Promise.all(linkJobs.map(j => {
    const abs = absUrl(j.href, R.base);
    if (!abs || !assetUrlOk(new URL(abs), env)) return Promise.resolve(null);
    return fetchCssRaw(abs)
      .then(t => inlineCss(t, abs, env, R, 0))
      .catch(() => null);
  }));

  /* --- 7b. themes harvested from the styleFrame iframes (cascade order
         by their priority param) - spliced in before </head> at step 8b --- */
  let frameThemeCss = [];
  if (R.extraStyles && R.extraStyles.length) {
    R.extraStyles.sort((a, b) => a.priority - b.priority);
    frameThemeCss = await Promise.all(R.extraStyles.map(j => {
      const abs = absUrl(j.href, R.base);
      if (!abs || !assetUrlOk(new URL(abs), env)) return Promise.resolve(null);
      return fetchCssRaw(abs)
        .then(t => inlineCss(t, abs, env, R, 0))
        .catch(() => null);
    }));
  }

  /* --- 8. splice processed css back in, in document order --- */
  styleJobs.forEach((j, i) => {
    let tag = '<style' + (j.attrs || '') + '>';
    if (j.media) tag = '<style media="' + encodeEnt(j.media) + '">';
    html = html.split('\x00S' + i + '\x00').join(tag + processed[i] + '</style>');
  });
  linkJobs.forEach((j, i) => {
    const txt = linkCss[i];
    if (txt == null) {
      html = html.split('\x00L' + i + '\x00').join('');
      return;
    }
    const media = j.media ? ' media="' + encodeEnt(j.media) + '"' : '';
    html = html.split('\x00L' + i + '\x00').join('<style' + media + '>' + txt + '</style>');
  });

  /* --- 8b. spliced-in styleFrame themes (end of head = highest
         cascade priority, mirroring how late the real site injects them) --- */
  const frameThemeTags = frameThemeCss
    .filter(t => t != null && t.length)
    .map(t => '<style>' + t + '</style>')
    .join('');
  if (frameThemeTags) {
    if (/<\/head\s*>/i.test(html)) {
      html = html.replace(/<\/head\s*>/i, frameThemeTags + '</head>');
    } else if (/<body\b[^>]*>/i.test(html)) {
      html = html.replace(/<body\b[^>]*>/i, '<head>' + frameThemeTags + '</head><body>');
    } else {
      html = frameThemeTags + html;
    }
  }

  /* --- 9. images -> token placeholders + 1px gif --- */
  html = html.replace(/<img\b[^>]*\/?>/gi, (tag) => {
    if (isAdTag(tag)) return '';
    const src = attrVal(tag, 'src');
    let out = tag;
    if (src != null && !/^(data|blob):/i.test(src)) {
      const abs = absUrl(src, R.base);
      if (abs && assetUrlOk(new URL(abs), env)) {
        out = setAttr(out, 'src', PX_GIF);
        out = setAttr(out, 'data-scpw', R.token(abs));
      } else {
        out = setAttr(out, 'src', PX_GIF);
      }
    }
    out = setAttr(out, 'decoding', 'async');
    return out;
  });

  /* --- 10. links: absolutize / fragment / file / javascript --- */
  html = html.replace(/<a\b[^>]*\/?>/gi, (tag) => {
    let out = removeAttr(tag, 'target');
    const href = attrVal(out, 'href');
    if (href == null) return out;
    if (/^javascript:/i.test(href)) return removeAttr(out, 'href');
    if (/^(#|mailto:|tel:|sms:)/i.test(href)) return out;
    const abs = absUrl(href, R.base);
    if (!abs) return out;
    const noFrag = abs.split('#')[0];
    if (noFrag === R.noFragBase && abs.indexOf('#') > -1) {
      return setAttr(out, 'href', abs.slice(abs.indexOf('#')));
    }
    if (isFileLink(abs)) {
      out = removeAttr(out, 'href');
      out = setAttr(out, 'data-scpw-file', abs);
      out = setAttr(out, 'class', (attrVal(out, 'class') || '') + ' scpw-file');
      return out;
    }
    return setAttr(out, 'href', abs);
  });
  html = html.replace(/<area\b[^>]*\/?>/gi, (tag) => {
    const href = attrVal(tag, 'href');
    if (href == null) return tag;
    const abs = absUrl(href, R.base);
    return abs ? setAttr(tag, 'href', abs) : tag;
  });

  /* --- 11. forms: absolutize action --- */
  html = html.replace(/<form\b[^>]*\/?>/gi, (tag) => {
    const action = attrVal(tag, 'action');
    if (action == null) return tag;
    const abs = absUrl(action, R.base);
    return abs ? setAttr(tag, 'action', abs) : tag;
  });

  /* --- 12. inline style attributes: url() -> direct /api/asset URLs --- */
  html = html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, all, dq, sq) => {
    const css = dq !== undefined ? dq : sq;
    const out = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi, (mm, d2, s2, u2) => {
      const raw = d2 !== undefined ? d2 : (s2 !== undefined ? s2 : u2);
      if (raw == null || !raw || /^data:/i.test(raw)) return mm;
      const abs = absUrl(String(raw).trim(), R.base);
      if (!abs || !assetUrlOk(new URL(abs), env)) return mm;
      return 'url("' + frameAsset(abs, R.origin) + '")';
    });
    if (out === css) return m;
    const quote = dq !== undefined ? '"' : "'";
    return ' style=' + quote + encodeEnt(out) + quote;
  });

  /* --- 13. title --- */
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (tm) R.title = decodeEnt(tm[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  /* --- 14. viewport insurance --- */
  if (!/<meta\b[^>]*name\s*=\s*["']?viewport/i.test(html)) {
    html = html.replace(/<\/head\s*>/i, '<meta name="viewport" content="width=device-width, initial-scale=1"></head>');
  }

  /* --- 15. inject the bridge + its init (worker origin, asset map) --- */
  const cfg = JSON.stringify({ w: workerOrigin, a: R.map, u: R.base }).replace(/</g, '\\u003c');
  const inject = '<script>' + BRIDGE_SRC + '</scr' + 'ipt>' +
    '<script>SCPW_INIT(' + cfg + ')</scr' + 'ipt>';
  const idx = html.toLowerCase().lastIndexOf('</body');
  if (idx > -1) html = html.slice(0, idx) + inject + html.slice(idx);
  else html += inject;

  return html;
}

/* ------------------------------------------------------------------ */
/* /api/render                                                         */
/* ------------------------------------------------------------------ */

const PAGE_CACHE = new Map();      /* key -> {at, pkg} */
const PAGE_INFLIGHT = new Map();
const PAGE_TTL = 5 * 60 * 1000;
const PAGE_MAX = 25;

function pageCacheTrim() {
  if (PAGE_CACHE.size <= PAGE_MAX) return;
  const keys = Array.from(PAGE_CACHE.keys());
  for (let i = 0; i < keys.length - PAGE_MAX; i++) PAGE_CACHE.delete(keys[i]);
}

async function buildRender(targetUrl, env, workerOrigin) {
  const tu = new URL(targetUrl);
  const upstream = 'https://' + tu.hostname + tu.pathname + tu.search;

  /* Follow redirects ourselves so the final URL is exact (and external
     redirects are caught instead of silently followed). */
  let current = upstream;
  let res;
  for (let hop = 0; ; hop++) {
    if (hop >= 8) { const e = new Error('too many redirects'); e.status = 508; throw e; }
    res = await fetchWithTimeout(current, {
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en',
        'user-agent': UA_MOBILE,
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      let next;
      try { next = new URL(loc, current); } catch (e) { break; }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') break;
      if (!hostAllowed(next.hostname, env)) {
        const e = new Error('redirect leaves the scp network');
        e.status = 403;
        throw e;
      }
      current = next.protocol === 'https:' ? next.href : 'https://' + next.hostname + next.pathname + next.search;
      continue;
    }
    break;
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
    const err = new Error('not an html page');
    err.status = 415;
    throw err;
  }
  const cl = +(res.headers.get('content-length') || 0);
  if (cl && cl > MAX_HTML) {
    const err = new Error('page too large');
    err.status = 413;
    throw err;
  }
  const html = await res.text();
  if (html.length > MAX_HTML) {
    const err = new Error('page too large');
    err.status = 413;
    throw err;
  }

  const finalUrl = current;
  const R = makeRewriter(finalUrl);
  const out = await rewriteDocument(html, R, env, workerOrigin);

  return {
    ok: true,
    url: upstream,
    finalUrl: finalUrl,
    title: R.title,
    icon: R.icon,
    html: out,
    assets: R.map,
    status: res.status,
  };
}

async function apiRender(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'GET only' }, 405);
  }
  const targetRaw = targetFromQuery(url);
  if (!targetRaw) return json({ ok: false, error: 'missing url parameter' }, 400);
  let tu;
  try { tu = new URL(targetRaw); } catch (e) { return json({ ok: false, error: 'bad url' }, 400); }
  if (tu.protocol !== 'http:' && tu.protocol !== 'https:') {
    return json({ ok: false, error: 'only http/https pages can be rendered' }, 400);
  }
  if (!hostAllowed(tu.hostname, env)) {
    return json({ ok: false, error: 'page host not allowed', detail: tu.hostname }, 403);
  }

  const cacheKey = url.origin + '/api/render?url=' + encodeURIComponent(targetRaw.split('#')[0]);

  /* edge cache */
  if (request.method === 'GET' && typeof caches !== 'undefined') {
    try {
      const hit = await caches.default.match(new Request(cacheKey, { method: 'GET' }));
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-scp-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) {}
  }

  /* memory cache */
  const mem = PAGE_CACHE.get(cacheKey);
  if (mem && Date.now() - mem.at < PAGE_TTL) {
    return json(mem.pkg, 200, { 'cache-control': 'public, max-age=120', 'x-scp-cache': 'mem' });
  }

  /* in-flight dedupe */
  const inflight = PAGE_INFLIGHT.get(cacheKey);
  if (inflight) {
    try {
      return json(await inflight, 200, { 'cache-control': 'public, max-age=120' });
    } catch (e) {
      return json({ ok: false, error: (e && e.message) || 'upstream error' }, (e && e.status) || 502);
    }
  }

  const p = buildRender(tu.href, env, url.origin)
    .then(pkg => {
      PAGE_CACHE.set(cacheKey, { at: Date.now(), pkg });
      pageCacheTrim();
      return pkg;
    });
  PAGE_INFLIGHT.set(cacheKey, p);
  try {
    const pkg = await p;
    /* prefetch the page's images into the warm cache while the client
       is still parsing the render package (ctx.waitUntil, best-effort) */
    if (ctx && pkg.assets) {
      try { ctx.waitUntil(warmAssets(pkg.assets)); } catch (e) {}
    }
    const out = json(pkg, 200, { 'cache-control': 'public, max-age=120' });
    if (ctx && typeof caches !== 'undefined') {
      try { ctx.waitUntil(caches.default.put(new Request(cacheKey, { method: 'GET' }), out.clone())); } catch (e) {}
    }
    return out;
  } catch (e) {
    const status = (e && e.status) || 502;
    return json({ ok: false, error: (e && e.message) || 'upstream error' }, status);
  } finally {
    PAGE_INFLIGHT.delete(cacheKey);
  }
}

/* ------------------------------------------------------------------ */
/* /api/asset                                                          */
/* ------------------------------------------------------------------ */

async function apiAsset(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'GET only' }, 405);
  }
  const targetRaw = targetFromQuery(url);
  if (!targetRaw) return json({ ok: false, error: 'missing url parameter' }, 400);
  let tu;
  try { tu = new URL(targetRaw); } catch (e) { return json({ ok: false, error: 'bad url' }, 400); }
  if (tu.protocol !== 'http:' && tu.protocol !== 'https:') {
    return json({ ok: false, error: 'only http/https assets' }, 400);
  }
  if (!assetUrlOk(tu, env)) {
    return json({ ok: false, error: 'asset host not allowed', detail: tu.hostname }, 403);
  }

  const upstream = 'https://' + tu.hostname + tu.pathname + tu.search;
  const cacheKey = url.origin + '/api/asset?url=' + encodeURIComponent(targetRaw.split('#')[0]);

  if (request.method === 'GET' && typeof caches !== 'undefined') {
    try {
      const hit = await caches.default.match(new Request(cacheKey, { method: 'GET' }));
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-scp-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) {}
  }

  /* Warm memory cache: assets prefetched at render time (and small
     images/fonts served recently) answer from isolate memory - this is
     what makes "art takes forever" go away, because the slow wdfiles
     origin is only contacted once, server-side. */
  const mem = BLOB_MEM.get(upstream);
  if (request.method === 'GET' && mem && Date.now() - mem.at < BLOB_MEM_TTL) {
    return blobMemResponse(mem);
  }

  /* Range requests and unknown/huge sizes stream straight through. */
  const hasRange = request.headers.get('range');
  if (hasRange) return assetStream(request, env, ctx, tu, upstream, cacheKey);

  /* everything else buffers once (deduped against the render warm-up
     via BUF_INFLIGHT) and lands in memory when it is cache-sized */
  let entry;
  try {
    entry = await fetchAssetBuffered(upstream, {
      method: 'GET',
      headers: {
        'accept': 'image/*,font/*,text/css,*/*;q=0.8',
        'user-agent': UA_MOBILE,
        'referer': tu.origin + '/',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return json({ ok: false, error: 'asset unreachable', detail: String((e && e.message) || e) }, 502);
  }

  if (/text\/html|application\/xhtml/.test(entry.ct)) {
    return json({ ok: false, error: 'html not proxied', detail: 'assets only - pages come from /api/render' }, 415);
  }
  if (entry.buf.byteLength > MAX_ASSET) return json({ ok: false, error: 'asset too large' }, 413);

  /* CSS is not just bytes: a browser-imported stylesheet's own
     @import chains and url() references would be fetched DIRECTLY from
     upstream hosts (cdn.scpwiki.com, fonts.bunny.net, rsms.me...),
     leaking past the worker - exactly what organization filters block.
     Stylesheets are therefore served REWRITTEN: @import chains inlined
     server-side (each /api/asset request has its own 50-subrequest
     budget) and every url() pointed back at this worker as a token. */
  if (/text\/css/i.test(entry.ct) && entry.status === 200 && entry.buf.byteLength) {
    let text = new TextDecoder().decode(entry.buf);
    if (text && text.indexOf('/api/asset?t=') === -1) {   /* idempotence guard */
      try {
        const R = makeRewriter(upstream);
        R.origin = url.origin;
        text = await inlineCss(text, upstream, env, R, 0);
        const buf = new TextEncoder().encode(text);
        if (buf.byteLength <= MAX_ASSET) entry = Object.assign({}, entry, { buf });
      } catch (e) { /* serve the raw css on any rewrite failure */ }
    }
  }

  if (entry.status === 200 && entry.buf.byteLength &&
      entry.buf.byteLength <= BLOB_MEM_BYTES && /image\/|font\/|text\/css/.test(entry.ct)) {
    BLOB_MEM.set(upstream, { at: Date.now(), status: entry.status, ct: entry.ct, etag: entry.etag, lastMod: entry.lastMod, buf: entry.buf });
    blobMemTotal += entry.buf.byteLength;
    blobMemTrim();
  }

  return blobMemResponse(entry);
}

function blobMemResponse(e) {
  const h = new Headers();
  h.set('content-type', e.ct || 'application/octet-stream');
  if (e.etag) h.set('etag', e.etag);
  if (e.lastMod) h.set('last-modified', e.lastMod);
  h.set('access-control-allow-origin', '*');
  h.set('cache-control', 'public, max-age=' + (/image\/|font\//.test(e.ct) ? '2592000' : '86400'));
  h.set('x-scp-proxy', VERSION);
  h.set('x-scp-cache', 'mem');
  /* copy the buffer: one ArrayBuffer must not back two live bodies */
  return new Response(e.buf.slice(0), { status: e.status || 200, headers: h });
}

/* streaming path for huge / range assets */
async function assetStream(request, env, ctx, tu, upstream, cacheKey) {
  let res;
  try {
    res = await fetchWithTimeout(upstream, {
      method: request.method,
      headers: {
        'accept': 'image/*,font/*,text/css,*/*;q=0.8',
        'user-agent': UA_MOBILE,
        'referer': tu.origin + '/',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return json({ ok: false, error: 'asset unreachable', detail: String((e && e.message) || e) }, 502);
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('text/html') || ctype.includes('application/xhtml')) {
    return json({ ok: false, error: 'html not proxied', detail: 'assets only - pages come from /api/render' }, 415);
  }
  const cl = +(res.headers.get('content-length') || 0);
  if (cl && cl > MAX_ASSET) return json({ ok: false, error: 'asset too large' }, 413);

  const h = new Headers();
  const keep = ['content-type', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'content-disposition'];
  keep.forEach(k => { const v = res.headers.get(k); if (v != null) h.set(k, v); });
  if (!h.has('content-type')) h.set('content-type', 'application/octet-stream');
  h.set('access-control-allow-origin', '*');
  h.set('cache-control', 'public, max-age=' + (/image\/|font\//.test(ctype) ? '2592000' : '86400'));
  h.set('x-scp-proxy', VERSION);

  if (request.method === 'HEAD') return new Response(null, { status: res.status, headers: h });

  const out = new Response(res.body, { status: res.status, headers: h });
  if (res.status === 200 && ctx && typeof caches !== 'undefined' && /image\/|font\/|text\/css/.test(ctype)) {
    try {
      ctx.waitUntil(caches.default.put(new Request(cacheKey, { method: 'GET' }), out.clone()));
    } catch (e) {}
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* /api/frame - content-iframe proxy (games, interwiki, embeds)       */
/*                                                                    */
/* Rendered pages keep their REAL content iframes, but the sandboxed  */
/* app frame cannot navigate to them (and the phone must only talk    */
/* to the worker). /api/frame therefore serves the frame document     */
/* itself - scripts INTACT, unlike /api/render - with every static    */
/* subresource rewritten to /api/asset and an injected shim that      */
/* routes JS fetch/XHR (the Godot loader pulling Haven.wasm/.pck)     */
/* through the worker too. Wiki PAGE hosts are refused here: pages    */
/* only ever come from /api/render.                                   */
/* ------------------------------------------------------------------ */

const FRAME_MAX = 6 * 1024 * 1024;

function frameUrlOk(u, env) {
  if (!assetUrlOk(u, env)) return false;
  const h = u.hostname.toLowerCase();
  /* wikidot [[iframe]] blocks embed wiki-hosted FRAGMENT pages
     (/fragment:<name>/html/<hash>) - they are content, not pages, and
     refusing them broke every iframe embed on pages like scp-6500 */
  if (u.pathname.startsWith('/fragment:') && hostAllowed(h, env)) return true;
  /* widget + uploaded-file hosts of the wiki family */
  if (h === 'interwiki.scpwiki.com') return true;
  if (h === 'wdfiles.com' || h.endsWith('.wdfiles.com')) return true;
  if (WIKIDOT_CDN_RE.test(h)) return true;
  /* real wiki pages must come through /api/render */
  if (hostAllowed(h, env)) return false;
  /* any other public content host (ironshears.github.io & friends) */
  return true;
}

/* The injected shim (runs before the frame document's own scripts):
   - the real page url travels as an OPAQUE TOKEN (B) - no <base> tag
     with a plaintext upstream host stays in the document body
   - fetch/XHR with http(s) urls are re-pointed at /api/asset?t=<token>,
     resolved against the decoded page url so relative engine files like
     Haven.pck land on the worker, never on the phone's network
   - localStorage gets an in-memory twin (opaque sandbox origins throw
     on access, which would kill some game loaders at boot)
   - link taps are posted to the parent (the bridge relays them to the
     app as normal navigations - this is what makes the interwiki
     language widget actually navigate the browser) */
function frameShimSrc(workerOrigin, finalUrl) {
  const W = JSON.stringify(workerOrigin);
  const B = JSON.stringify(encTok(finalUrl || ''));
  const K = JSON.stringify(TOK_KEY);
  /* NOTE: this is a string-built script - every regex backslash that
     must SURVIVE into the shim source is written as a double backslash
     below (\\+ -> /\+/g in the shipped code). */
  return '(function(){' +
    'var W=' + W + ',B=' + B + ',K=' + K + ';' +
    'function dec(t){try{' +
      'var s=atob(t.replace(/-/g,"+").replace(/_/g,"/"));' +
      'var o="";' +
      'for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^K.charCodeAt(i%K.length));' +
      'return decodeURIComponent(escape(o));' +
    '}catch(e){return null;}}' +
    'function enc(u){try{' +
      'var b=new TextEncoder().encode(String(u));' +
      'var s="";' +
      'for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]^K.charCodeAt(i%K.length));' +
      'return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");' +
    '}catch(e){return null;}}' +
    'var BASE=dec(B)||("https://"+location.hostname);' +
    'function prox(u){try{' +
      'if(u==null)return u;' +
      'var s=String(u);' +
      'if(/^(data:|blob:|about:)/i.test(s))return s;' +
      'if(s.indexOf(W+"/api/")===0)return s;' +
      'var e2=enc(s);if(e2&&s.indexOf("http")===0)return W+"/api/asset?t="+e2;' +
      'var abs=new URL(s,BASE).href;' +
      'if(!/^https?:/i.test(abs))return s;' +
      'if(abs.indexOf(W+"/")===0||abs===W)return abs;' +
      'var e1=enc(abs);if(!e1)return abs;' +
      'return W+"/api/asset?t="+e1;' +
    '}catch(e){return u;}}' +
    'var of=window.fetch;' +
    'if(typeof of==="function"){window.fetch=function(input,init){' +
      'try{if(typeof input==="string")return of(prox(input),init);}catch(e){}' +
      'return of.apply(window,arguments);};}' +
    'var oo=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(method,url){' +
      'var rest=Array.prototype.slice.call(arguments,2);' +
      'var pu;try{pu=prox(url);}catch(e){pu=null;}' +
      'return oo.apply(this,[method,(pu==null||pu===undefined)?url:pu].concat(rest));};' +
    'try{window.localStorage.getItem("__scpw");}catch(e){try{' +
      'var mem={};' +
      'Object.defineProperty(window,"localStorage",{configurable:true,value:{' +
        'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null;},' +
        'setItem:function(k,v){mem[String(k)]=String(v);},' +
        'removeItem:function(k){delete mem[String(k)];},' +
        'clear:function(){mem={};},' +
        'key:function(i){var ks=Object.keys(mem);return i<ks.length?ks[i]:null;},' +
        'get length(){return Object.keys(mem).length;}}});}catch(e2){}}' +
    'document.addEventListener("click",function(e){' +
      'if(e.defaultPrevented||e.button)return;' +
      'var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;' +
      'if(!a)return;' +
      'var h=a.getAttribute("href")||"";' +
      'if(/^(javascript:|#|mailto:|tel:)/i.test(h)){e.preventDefault();return;}' +
      'var abs;try{abs=new URL(h,BASE).href;}catch(err){return;}' +
      'e.preventDefault();e.stopPropagation();' +
      'try{parent.postMessage({scpw:"frame-nav",href:abs},"*");}catch(err){}' +
    '},true);' +
    '})();';
}

function frameAsset(abs, workerOrigin) {
  /* normalize percent-escapes that carry no structural meaning: wikidot
     theme urls arrive as local--code/theme%3Abasalt/1, and re-encoding
     the already-encoded colon (%3A -> %253A) makes the upstream path
     unmatchable. Browsers decode these in paths, so we do too. */
  let clean = String(abs);
  try {
    const u = new URL(clean);
    const dec = decodeURIComponent(u.pathname);
    if (dec !== u.pathname && !/%2f/i.test(u.pathname)) {
      clean = u.origin + dec + u.search + (u.hash || '');
    }
  } catch (e) {}
  /* opaque token: the upstream host must not appear in the request */
  return workerOrigin + '/api/asset?t=' + encTok(clean);
}

/* Rewrite one tag attribute to its worker-proxied url (or drop it when
   the host is not fetchable). Shared by script/img/link/media tags. */
function proxifyAttr(tag, attr, finalUrl, workerOrigin, env) {
  const v = attrVal(tag, attr);
  if (v == null || !String(v).trim()) return tag;
  if (/^(data|blob|about):/i.test(v)) return tag;
  const abs = absUrl(v, finalUrl);
  if (!abs) return tag;
  let u;
  try { u = new URL(abs); } catch (e) { return tag; }
  if (!assetUrlOk(u, env)) return removeAttr(tag, attr);
  return setAttr(tag, attr, frameAsset(abs, workerOrigin));
}

function proxifyCssUrls(css, finalUrl, workerOrigin, env) {
  return String(css).replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi,
    (m, d2, s2, u2) => {
      const raw = d2 !== undefined ? d2 : (s2 !== undefined ? s2 : u2);
      if (raw == null || !raw || /^(data|blob|about):/i.test(raw)) return m;
      const abs = absUrl(String(raw).trim(), finalUrl);
      if (!abs) return m;
      try {
        if (!assetUrlOk(new URL(abs), env)) return m;
      } catch (e) { return m; }
      return 'url("' + frameAsset(abs, workerOrigin) + '")';
    });
}

function rewriteFrameDoc(html, finalUrl, workerOrigin, env) {
  let doc = String(html);

  /* CSP / refresh metas + any existing <base> (the shim carries the
     real page url as an opaque token instead - no plaintext upstream
     host is left anywhere in the document) */
  doc = doc.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');
  doc = doc.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  doc = doc.replace(/<base\b[^>]*\/?>/gi, '');

  const R = { base: finalUrl };

  /* scripts stay - the game IS its scripts */
  doc = doc.replace(/<script\b[^>]*>/gi, m => proxifyAttr(m, 'src', finalUrl, workerOrigin, env));
  doc = doc.replace(/<img\b[^>]*\/?>/gi, m => proxifyAttr(m, 'src', finalUrl, workerOrigin, env));
  doc = doc.replace(/<link\b[^>]*\/?>/gi, m => proxifyAttr(m, 'href', finalUrl, workerOrigin, env));
  doc = doc.replace(/<(?:video|audio|source|embed|track)\b[^>]*\/?>/gi, m => {
    let out = proxifyAttr(m, 'src', finalUrl, workerOrigin, env);
    out = proxifyAttr(out, 'poster', finalUrl, workerOrigin, env);
    return out;
  });
  doc = doc.replace(/<object\b[^>]*\/?>/gi, m => proxifyAttr(m, 'data', finalUrl, workerOrigin, env));
  /* nested iframes recurse through the frame proxy (same policy) */
  doc = doc.replace(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe\s*>/gi,
    (m, attrs) => frameTag(attrs, R, env, workerOrigin));
  doc = doc.replace(/<iframe\b((?![^>]*data-scpw-frame)[^>]*?)\/?>/gi,
    (m, attrs) => frameTag(attrs, R, env, workerOrigin));

  /* css url()s (style blocks + inline styles) */
  doc = doc.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (m, attrs, css) =>
    '<style' + attrs + '>' + proxifyCssUrls(css, finalUrl, workerOrigin, env) + '</style>');
  doc = doc.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, all, dq, sq) => {
    const css = dq !== undefined ? dq : sq;
    const out = proxifyCssUrls(css, finalUrl, workerOrigin, env);
    if (out === css) return m;
    return ' style=' + (dq !== undefined ? '"' : "'") + encodeEnt(out) + (dq !== undefined ? '"' : "'");
  });

  /* inject the shim (carries the page url as an opaque token) as the
     very first thing after <head> */
  const head = '<script>' + frameShimSrc(workerOrigin, finalUrl) + '</scr' + 'ipt>';
  if (/<head\b[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head\b[^>]*>/i, m => m + head);
  } else if (/<html\b[^>]*>/i.test(doc)) {
    doc = doc.replace(/<html\b[^>]*>/i, m => m + '<head>' + head + '</head>');
  } else {
    doc = '<!doctype html><html><head>' + head + '</head>' + doc;
  }

  return doc;
}

async function buildFrame(targetUrl, env, workerOrigin) {
  const tu = new URL(targetUrl);
  let current = 'https://' + tu.hostname + tu.pathname + tu.search;

  /* manual redirect tracking: the final URL is what relative engine
     files resolve against, so it must be exact */
  let res;
  for (let hop = 0; ; hop++) {
    if (hop >= 8) { const e = new Error('too many redirects'); e.status = 508; throw e; }
    res = await fetchWithTimeout(current, {
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en',
        'user-agent': UA_MOBILE,
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      let next;
      try { next = new URL(loc, current); } catch (e) { break; }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') break;
      if (!frameUrlOk(next, env)) {
        const e = new Error('redirect leaves allowed frame hosts');
        e.status = 403;
        throw e;
      }
      current = next.protocol === 'https:' ? next.href : 'https://' + next.hostname + next.pathname + next.search;
      continue;
    }
    break;
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
    const err = new Error('not an html frame document');
    err.status = 415;
    throw err;
  }
  const cl = +(res.headers.get('content-length') || 0);
  if (cl && cl > FRAME_MAX) { const e = new Error('frame document too large'); e.status = 413; throw e; }
  const html = await res.text();
  if (html.length > FRAME_MAX) { const e = new Error('frame document too large'); e.status = 413; throw e; }

  return rewriteFrameDoc(html, current, workerOrigin, env);
}

async function apiFrame(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'GET only' }, 405);
  }
  const targetRaw = targetFromQuery(url);
  if (!targetRaw) return json({ ok: false, error: 'missing url parameter' }, 400);
  let tu;
  try { tu = new URL(targetRaw); } catch (e) { return json({ ok: false, error: 'bad url' }, 400); }
  if (tu.protocol !== 'http:' && tu.protocol !== 'https:') {
    return json({ ok: false, error: 'only http/https frames' }, 400);
  }
  if (!frameUrlOk(tu, env)) {
    return json({ ok: false, error: 'frame host not allowed',
      detail: 'wiki pages come from /api/render; /api/frame is for embedded content only' }, 403);
  }

  const cacheKey = url.origin + '/api/frame?url=' + encodeURIComponent(targetRaw.split('#')[0]);

  if (request.method === 'GET' && typeof caches !== 'undefined') {
    try {
      const hit = await caches.default.match(new Request(cacheKey, { method: 'GET' }));
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-scp-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) {}
  }

  const out = (async () => {
    const doc = await buildFrame(tu.href, env, url.origin);
    return new Response(doc, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=600',
        'x-scp-proxy': VERSION,
      },
    });
  })();

  try {
    const res = await out;
    if (ctx && typeof caches !== 'undefined' && request.method === 'GET') {
      try { ctx.waitUntil(caches.default.put(new Request(cacheKey, { method: 'GET' }), res.clone())); } catch (e) {}
    }
    return res;
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'frame upstream error' }, (e && e.status) || 502);
  }
}


async function cromQueryOnce(query, variables) {
  const res = await Promise.race([
    fetch(CROM_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ query, variables: variables || {} }),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('crom timeout')), 12000)),
  ]);
  if (!res.ok) throw new Error('crom http ' + res.status);
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error('crom error: ' +
    (j.errors[0] && j.errors[0].message ? j.errors[0].message : 'graph error'));
  return j.data || {};
}

/* Crom occasionally answers 5xx or just stalls; one retry after a short
   backoff rescues transient failures so search rarely surfaces an error. */
async function cromQuery(query, variables) {
  try {
    return await cromQueryOnce(query, variables);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/timeout|http 5\d\d|network|failed to fetch/i.test(msg)) {
      await new Promise(r => setTimeout(r, 400));
      return await cromQueryOnce(query, variables);
    }
    throw e;
  }
}

/* Crom's anyBaseUrl filter has changed schema type over time (String vs
   [String!]). The query template carries the literal marker $base:BASE;
   it is tried in the current array form first and retried as a scalar
   when the schema rejects the type, so search/random survive either
   revision of the upstream API. */
async function cromFilterCall(queryBody, variables) {
  const base = variables && variables.base;
  try {
    return await cromQuery(
      queryBody.split('$base:BASE').join('$base:[String!]'),
      Object.assign({}, variables, { base: Array.isArray(base) ? base : [base] }));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/expecting type|of type .+ used in position/i.test(msg)) throw e;
    return await cromQuery(
      queryBody.split('$base:BASE').join('$base:String'),
      Object.assign({}, variables, { base: Array.isArray(base) ? base[0] : base }));
  }
}

function cromPathOf(u) {
  try { return new URL(String(u)).pathname || '/'; } catch (e) { return '/'; }
}

/* Optional per-request site: ?site=<host> lets the browser app pick a
   random page on the branch it is currently browsing. Must be an allowed
   page host; anything else falls back to the configured default site.
   (Search was removed entirely in v3.5 - the site's search button is
   intentionally non-functional.) */
function siteParam(request, env, url) {
  const raw = (url.searchParams.get('site') || '').toLowerCase().trim();
  if (raw && hostAllowed(raw, env) &&
      (HOST_SUFFIXES.some(s => raw.endsWith(s)) || EXACT_HOSTS.includes(raw))) {
    return raw;
  }
  return defaultSite(env);
}

async function apiRandom(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
  const site = (url && siteParam(request, env, url)) || defaultSite(env);
  try {
    const data = await cromFilterCall(
      'query($base:BASE){ randomPage(filter:{anyBaseUrl:$base}) { page { url wikidotInfo { title } } } }',
      { base: 'http://' + site });
    const page = data.randomPage && data.randomPage.page;
    if (!page || !page.url) throw new Error('no random page');
    return json({ ok: true, site: site, p: cromPathOf(page.url), t: (page.wikidotInfo && page.wikidotInfo.title) || '' });
  } catch (e) {
    return json({ ok: false, error: 'random unavailable', detail: String((e && e.message) || e) }, 502);
  }
}

/* ------------------------------------------------------------------ */
/* Main router                                                         */
/* ------------------------------------------------------------------ */
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, POST',
          'access-control-allow-headers': '*',
          'access-control-max-age': '86400',
        },
      });
    }

    /* / and /__worker/ping: JSON status. This worker serves no pages -
       opening its URL shows this status object, and that is by design. */
    if (url.pathname === '/' || url.pathname === '/__worker/ping') {
      const body = JSON.stringify({
        ok: true,
        proxy: 'scp-wiki-worker',
        version: VERSION,
        mode: 'api',
        site: defaultSite(env),
        api: true,
        endpoints: {
          render: '/api/render?t=<token> (or legacy ?url=<absolute-wiki-page-url>)',
          asset: '/api/asset?t=<token> (or legacy ?url=<absolute-asset-url>)',
          frame: '/api/frame?t=<token> (content iframes - games, interwiki)',
          random: '/api/random[?site=<wiki-host>]',
          ping: '/__worker/ping',
        },
        note: 'API-only worker - no pages are served here. The browser app is the separate single-file scp-browser.html; it renders real wiki pages fetched through /api/render.',
      });
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'x-scp-proxy': VERSION,
        },
      });
    }
    if (url.pathname.startsWith('/__worker/')) {
      return jsonErr(404, 'not found');
    }

    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } });
    }

    /* ---------------- JSON API (the browser app talks to these) --------
       The phone ONLY ever calls these worker endpoints; the worker does
       all upstream fetching. No wiki URL is ever contacted from the
       phone.                                                                    */
    if (url.pathname === '/api/render') return await apiRender(request, env, ctx, url);
    if (url.pathname === '/api/asset') return await apiAsset(request, env, ctx, url);
    if (url.pathname === '/api/frame') return await apiFrame(request, env, ctx, url);
    if (url.pathname === '/api/random') return await apiRandom(request, env, url);

    return jsonErr(404, 'unknown endpoint',
      'This worker is API-only. Try /api/render?url=, /api/asset?url=, /api/frame?url=, /api/random or /__worker/ping.');
  } catch (e) {
    return jsonErr(500, 'worker error', String((e && e.message) || e));
  }
}
