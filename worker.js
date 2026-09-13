/* SCP WIKI WORKER - Cloudflare Worker: pure JSON API + asset proxy for the
   SCP Wiki. Deploy: dash.cloudflare.com -> Workers & Pages -> Create Worker
   -> paste this file -> Deploy (from any device that can open the dashboard).
   Opening the worker URL shows a small JSON status object - that is expected:
   this worker serves NO pages. The reader app is the separate single-file
   scp-reader.html, which talks only to this worker's API (/api/page,
   /api/search, /api/random, /raw/ for images and files).
   Optional env vars: DEFAULT_SITE, EXTRA_HOSTS (comma-separated extra hosts). */

/* =====================================================================
   SCP WIKI WORKER - Cloudflare Worker: pure JSON API + asset proxy
   =====================================================================
   Purpose:
     Lets the single-file mobile reader (scp-reader.html) browse the SCP
     Wiki through YOUR worker, so the phone never contacts
     scp-wiki.wikidot.com - everything arrives via this API.

   This worker deliberately serves NO web pages of its own (v2.1): it is
   an API only. Opening the worker URL shows a small JSON status object -
   that is expected. The reading experience lives in scp-reader.html.

   URL scheme (what the worker serves):
     /  (and /__worker/ping)      ->  JSON status + endpoint list
     /api/page/<wikidot path>     ->  JSON { ok, status, host, path, html }
                                      (redirects followed upstream, ads +
                                      scripts + trackers stripped)
     /api/page/<path>?host=<wiki> ->  same, for sibling wikis (scp-int...)
     /api/search?q=               ->  JSON search results (Crom GraphQL)
     /api/random                  ->  JSON random page (Crom GraphQL)
     /raw/<host>/<path>?<query>   ->  proxied ASSETS (images, css, files).
                                      HTML pages are never mirrored.
     anything else                ->  JSON 404 with the endpoint list

   Security:
     Only the Wikidot / SCP host family is proxied. It is NOT an open proxy.
     Ads and trackers are stripped from pages for a clean, fast, native feel.

   Deploy:
     Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this
     whole file -> Deploy (from any device/network that can open
     dash.cloudflare.com). Then open scp-reader.html on your phone and
     paste the worker URL (https://name.account.workers.dev) once.
     Optional environment variables:
       DEFAULT_SITE  (default: scp-wiki.wikidot.com)
       EXTRA_HOSTS   (comma-separated extra hosts, subdomains included)
   ===================================================================== */

export default { fetch: handle };

const VERSION = '2.1.0';
const DEFAULT_SITE_DEFAULT = 'scp-wiki.wikidot.com';
const CROM_GRAPHQL = 'https://api.crom.avn.sh/graphql';

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

/* JSON error helper - the worker is an API, so even errors are JSON. */
function jsonErr(status, error, detail) {
  const body = { ok: false, error: String(error || 'error') };
  if (detail) body.detail = String(detail);
  return new Response(JSON.stringify(body), {
    status: status || 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-scp-proxy': VERSION,
    },
  });
}

/* ------------------------------------------------------------------ */
/* JSON API for the native reader app                                  */
/*                                                                     */
/*   GET /api/page/<wikidot path>   ->  { ok, status, host, path, html }     */
/*        Fetches the wiki page upstream (following redirects), strips */
/*        ads / scripts / trackers, returns the raw-ish HTML. The app  */
/*        parses it client-side (DOMParser) and renders it natively -  */
/*        wiki JS never runs on the phone.                             */
/*   GET /api/search?q=<query>      ->  { ok, results:[{p,t,r}] }      */
/*        Full-text search via the Crom GraphQL API.                   */
/*   GET /api/random                ->  { ok, p, t }                   */
/*        Random page via Crom (falls back to the 302 wiki route on    */
/*        the app side if Crom is unreachable).                        */
/* ------------------------------------------------------------------ */

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

/* Strip everything the reader never needs: all scripts (wiki JS must not
   run on the phone), link tags, iframes, base, CSP/refresh metas, SRI,
   ad/tracker tags. Inline <style> blocks are KEPT (author CSS, the app
   scopes them). Attribute URLs are left untouched - the app resolves
   them against the real page URL and maps them to worker routes. */
function apiSanitize(html) {
  html = String(html);
  html = html.replace(/<base\b[^>]*\/?>/gi, '');
  html = html.replace(/\sintegrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  html = html.replace(/<meta\b[^>]*>/gi, m =>
    /http-equiv\s*=\s*["']?(content-security-policy|refresh)/i.test(m) ? '' : m);
  /* drop ad/tracker link + img + iframe tags first (keeps the check meaningful) */
  html = html.replace(/<link\b[^>]*>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<img\b[^>]*>/gi, m => (isAdTag(m) ? '' : m));
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<iframe\b[^>]*\/?>/gi, m => (isAdTag(m) ? '' : m));
  /* then remove ALL scripts and links and iframes outright */
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  html = html.replace(/<script\b[^>]*\/?>/gi, '');
  html = html.replace(/<link\b[^>]*>/gi, '');
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  html = html.replace(/<iframe\b[^>]*\/?>/gi, '');
  return html;
}

async function fetchWithTimeout(upstreamUrl, init) {
  return await Promise.race([
    fetch(new Request(upstreamUrl, init)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT + 'ms')), UPSTREAM_TIMEOUT)),
  ]);
}

