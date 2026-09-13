/* SCP WIKI WORKER - Cloudflare Worker: pure JSON render + asset API for
   the SCP Wiki. Deploy: dash.cloudflare.com -> Workers & Pages -> Create
   Worker -> paste this file -> Deploy (from any device that can open the
   dashboard). Opening the worker URL shows a small JSON status object -
   that is expected: this worker serves NO pages. The browser app is the
   separate single-file scp-browser.html, which paints the real wiki
   inside a sandboxed iframe using /api/render packages from this worker
   (/api/asset for images and fonts, /api/search + /api/random via Crom).
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
     /api/render?url=<page>    ->  JSON render package:
         { ok, url, finalUrl, title, icon, html, assets }
         - the REAL page HTML, fetched upstream (redirects followed)
         - ads / trackers / ALL scripts / iframes removed
         - stylesheets fetched + @import chains INLINED server-side
         - images, fonts, css url() assets replaced with tokens
           (the app loads them lazily through /api/asset)
         - links absolutized so in-app navigation just works
         - a tiny "bridge" script injected for clicks/scroll
     /api/asset?url=<file>     ->  raw asset proxy (images, fonts,
         files) with CORS. HTML content is refused (415) - the worker
         never mirrors pages.
     /api/search?q=<query>     ->  JSON search results (Crom GraphQL)
     /api/random               ->  JSON random page (Crom GraphQL)
     (both accept &site=<wiki-host> to target the branch you browse)
     anything else             ->  JSON 404 with the endpoint list

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

const VERSION = '3.1.0';
const DEFAULT_SITE_DEFAULT = 'scp-wiki.wikidot.com';
const CROM_GRAPHQL = 'https://api.crom.avn.sh/graphql';

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

/* Inline @import chains (server-side fetches) and tokenize url()
   references. R supplies the per-render token registry. */
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
  /* 2. tokenize url() references (tokens from recursive imports are
         already resolved - leave them alone). Tokens ship as data: URLs so
         the browser never tries to fetch them before the bridge swaps in
         the real (worker-fetched) blob URLs. */
  css = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi, (m, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : (sq !== undefined ? sq : uq);
    if (raw == null || !raw) return m;
    const t = String(raw).trim();
    if (/^(data:|about:)/i.test(t)) return m;
    if (/^SCPW_A\d+$/.test(t)) return m;           /* already a token */
    const abs = absUrl(t, base);
    if (!abs || !assetUrlOk(new URL(abs), env)) return 'url("about:blank")';
    return 'url("data:,' + R.token(abs) + '")';
  });
  return css;
}

/* ------------------------------------------------------------------ */
/* HTML render engine                                                  */
/* ------------------------------------------------------------------ */

