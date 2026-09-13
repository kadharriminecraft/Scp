/* SCP WIKI WORKER - Cloudflare Worker proxy for the SCP Wiki (Wikidot family)
   Deploy: dash.cloudflare.com -> Workers & Pages -> Create Worker -> paste this file -> Deploy.
   Then paste the worker URL into the SCP Reader app.
   Optional env vars: DEFAULT_SITE, EXTRA_HOSTS (comma-separated extra hosts). */

/* =====================================================================
   SCP WIKI WORKER - Cloudflare Worker proxy for the SCP Wiki (Wikidot)
   =====================================================================
   Purpose:
     Routes every byte of scp-wiki.wikidot.com (and the whole Wikidot
     asset family) through YOUR Cloudflare Worker, so the single-file
     mobile reader can browse the wiki entirely via the worker.

   URL scheme (what the worker serves):
     /raw/<host>/<path>?<query>  ->  proxied https://<host>/<path>?<query>
     /__worker/ping              ->  health-check JSON (used by the reader)
     <anything>/<anything>       ->  resolved via the Referer header when the
                                     request comes from an already-proxied page
                                     (this is how relative JS/XHR URLs work),
                                     otherwise 302 to /raw/<default site>/...

   Security:
     Only the Wikidot / SCP host family is proxied. It is NOT an open proxy.
     Ads and trackers are stripped from pages for a clean, fast, native feel.

   Deploy:
     Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this
     whole file -> Deploy. Copy the workers.dev URL and paste it into the
     reader app. Optional environment variables:
       DEFAULT_SITE  (default: scp-wiki.wikidot.com)
       EXTRA_HOSTS   (comma-separated extra hosts, subdomains included)
   ===================================================================== */

export default { fetch: handle };

const VERSION = '1.0.0';
const DEFAULT_SITE_DEFAULT = 'scp-wiki.wikidot.com';

/* Hosts that may be proxied. Suffixes cover *.wikidot.com / *.wdfiles.com. */
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

/* Ad / tracking domains whose tags are removed from proxied pages.
   Matching is suffix-based: the domain and all its subdomains. */
const AD_DOMAINS = [
  'hadronid.net',
  'facebook.com',
  'facebook.net',
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'googletagservices.com',
  'google-analytics.com',
  'nitropay.com',
  'onesignal.com',
  'confiant-integrations.net',
  'adnxs.com',
  'ml314.com',
  'id5-sync.com',
  'ad.gt',
  'p7cloud.net',
  'adsrvr.org',
  'criteo.com',
  'amazon-adsystem.com',
  'casalemedia.com',
  'taboola.com',
  'pubmatic.com',
  'rubiconproject.com',
  'sharethrough.com',
  'openx.net',
  '33across.com',
  'bidswitch.net',
  'media.net',
  'demdex.net',
  'agkn.com',
  'moatads.com',
  'adsafeprotected.com',
  'triplelift.com',
  'yieldmo.com',
  'gumgum.com',
  'smartadserver.com',
  'd3j8vl19c1131u.cloudfront.net',
];
function isAdDomain(host) {
  host = String(host || '').toLowerCase();
  return AD_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}
/* Markers that identify inline ad/tracker scripts. */
const AD_MARKERS_RE = /(nitroAds|OneSignal|dataLayer|googletag|gtag\(|fbevents|aspan|confiant|prebid|adnxs|hadronid|nitropay|_pbjs|apstag|__tcfapi|doubleclick|adsbygoogle|adservice)/i;

const MAX_BODY = 10 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 25000;
const CACHEABLE_CT = /^(image\/|font\/|application\/font|text\/css|application\/javascript|text\/javascript|application\/x-javascript|application\/wasm|application\/octet-stream)/i;

/* Request headers worth forwarding upstream. */
const FORWARD_REQ_HEADERS = [
  'accept', 'accept-language', 'content-type', 'user-agent',
  'range', 'if-none-match', 'if-modified-since', 'if-range',
  'x-requested-with', 'cookie',
];
/* Response headers removed (framing/CSP blockers + hop-by-hop). */
const STRIP_RESP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'report-to', 'nel',
  'set-cookie', 'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'upgrade', 'x-powered-by', 'alt-svc',
]);