async function apiPage(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'GET only' }, 405);
  }
  /* Optional ?host= lets the reader open sibling wikis (scp-int, cn...)
     in-app. Still only the allowlisted family, still API-only. */
  let site = (url.searchParams.get('host') || '').trim().toLowerCase().replace(/\/+$/, '');
  if (site) {
    if (!hostAllowed(site, env)) {
      return json({ ok: false, error: 'host not allowed', detail: site }, 403);
    }
  } else {
    site = defaultSite(env);
  }
  /* Path after /api/page (keeps its percent-encoding), plus query string. */
  let raw = url.pathname.slice('/api/page'.length) || '/';
  if (!raw.startsWith('/')) raw = '/' + raw;

  /* Short edge-side cache: pages rarely change; 5 minutes is fresh enough
     for a reader and makes repeats instant. */
  const cacheKey = url.origin + '/api/page' + raw + url.search;
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

  /* strip our own ?host= param so it never reaches the upstream site */
  let upstreamSearch = url.search;
  if (url.searchParams.has('host')) {
    const qp = new URLSearchParams(url.search);
    qp.delete('host');
    upstreamSearch = qp.toString();
    if (upstreamSearch) upstreamSearch = '?' + upstreamSearch;
  }
  let upstreamUrl;
  try {
    upstreamUrl = new URL('https://' + site + raw + upstreamSearch);
  } catch (e) {
    return json({ ok: false, error: 'bad path' }, 400);
  }

  let res;
  try {
    res = await fetchWithTimeout(upstreamUrl, {
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return json({ ok: false, error: 'upstream unreachable', detail: String((e && e.message) || e) }, 502);
  }

  /* Follow redirect chains give us the final URL (e.g. /random:random-scp). */
  let finalPath = raw;
  try {
    const fu = new URL(res.url || upstreamUrl.href);
    finalPath = fu.pathname + fu.search || '/';
  } catch (e) {}

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
    return json({ ok: false, error: 'not a wiki page', status: res.status, path: finalPath }, 415);
  }

  const html = apiSanitize(await res.text());
  const out = json({
    ok: true,
    status: res.status,
    host: site,
    path: finalPath,
    html: html,
  }, 200, { 'cache-control': 'public, max-age=300' });

  if (request.method === 'GET' && res.status === 200 && typeof caches !== 'undefined' && ctx) {
    try {
      ctx.waitUntil(caches.default.put(new Request(cacheKey, { method: 'GET' }), out.clone()));
    } catch (e) {}
  }
  return out;
}

/* Crom GraphQL helpers (search + random). */
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

async function apiSearch(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ ok: false, error: 'missing q' }, 400);
  const site = defaultSite(env);
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

async function apiRandom(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
  const site = defaultSite(env);
  try {
    const data = await cromQuery(
      'query($base:String){ randomPage(filter:{anyBaseUrl:$base}) { page { url wikidotInfo { title } } } }',
      { base: 'http://' + site });
    const page = data.randomPage && data.randomPage.page;
    if (!page || !page.url) throw new Error('no random page');
    return json({ ok: true, p: cromPathOf(page.url), t: (page.wikidotInfo && page.wikidotInfo.title) || '' });
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
          page: '/api/page/<wiki-path>[?host=<wiki-host>]',
          search: '/api/search?q=<query>',
          random: '/api/random',
          asset: '/raw/<host>/<path>',
          ping: '/__worker/ping',
        },
        note: 'API-only worker - no pages are served here. The reader app is the separate single-file scp-reader.html.',
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

    /* ---------------- JSON API (the reader app talks to these) -------------
       The phone ONLY ever calls these worker endpoints; the worker does all
       upstream fetching. No wiki URL is ever contacted from the phone.       */
    if (url.pathname === '/api/page' || url.pathname.startsWith('/api/page/')) {
      return await apiPage(request, env, ctx, url);
    }
    if (url.pathname === '/api/search') return await apiSearch(request, env, url);
    if (url.pathname === '/api/random') return await apiRandom(request, env);

    /* Explicit /raw/ asset routes only. Unknown bare paths are NOT
       proxied (v2.1: no site mirroring, no referer guesswork). */
    const target = parseRaw(url.pathname);
    if (target) {
      if (!hostAllowed(target.host, env)) {
        return jsonErr(403, 'host not allowed',
          'This worker only proxies the SCP Wiki / Wikidot family of sites. Requested host: ' + target.host);
      }
      return await proxy(request, env, ctx, target, url);
    }

    return jsonErr(404, 'unknown endpoint',
      'This worker is API-only. Try /api/page/<wiki-path>, /api/search?q=, /api/random, /raw/<host>/<path> or /__worker/ping.');
  } catch (e) {
    return jsonErr(500, 'worker error', String((e && e.message) || e));
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
    return jsonErr(400, 'bad upstream URL', String(e.message || e));
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
    return jsonErr(502, 'upstream unreachable',
      'The worker could not fetch https://' + upstreamUrl.host + ' - ' + String((e && e.message) || e));
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
  /* v2.1: /raw/ is an ASSET proxy - HTML pages are never mirrored or
     rendered by this worker. The reader renders pages itself from
     /api/page. Opening a /raw/ page URL just returns this JSON notice. */
  if (isHtml) {
    return jsonErr(res.status >= 400 ? res.status : 415, 'html not proxied',
      'This worker serves assets + JSON only. Pages come from /api/page/<path> and are rendered by the reader app.');
  }
  const isCss = ctype.includes('text/css');
  const isTextual = isCss || /javascript|ecmascript|json/.test(ctype) || ctype.startsWith('text/');

  if (isTextual) {
    const cl = +(res.headers.get('content-length') || 0);
    if (cl && cl > MAX_TEXT) {
      return new Response(res.body, { status: res.status, headers });
    }
    const text = await res.text();
    const out = isCss ? rewriteCss(text, upstreamUrl, env) : textualPass(text);
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