const BRIDGE_SRC = "/* SCPW BRIDGE - injected into every rendered page by the worker.\n   Runs inside a sandboxed iframe (unique origin, scripts allowed).\n   Responsibilities:\n     - lazy-load images + CSS assets through the worker (/api/asset)\n     - report navigation clicks / form submits to the parent browser\n     - reimplement the wiki interactions that need JS (collapsibles,\n       tabviews, the sigma-9 side-bar menu, top-bar dropdowns) because\n       the page's own scripts are stripped\n     - report scroll position + accept parent commands (scrollTo,\n       zoom, focus mode)\n   The worker appends an init call:  SCPW_INIT({w, a, u})   */\n\n(function () {\n  'use strict';\n\n  var CFG = null;          /* {w: worker origin, a: {token: url}, u: page url} */\n  var CACHE = {};          /* token -> blob url ('' = failed) */\n  var parentWin = window.parent;\n\n  function send(msg) {\n    try { parentWin.postMessage(msg, '*'); } catch (e) {}\n  }\n\n  /* ---------------- asset pipeline (through the worker) ---------------- */\n\n  function fetchAsset(url) {\n    return fetch(CFG.w + '/api/asset?url=' + encodeURIComponent(url), {\n      credentials: 'omit',\n    }).then(function (r) {\n      if (!r.ok) throw new Error('asset http ' + r.status);\n      return r.blob();\n    }).then(function (b) {\n      return URL.createObjectURL(b);\n    });\n  }\n\n  function resolveToken(tok) {\n    var c = CACHE[tok];\n    if (c !== undefined) return (c && typeof c.then === 'function') ? c : Promise.resolve(c);\n    var url = CFG.a[tok];\n    if (!url) return Promise.resolve('');\n    var p = fetchAsset(url).then(function (u) {\n      CACHE[tok] = u;\n      return u;\n    }, function () {\n      CACHE[tok] = '';\n      return '';\n    });\n    CACHE[tok] = p;\n    return p;\n  }\n\n  var TOKRE = /url\\(\"data:,(SCPW_A\\d+)\"\\)/g;\n\n  /* Images: placeholder src is a 1px gif; data-scpw holds the token. */\n  function swapImage(el) {\n    var tok = el.getAttribute('data-scpw');\n    if (!tok) return;\n    resolveToken(tok).then(function (u) {\n      if (u) {\n        el.src = u;\n        el.classList.remove('scpw-broken');\n      } else {\n        el.classList.add('scpw-broken');\n      }\n      el.removeAttribute('data-scpw');\n    });\n  }\n\n  function activateImages() {\n    var imgs = document.querySelectorAll('img[data-scpw]');\n    var list = Array.prototype.slice.call(imgs);\n    var i = 0;\n    var io = null;\n    if ('IntersectionObserver' in window) {\n      io = new IntersectionObserver(function (entries) {\n        entries.forEach(function (e) {\n          if (e.isIntersecting) { io.unobserve(e.target); swapImage(e.target); }\n        });\n      }, { rootMargin: '600px 0px' });\n    }\n    list.forEach(function (el) {\n      if (!io || i < 3) swapImage(el);           /* first few eager */\n      else io.observe(el);\n      i++;\n    });\n  }\n\n  /* CSS: url() references arrive as non-fetching data: placeholders that\n     carry the token:  url(\"data:,SCPW_A7\"). Both <style> elements and\n     inline style=\"\" attributes are patched with the real (worker-fetched)\n     blob URLs. */\n\n  function patchStyles() {\n    var styles = Array.prototype.slice.call(document.querySelectorAll('style'));\n    var styled = Array.prototype.slice.call(document.querySelectorAll('[style]'));\n    var needed = {};\n    function collect(txt) {\n      var found = String(txt).match(TOKRE);\n      if (found) found.forEach(function (f) { needed[f] = 1; });\n    }\n    styles.forEach(function (s) { collect(s.textContent); });\n    styled.forEach(function (el) { collect(el.getAttribute('style') || ''); });\n    var toks = Object.keys(needed);\n    var active = 0, queue = toks.slice();\n    function next() {\n      while (active < 4 && queue.length) {\n        var pat = queue.shift();\n        active++;\n        resolveToken(pat.match(/SCPW_A\\d+/)[0]).then(function (u) {\n          active--;\n          apply(pat, u);\n          next();\n        });\n      }\n    }\n    function apply(pattern, url) {\n      if (!url) url = 'about:blank';\n      var rep = 'url(\"' + url + '\")';\n      styles.forEach(function (s) {\n        var txt = String(s.textContent);\n        if (txt.indexOf(pattern) === -1) return;\n        try { s.textContent = txt.split(pattern).join(rep); } catch (e) {}\n      });\n      styled.forEach(function (el) {\n        var at = el.getAttribute('style');\n        if (!at || at.indexOf(pattern) === -1) return;\n        try { el.setAttribute('style', at.split(pattern).join(rep)); } catch (e) {}\n      });\n    }\n    next();\n  }\n\n  /* ---------------- interactions the wiki JS used to provide ----------- */\n\n  /* Sigma-9 side bar (the fixed ≡ button, top-left). The real site opens\n     it with a #side-bar fragment + CSS :target rules; inside a sandboxed\n     srcdoc frame fragment navigation never happens, so the bridge drives\n     the same open/close state with a class + equivalent CSS. */\n\n  function sbIsOpen() {\n    return document.documentElement.classList.contains('scpw-sb');\n  }\n\n  function sbOpen() {\n    if (sbIsOpen()) return;\n    document.documentElement.classList.add('scpw-sb');\n  }\n\n  function sbClose() {\n    document.documentElement.classList.remove('scpw-sb');\n  }\n\n  function scrollToAnchor(id) {\n    id = String(id).replace(/^#/, '');\n    if (!id) return;\n    var el = document.getElementById(id);\n    if (!el) {\n      var named = document.getElementsByName(id);\n      if (named && named.length) el = named[0];\n    }\n    if (el && el.scrollIntoView) el.scrollIntoView(true);\n  }\n\n  /* dropdown parents in the top bar: their \"javascript:;\" hrefs are\n     stripped by the worker, so the bridge toggles the submenu itself */\n  function toggleMenu(li) {\n    var parent = li.parentNode;\n    var willOpen = !li.classList.contains('scpw-open');\n    if (parent && parent.querySelectorAll) {\n      parent.querySelectorAll('li.scpw-open').forEach(function (o) {\n        if (o !== li) o.classList.remove('scpw-open');\n      });\n    }\n    li.classList.toggle('scpw-open', willOpen);\n  }\n\n  function tabviewInit() {\n    document.querySelectorAll('.yui-navset').forEach(function (set) {\n      var lis = set.querySelectorAll('.yui-nav li');\n      var panes = set.querySelectorAll('.yui-content > div');\n      var anyOn = false;\n      for (var i = 0; i < panes.length; i++) { if (panes[i].classList.contains('scpw-on')) anyOn = true; }\n      if (!anyOn) { selectTab(set, 0); }\n    });\n  }\n\n  function selectTab(set, idx) {\n    var lis = set.querySelectorAll('.yui-nav li');\n    var panes = set.querySelectorAll('.yui-content > div');\n    for (var i = 0; i < lis.length; i++) {\n      lis[i].classList.toggle('selected', i === idx);\n      lis[i].classList.toggle('scpw-on', i === idx);\n    }\n    for (var j = 0; j < panes.length; j++) {\n      panes[j].classList.toggle('scpw-on', j === idx);\n      panes[j].classList.toggle('selected', j === idx);\n    }\n  }\n\n  function init() {\n    /* focus-mode styles + tabview styles + broken-image styles */\n    var css = document.createElement('style');\n    css.textContent =\n      'html.scpw-focus #navi-bar,html.scpw-focus #navi-bar-shadow,' +\n      'html.scpw-focus #header,html.scpw-focus #top-bar,' +\n      'html.scpw-focus #side-bar,html.scpw-focus #search-top-box,' +\n      'html.scpw-focus #login-status,html.scpw-focus #footer,' +\n      'html.scpw-focus #page-info,html.scpw-focus .page-tags,' +\n      'html.scpw-focus #footer-bar-below,html.scpw-focus #footer-below' +\n      '{display:none!important}' +\n      'html.scpw-focus #container-wrap{margin-top:0!important}' +\n      'html.scpw-focus #content-wrap{margin:0!important}' +\n      'html.scpw-focus #main-content{margin:0!important}' +\n      '.yui-navset .yui-content>div{display:none}' +\n      '.yui-navset .yui-content>div.scpw-on{display:block}' +\n      '.scpw-broken{opacity:.15!important}' +\n      'a.scpw-file::after{content:\" \\\\2193\";font-size:.8em;opacity:.6}' +\n      /* side-bar open state (class twin of sigma-9's #side-bar:target) */\n      'html.scpw-sb #side-bar{display:block!important;position:fixed!important;' +\n      'top:0!important;left:0!important;width:15rem!important;max-width:82vw;' +\n      'height:100%!important;overflow-y:auto!important;z-index:9990!important;margin:0!important}' +\n      'html.scpw-sb #side-bar .close-menu{display:block!important;position:fixed!important;' +\n      'top:0!important;left:0!important;width:100%!important;height:100%!important;' +\n      'background:rgba(0,0,0,.35);z-index:-1;margin:0!important;padding:0!important;border:0}' +\n      /* top-bar dropdowns on touch */\n      '#top-bar li.scpw-open>ul{display:block!important;position:relative!important;float:none!important}' +\n      '.mobile-top-bar li.scpw-open>ul{display:block!important;position:relative!important;float:none!important}';\n    (document.head || document.documentElement).appendChild(css);\n\n    tabviewInit();\n    activateImages();\n    patchStyles();\n    sendReady();\n  }\n\n  function sendReady() {\n    var d = document.documentElement;\n    send({\n      scpw: 'ready',\n      title: document.title || '',\n      url: CFG.u,\n      scrollH: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),\n      y: window.scrollY || 0,\n    });\n  }\n\n  /* ---------------- click routing (capture phase) ---------------- */\n\n  document.addEventListener('click', function (e) {\n    if (e.defaultPrevented) return;\n    var t = e.target;\n    var closest = (t && t.closest) ? t.closest.bind(t) : null;\n    if (!closest) return;\n\n    /* tabview tabs */\n    var tabLink = closest('.yui-nav a');\n    if (tabLink) {\n      var set = tabLink.closest('.yui-navset');\n      if (set) {\n        e.preventDefault(); e.stopPropagation();\n        var lis = set.querySelectorAll('.yui-nav li');\n        var li = tabLink.closest('li');\n        var idx = Array.prototype.indexOf.call(lis, li);\n        selectTab(set, idx < 0 ? 0 : idx);\n        return;\n      }\n    }\n\n    /* collapsible blocks */\n    var clps = closest('.collapsible-block-link');\n    if (clps) {\n      var block = clps.closest('.collapsible-block');\n      if (block) {\n        e.preventDefault(); e.stopPropagation();\n        var folded = block.querySelector('.collapsible-block-folded');\n        var unfolded = block.querySelector('.collapsible-block-unfolded');\n        if (folded && unfolded) {\n          var showFolded = unfolded.style.display === 'none' || !unfolded.style.display;\n          folded.style.display = showFolded ? '' : 'none';\n          unfolded.style.display = showFolded ? 'none' : '';\n        }\n        return;\n      }\n    }\n\n    /* file downloads (worker-marked) */\n    var fileLink = closest('a[data-scpw-file]');\n    if (fileLink) {\n      e.preventDefault(); e.stopPropagation();\n      send({ scpw: 'file', href: fileLink.getAttribute('data-scpw-file') });\n      return;\n    }\n\n    /* form submit buttons: the frame sandbox blocks real form submission\n       (no allow-forms), so the bridge resolves the form itself. Must run\n       before the no-href/link branches below. */\n    var subBtn = null;\n    if ((t.tagName === 'INPUT' || t.tagName === 'BUTTON') && t.closest && t.closest('form')) {\n      var sTy = String(t.getAttribute('type') || (t.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();\n      if (sTy === 'submit' || sTy === 'image') subBtn = t;\n    }\n    if (subBtn) {\n      e.preventDefault(); e.stopPropagation();\n      handleForm(subBtn.closest('form'), subBtn);\n      return;\n    }\n\n    /* dropdown parents (wikidot \"javascript:;\" links - href stripped) */\n    var anyA = closest('a');\n    if (anyA && !anyA.getAttribute('href')) {\n      var li = anyA.closest('li');\n      if (li && li.querySelector('ul')) {\n        e.preventDefault(); e.stopPropagation();\n        toggleMenu(li);\n        return;\n      }\n    }\n\n    /* normal links */\n    var a = closest('a[href]');\n    if (!a) return;\n    var href = a.getAttribute('href') || '';\n    if (!href) return;\n    if (href.charAt(0) === '#') {\n      /* fragment links never navigate inside the sandbox: the sigma side\n         bar menu, its close scrim and in-page anchors are handled here */\n      e.preventDefault(); e.stopPropagation();\n      var frag = href.slice(1);\n      if (closest('.close-menu')) { sbClose(); return; }\n      if (frag === 'side-bar') { if (sbIsOpen()) sbClose(); else sbOpen(); return; }\n      if (!frag) { sbClose(); return; }\n      scrollToAnchor(frag);\n      return;\n    }\n    if (/^(javascript|mailto|tel|sms|about|data|blob):/i.test(href)) {\n      e.preventDefault();\n      if (/^mailto:|^tel:/i.test(href)) send({ scpw: 'ext', href: href, kind: 'contact' });\n      return;\n    }\n    e.preventDefault();\n    send({ scpw: 'nav', href: href });\n  }, true);\n\n  /* ---------------- forms (GET becomes navigation) ----------------\n\n     The sandboxed frame has no allow-forms, so real submit events never\n     fire: submit-button clicks and Enter-in-textfield are captured instead\n     and resolved here. The submit listener stays as a backstop. */\n\n  function handleForm(f, submitter) {\n    if (!f || !f.tagName || f.tagName.toUpperCase() !== 'FORM') return;\n    var method = (f.getAttribute('method') || 'get').toLowerCase();\n    var action = f.getAttribute('action') || CFG.u;\n    /* wikidot's search box carries a placeholder action (\"dummy\") that its\n       own scripts would rewrite at runtime; route it to the app's search */\n    if (/\\/dummy\\/?$/.test(action) || f.id === 'search-top-box-form') {\n      var sq = '';\n      try {\n        new FormData(f).forEach(function (v, k) {\n          if (k === 'query' && typeof v === 'string' && String(v).trim()) sq = String(v).trim();\n        });\n      } catch (err) {}\n      if (sq) send({ scpw: 'search', q: sq });\n      return;\n    }\n    if (method !== 'get') {\n      send({ scpw: 'blocked', reason: 'post', href: action });\n      return;\n    }\n    try {\n      var qs = new URLSearchParams();\n      new FormData(f).forEach(function (v, k) {\n        if (typeof v === 'string') qs.append(k, v);\n      });\n      if (submitter && submitter.name) qs.append(submitter.name, submitter.value || '');\n      var q = qs.toString();\n      send({ scpw: 'nav', href: action + (q ? (action.indexOf('?') > -1 ? '&' : '?') + q : '') });\n    } catch (err) {\n      send({ scpw: 'blocked', reason: 'form', href: action });\n    }\n  }\n\n  /* Enter in a text field = implicit form submission */\n  document.addEventListener('keydown', function (e) {\n    if (e.key !== 'Enter' || e.defaultPrevented) return;\n    var t = e.target;\n    if (!t || !t.closest || t.tagName !== 'INPUT') return;\n    var ty = String(t.getAttribute('type') || 'text').toLowerCase();\n    if (!/^(text|search|email|url|number|tel|password)$/.test(ty)) return;\n    var form = t.closest('form');\n    if (!form) return;\n    e.preventDefault(); e.stopPropagation();\n    handleForm(form, null);\n  }, true);\n\n  document.addEventListener('submit', function (e) {\n    e.preventDefault(); e.stopPropagation();\n    handleForm(e.target, null);\n  }, true);\n\n  /* ---------------- scroll reporting ---------------- */\n\n  var lastSent = 0;\n  function reportScroll(force) {\n    var now = Date.now();\n    if (!force && now - lastSent < 250) return;\n    lastSent = now;\n    var d = document.documentElement;\n    send({\n      scpw: 'scroll',\n      y: Math.round(window.scrollY || document.body.scrollTop || 0),\n      h: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),\n    });\n  }\n  window.addEventListener('scroll', function () { reportScroll(false); }, { passive: true });\n\n  /* ---------------- parent commands ---------------- */\n\n  window.addEventListener('message', function (e) {\n    var d = e.data;\n    if (!d || d.scpw !== 'cmd') return;\n    if (d.op === 'scrollTo') {\n      window.scrollTo(0, d.y || 0);\n    } else if (d.op === 'anchor') {\n      var id = String(d.a || '').replace(/^#/, '');\n      if (id) {\n        var el = document.getElementById(id);\n        if (!el) {\n          var named = document.getElementsByName(id);\n          if (named && named.length) el = named[0];\n        }\n        if (el && el.scrollIntoView) el.scrollIntoView(true);\n        else window.scrollTo(0, 0);\n      }\n    } else if (d.op === 'zoom') {\n      document.body.style.zoom = d.z || 1;\n      var vp = document.querySelector('meta[name=viewport]');\n      if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1');\n    } else if (d.op === 'focus') {\n      document.documentElement.classList.toggle('scpw-focus', !!d.on);\n    } else if (d.op === 'ping') {\n      sendReady();\n    } else if (d.op === 'top') {\n      window.scrollTo(0, 0);\n    }\n  });\n\n  /* ---------------- boot ---------------- */\n\n  window.SCPW_INIT = function (cfg) {\n    CFG = cfg || {};\n    if (document.readyState === 'loading') {\n      document.addEventListener('DOMContentLoaded', function () { init(); });\n    } else {\n      init();\n    }\n  };\n})();\n";

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

  /* --- 1. remove ALL scripts (the page's JS never runs client-side) --- */
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/?>/gi, '');

  /* --- 2. remove framed / embedded / base / noscript / media sources --- */
  html = html.replace(/<(iframe|object|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<\/?(iframe|object|embed|noscript|base|frame|frameset|applet|source|track|template)\b[^>]*\/?>/gi, '');

  /* --- 3. remove ad / tracker img + link tags + empty ad-holder divs --- */
  html = html.replace(/<img\b[^>]*\/?>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<link\b[^>]*\/?>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<div\b[^>]*\bid="(confiant_tag_holder|wad-\d+|atContainer|ad-container|ad-slot)"[^>]*>\s*<\/div>/gi, '');
  html = removeThemeBanner(html);

  /* --- 4. strip inline event handlers + srcset --- */
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

  /* --- 12. inline style attributes: tokenize url() --- */
  html = html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, all, dq, sq) => {
    const css = dq !== undefined ? dq : sq;
    const fixed = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi, (mm, d2, s2, u2) => {
      const raw = d2 !== undefined ? d2 : (s2 !== undefined ? s2 : u2);
      if (raw == null || !raw || /^data:/i.test(raw)) return mm;
      const abs = absUrl(String(raw).trim(), R.base);
      if (!abs || !assetUrlOk(new URL(abs), env)) return mm;
      return 'url("data:,' + R.token(abs) + '")';
    });
    if (fixed === css) return m;
    return ' style="' + encodeEnt(fixed) + '"';
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
  const targetRaw = url.searchParams.get('url');
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
  const targetRaw = url.searchParams.get('url');
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
  h.set('cache-control', 'public, max-age=86400');
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
/* Crom GraphQL helpers (search + random)                              */
/* ------------------------------------------------------------------ */