/* ------------------------------------------------------------------ */
/* Tiny bridge injected into every proxied HTML page. It reports       */
/* navigation / scroll to the reader shell and accepts commands.       */
/* (Built with concatenation so the string never contains a literal    */
/* closing script tag - keeps embedding safe.)                         */
/* ------------------------------------------------------------------ */
const SCRIPT_OPEN = '<scr' + 'ipt>';
const SCRIPT_CLOSE = '</scr' + 'ipt>';
const BRIDGE = SCRIPT_OPEN + String.raw`
(function () {
  'use strict';
  if (window.__SCPBRIDGE) return; window.__SCPBRIDGE = 1;
  function post(m) { try { m.src = 'scpbridge'; parent.postMessage(m, '*'); } catch (e) {} }
  function sendNav() { post({ ev: 'nav', url: location.pathname + location.search + location.hash, title: document.title || '' }); }
  function scrollKey() { return 'scps:' + location.pathname + location.search; }
  function applyZoom(z) { try { document.body && (document.body.style.zoom = z); } catch (e) {} }
  window.addEventListener('pagehide', function () { post({ ev: 'loading', on: 1 }); });
  window.addEventListener('hashchange', function () { sendNav(); });
  document.addEventListener('DOMContentLoaded', function () {
    var z = 1; try { z = parseFloat(localStorage.getItem('scpz')) || 1; } catch (e) {}
    applyZoom(z);
    var restore = false;
    try { restore = sessionStorage.getItem('scpr') === '1'; sessionStorage.removeItem('scpr'); } catch (e) {}
    sendNav();
    if (restore) {
      var y = 0; try { y = parseFloat(sessionStorage.getItem(scrollKey())) || 0; } catch (e) {}
      if (y > 0) { window.scrollTo(0, y); setTimeout(function () { window.scrollTo(0, y); }, 400); }
    }
    try {
      document.querySelectorAll('a[target="_blank"]').forEach(function (a) {
        try { if (a.hostname === location.hostname) a.removeAttribute('target'); } catch (e) {}
      });
    } catch (e) {}
  });
  window.addEventListener('load', function () { sendNav(); });
  var tick = false;
  window.addEventListener('scroll', function () {
    if (tick) return; tick = true;
    requestAnimationFrame(function () {
      tick = false;
      var d = document.documentElement, b = document.body;
      var st = window.pageYOffset || d.scrollTop || b.scrollTop || 0;
      var sh = (d.scrollHeight || b.scrollHeight || 0) - window.innerHeight;
      if (sh > 0) post({ ev: 'scroll', pct: Math.min(1, Math.max(0, st / sh)), y: st });
      try { sessionStorage.setItem(scrollKey(), String(Math.round(st))); } catch (e) {}
    });
  }, { passive: true });
  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || d.cmd === undefined) return;
    if (d.cmd === 'go') {
      try { sessionStorage.setItem('scpr', d.restore ? '1' : '0'); } catch (err) {}
      try { location.href = d.url; } catch (err) {}
    } else if (d.cmd === 'reload') { location.reload(); }
    else if (d.cmd === 'zoom') { applyZoom(d.scale || 1); try { localStorage.setItem('scpz', String(d.scale || 1)); } catch (err) {} }
    else if (d.cmd === 'top') { window.scrollTo(0, 0); }
  });
})();
` + SCRIPT_CLOSE;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
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

/* /raw/<host>/<path...>  ->  { host, path }  (path is pathname only) */
function parseRaw(pathname) {
  const m = String(pathname || '').match(/^\/raw\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  let host = m[1];
  try { host = decodeURIComponent(host); } catch (e) {}
  return { host: host.toLowerCase(), path: m[2] || '/' };
}

/* If the Referer is one of our own proxied pages, return its target host. */
function refererHost(request, url) {
  const ref = request.headers.get('referer');
  if (!ref) return null;
  try {
    const r = new URL(ref);
    if (r.origin !== url.origin) return null;
    const t = parseRaw(r.pathname);
    if (!t) return null;
    return t.host;
  } catch (e) { return null; }
}

function upstreamHeaders(request, upstreamUrl) {
  const h = new Headers();
  for (const k of FORWARD_REQ_HEADERS) {
    const v = request.headers.get(k);
    if (v != null) h.set(k, v);
  }
  /* Rebuild the upstream referer from our own /raw referer if possible. */
  const ref = request.headers.get('referer');
  if (ref) {
    try {
      const r = new URL(ref);
      const t = parseRaw(r.pathname);
      if (t) h.set('referer', 'https://' + t.host + t.path);
    } catch (e) {}
  }
  if (!h.has('referer')) h.set('referer', upstreamUrl.origin + '/');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    h.set('origin', upstreamUrl.origin);
  }
  return h;
}