async function cromQuery(query, variables) {
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
  if (j.errors && j.errors.length) throw new Error('crom error');
  return j.data || {};
}

function cromPathOf(u) {
  try { return new URL(String(u)).pathname || '/'; } catch (e) { return '/'; }
}

/* Optional per-request site: ?site=<host> lets the browser app search /
   random on the branch it is currently browsing. Must be an allowed page
   host; anything else falls back to the configured default site. */
function siteParam(request, env, url) {
  const raw = (url.searchParams.get('site') || '').toLowerCase().trim();
  if (raw && hostAllowed(raw, env) &&
      (HOST_SUFFIXES.some(s => raw.endsWith(s)) || EXACT_HOSTS.includes(raw))) {
    return raw;
  }
  return defaultSite(env);
}

async function apiSearch(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ ok: false, error: 'missing q' }, 400);
  const site = siteParam(request, env, url);
  try {
    const data = await cromQuery(
      'query($q:String!,$base:String){ searchPages(query:$q, filter:{anyBaseUrl:$base}) { url wikidotInfo { title rating } } }',
      { q, base: 'http://' + site });
    const pages = Array.isArray(data.searchPages) ? data.searchPages : [];
    const results = pages.slice(0, 50).map(p => {
      const wi = p.wikidotInfo || {};
      const path = cromPathOf(p.url);
      return { p: path, t: wi.title || decodeURIComponent(path.split('/').pop() || ''), r: (wi.rating == null ? null : wi.rating) };
    });
    return json({ ok: true, q: q, site: site, results: results });
  } catch (e) {
    return json({ ok: false, error: 'search unavailable', detail: String((e && e.message) || e) }, 502);
  }
}

async function apiRandom(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
  const site = (url && siteParam(request, env, url)) || defaultSite(env);
  try {
    const data = await cromQuery(
      'query($base:String){ randomPage(filter:{anyBaseUrl:$base}) { page { url wikidotInfo { title } } } }',
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
          render: '/api/render?url=<absolute-wiki-page-url>',
          asset: '/api/asset?url=<absolute-asset-url>',
          search: '/api/search?q=<query>[&site=<wiki-host>]',
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
    if (url.pathname === '/api/search') return await apiSearch(request, env, url);
    if (url.pathname === '/api/random') return await apiRandom(request, env, url);

    return jsonErr(404, 'unknown endpoint',
      'This worker is API-only. Try /api/render?url=, /api/asset?url=, /api/search?q=, /api/random or /__worker/ping.');
  } catch (e) {
    return jsonErr(500, 'worker error', String((e && e.message) || e));
  }
}