function getSetCookies(res) {
  try { if (typeof res.headers.getAll === 'function') return res.headers.getAll('set-cookie'); } catch (e) {}
  try { if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie(); } catch (e) {}
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/* Re-host cookies onto the worker domain so logins survive. */
function fixCookie(c, isHttps) {
  const parts = String(c).split(';').map(p => p.trim()).filter(Boolean)
    .filter(p => !/^(domain=|samesite=|secure$|partitioned$|priority=|sameparty$)/i.test(p));
  if (!parts.some(p => /^path=/i.test(p))) parts.push('Path=/');
  parts.push('SameSite=None');
  if (isHttps) { parts.push('Secure'); parts.push('Partitioned'); }
  return parts.join('; ');
}

function cleanHeaders(resHeaders, setCookies, isHttps) {
  const h = new Headers();
  resHeaders.forEach((v, k) => {
    if (!STRIP_RESP_HEADERS.has(k.toLowerCase())) h.set(k, v);
  });
  for (const c of setCookies) h.append('set-cookie', fixCookie(c, isHttps));
  h.set('access-control-allow-origin', '*');
  return h;
}

function fixCharset(ctype) {
  if (/charset/i.test(ctype)) return ctype;
  return ctype + (ctype.endsWith(';') ? ' ' : '; ') + 'charset=utf-8';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------------ */
/* URL rewriting                                                       */
/* ------------------------------------------------------------------ */

/* Turn an attribute / css url value into /raw/<host>/<path> or null. */
function attrTarget(val, pageUrl, env) {
  if (val == null) return null;
  const v = String(val).trim();
  if (!v) return null;
  if (/^\/raw\/[a-z0-9.-]+\//i.test(v)) return v; /* already worker-shaped */
  if (/^(#|data:|blob:|javascript:|mailto:|tel:|about:|sms:|mms:|ftp:|itms)/i.test(v)) return null;
  let u;
  try { u = new URL(v, pageUrl); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!hostAllowed(u.hostname, env)) return null;
  return '/raw/' + u.hostname + u.pathname + u.search + u.hash;
}

/* Matches absolute / protocol-relative / JSON-escaped wikidot-family URLs
   in free JS/JSON text. Lookahead avoids partial-host matches. */
const HOST_TEXT_RE = /(?:(?:https?:)?\\?\/\\?\/)((?:[a-z0-9-]+\.)*(?:wikidot\.com|wdfiles\.com|scpwiki\.com)|d3g0gp89917ko\d\.cloudfront\.net)(?=[\s\\\/"'`#?&):;=,<\]}]|$)/gi;

function textualPass(text) {
  return String(text).replace(HOST_TEXT_RE, (m, h) => '/raw/' + h.toLowerCase());
}

const ATTR_RE = /(\b(?:href|src|action|formaction|poster|data-src)\s*=\s*)("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /(\bsrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR_RE = /(\bstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi;

function isAdTag(tagText, body) {
  const m = String(tagText).match(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || [];
  const url = m[1] !== undefined ? m[1] : m[2];
  if (url) {
    const host = (url.match(/^(?:https?:)?\/\/([^/"'\s?#]+)/i) || [])[1];
    if (host && isAdDomain(host)) return true;
  }
  return AD_MARKERS_RE.test(String(tagText) + ' ' + String(body || ''));
}

function rewriteCss(css, pageUrl, env) {
  css = String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const w = attrTarget(u.trim(), pageUrl, env);
    return w ? 'url(' + q + w + q + ')' : m;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const w = attrTarget(u.trim(), pageUrl, env);
    return w ? '@import ' + q + w + q : m;
  });
  return css;
}

function rewriteOneAttr(tag, name, pageUrl, env) {
  return String(tag).replace(new RegExp('(\\b' + name + '\\s*=\\s*)(("([^"]*)")|(\'([^\']*)\'))', 'i'), (m, pre, all, dq, v1, sq, v2) => {
    const val = v1 !== undefined ? v1 : v2;
    const w = attrTarget(val, pageUrl, env);
    if (!w || w === val) return m;
    return pre + (v1 !== undefined ? '"' + w + '"' : "'" + w + "'");
  });
}

function rewriteHtml(html, pageUrl, env) {
  /* 1. drop <base>, SRI integrity attrs, CSP <meta>. */
  html = html.replace(/<base\b[^>]*\/?>/gi, '');
  html = html.replace(/\sintegrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  html = html.replace(/<meta\b(?=[^>]*http-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>/gi, '');

  /* 2. stash <script> blocks: drop ad scripts, rewrite src, keep body for later. */
  const scripts = [];
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi, (m, open, body) => {
    if (isAdTag(open, body)) return '';
    const openFixed = rewriteOneAttr(open, 'src', pageUrl, env);
    scripts.push({ open: openFixed, body });
    return '\u0001' + (scripts.length - 1) + '\u0001';
  });

  /* 3. drop ad <link>, <img> (tracking pixels), <iframe> tags. */
  html = html.replace(/<link\b[^>]*>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<img\b[^>]*>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, m => (isAdTag(m) ? '' : m));

  /* 4. rewrite URL attributes + srcset + inline style url(...). */
  html = html.replace(ATTR_RE, (m, pre, quoted, v1, v2) => {
    const val = v1 !== undefined ? v1 : v2;
    const w = attrTarget(val, pageUrl, env);
    if (!w || w === val) return m;
    const quote = quoted[0];
    return pre + quote + w + quote;
  });
  html = html.replace(SRCSET_RE, (m, pre, quoted, v1, v2) => {
    const val = v1 !== undefined ? v1 : v2;
    const fixed = val.split(',').map(item => {
      const t = item.trim().split(/\s+/);
      if (t[0]) { const w = attrTarget(t[0], pageUrl, env); if (w) t[0] = w; }
      return t.join(' ');
    }).join(', ');
    const quote = quoted[0];
    return pre + quote + fixed + quote;
  });
  html = html.replace(STYLE_ATTR_RE, (m, pre, quoted, v1, v2) => {
    const val = v1 !== undefined ? v1 : v2;
    const fixed = rewriteCss(val, pageUrl, env);
    if (fixed === val) return m;
    const quote = quoted[0];
    return pre + quote + fixed + quote;
  });

  /* 5. rewrite <style> blocks (css files AND inline page css). */
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, body, close) =>
    open + rewriteCss(body, pageUrl, env) + close);

  /* 6. meta refresh targets. */
  html = html.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*?content\s*=\s*["'][^"']*?url\s*=\s*)([^"']+)(["'])/gi, (m, pre, u, q) => {
    const w = attrTarget(u.trim(), pageUrl, env);
    return pre + (w || u) + q;
  });

  /* 7. restore scripts with the textual URL pass. */
  html = html.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const s = scripts[+i];
    if (!s) return '';
    return s.open + textualPass(s.body) + SCRIPT_CLOSE;
  });

  /* 8. inject the reader bridge. */
  if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, m => BRIDGE + m);
  else if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, m => BRIDGE + m);
  else html += BRIDGE;

  return html;
}

/* ------------------------------------------------------------------ */
/* Error page (styled, bridge-equipped so the reader still works)      */
/* ------------------------------------------------------------------ */
function errorPage(status, title, detail, reqUrl) {
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Worker error - ' + esc(title) + '</title>'
    + '<style>body{background:#0b0d11;color:#e7ebf2;font:16px/1.6 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;'
    + 'margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}'
    + '.c{max-width:420px}.g{color:#d64545;font-size:40px;font-weight:800;letter-spacing:2px}'
    + 'h1{font-size:18px;margin:12px 0 8px}p{color:#8b93a3;font-size:14px;word-break:break-all}'
    + 'code{color:#c73030;font-size:12px}</style></head><body><div class="c">'
    + '<div class="g">' + status + '</div><h1>' + esc(title) + '</h1>'
    + '<p>' + esc(detail) + '</p><p><code>' + esc(reqUrl ? reqUrl.pathname : '') + '</code></p>'
    + '</div>' + BRIDGE + '</body></html>';
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
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

    if (url.pathname === '/__worker/ping') {
      return new Response(
        JSON.stringify({ ok: true, proxy: 'scp-wiki-worker', version: VERSION, site: defaultSite(env) }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'x-scp-proxy': VERSION,
          },
        }
      );
    }
    if (url.pathname.startsWith('/__worker/')) {
      return new Response('not found', { status: 404 });
    }

    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } });
    }

    let target = parseRaw(url.pathname);
    if (!target) {
      const rh = refererHost(request, url);
      if (rh && hostAllowed(rh, env)) {
        /* Relative URL requested from an already-proxied page. */
        target = { host: rh, path: url.pathname };
      } else {
        /* Unknown bare path: assume the default site, keep query. */
        const dest = '/raw/' + defaultSite(env) + (url.pathname === '/' ? '/' : url.pathname) + url.search;
        return new Response(null, {
          status: 302,
          headers: { location: dest, 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        });
      }
    }

    if (!hostAllowed(target.host, env)) {
      return errorPage(403, 'Host not allowed',
        'This worker only proxies the SCP Wiki / Wikidot family of sites. Requested host: ' + target.host, url);
    }

    return await proxy(request, env, ctx, target, url);
  } catch (e) {
    return errorPage(500, 'Worker error', String((e && e.message) || e), url);
  }
}

/* ------------------------------------------------------------------ */
/* Proxy core                                                          */
/* ------------------------------------------------------------------ */
async function proxy(request, env, ctx, target, url) {
  const isHttps = url.protocol === 'https:';
  let upstreamUrl;
  try {
    upstreamUrl = new URL('https://' + target.host + target.path + url.search);
  } catch (e) {
    return errorPage(400, 'Bad upstream URL', String(e.message || e), url);
  }

  let body;
  if (request.method === 'POST') {
    const cl = +(request.headers.get('content-length') || 0);
    if (cl > MAX_BODY) return new Response('payload too large', { status: 413 });
    body = await request.arrayBuffer();
  }

  const upReq = new Request(upstreamUrl.href, {
    method: request.method,
    headers: upstreamHeaders(request, upstreamUrl),
    body: body,
    redirect: 'manual',
  });

  /* Cache lookup for GET static assets. */
  if (request.method === 'GET' && typeof caches !== 'undefined') {
    try {
      const hit = await caches.default.match(new Request(url.origin + url.pathname + url.search, { method: 'GET' }));
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-scp-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (e) {}
  }

  let res;
  try {
    res = await Promise.race([
      fetch(upReq),
      new Promise((_, rej) => setTimeout(() => rej(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT + 'ms')), UPSTREAM_TIMEOUT)),
    ]);
  } catch (e) {
    return errorPage(502, 'Upstream unreachable',
      'The worker could not fetch https://' + upstreamUrl.host + ' - ' + String((e && e.message) || e), url);
  }

  /* Follow redirects ourselves so Location can be rewritten. */
  if (res.status >= 300 && res.status < 400) {
    const out = new Headers({ 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    const loc = res.headers.get('location');
    if (loc) {
      try {
        const abs = new URL(loc, upstreamUrl);
        const pr = parseRaw(abs.pathname);
        if (pr && hostAllowed(pr.host, env)) {
          out.set('location', abs.pathname + abs.search + abs.hash); /* already worker-shaped */
        } else if (hostAllowed(abs.hostname, env)) {
          out.set('location', '/raw/' + abs.hostname + abs.pathname + abs.search + abs.hash);
        } else {
          out.set('location', abs.href); /* external: let the browser leave */
        }
      } catch (e) { /* leave Location untouched */ }
    }
    /* Cookies set alongside a redirect (login flows) must survive. */
    for (const c of getSetCookies(res)) {
      out.append('set-cookie', fixCookie(c, isHttps));
    }
    return new Response(null, { status: res.status, headers: out });
  }

  const setCookies = getSetCookies(res);
  const headers = cleanHeaders(res.headers, setCookies, isHttps);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  if (request.method === 'HEAD') {
    return new Response(null, { status: res.status, headers });
  }

  const isHtml = ctype.includes('text/html') || ctype.includes('application/xhtml');
  const isCss = ctype.includes('text/css');
  const isTextual = isHtml || isCss || /javascript|ecmascript|json/.test(ctype) || ctype.startsWith('text/');

  if (isTextual) {
    const cl = +(res.headers.get('content-length') || 0);
    if (cl && cl > MAX_TEXT) {
      return new Response(res.body, { status: res.status, headers });
    }
    const text = await res.text();
    let out;
    if (isHtml) out = rewriteHtml(text, upstreamUrl, env);
    else if (isCss) out = rewriteCss(text, upstreamUrl, env);
    else out = textualPass(text);
    headers.set('content-type', fixCharset(ctype || 'text/plain'));
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-cache');
    return new Response(out, { status: res.status, headers });
  }

  /* Binary: stream through, optionally cached. */
  const outRes = new Response(res.body, { status: res.status, headers });
  if (request.method === 'GET' && res.status === 200 && setCookies.length === 0
    && CACHEABLE_CT.test(ctype) && typeof caches !== 'undefined' && ctx) {
    try {
      const key = new Request(url.origin + url.pathname + url.search, { method: 'GET' });
      ctx.waitUntil(caches.default.put(key, outRes.clone()));
    } catch (e) {}
  }
  return outRes;
}
