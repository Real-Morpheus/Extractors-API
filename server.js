'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Keep-alive agents — reuse TCP connections across requests (big speed win)
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, rejectUnauthorized: false });
const agent = u => u.startsWith('https') ? httpsAgent : httpAgent;

// Pre-warm DNS for most-used hosts at startup
const WARMUP_HOSTS = ['https://hshare.ink', 'https://api.allorigins.win', 'https://corsproxy.io'];
Promise.allSettled(WARMUP_HOSTS.map(h => fetch(h, { method: 'HEAD', agent: agent(h) }).catch(() => {})));


// ─── CF-Protected domain list ─────────────────────────────────────────────────

const CF_PROTECTED = [
  'hubcloud.foo','hubcloud.art','hubcloud.bond','hubcloud.ltd','hubcloud.men',
  'hubcloud.bar','hubcloud.media','hubcloud.lol','hubcloud.cam','hubcloud.skin',
  'hubcloud.hair','hubcloud.vip','hubcloud.luxury','hubcloud.top',
  'gdflix.dev','gdflix.sbs','gdflix.xyz','gdflix.lol','gdflix.top',
  'hshare.ink',
];

function isProtected(url) {
  try {
    const h = new URL(url).hostname;
    return CF_PROTECTED.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

// ─── Headers ──────────────────────────────────────────────────────────────────

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const rUA = () => UAS[Math.floor(Math.random() * UAS.length)];

const bH = (x = {}) => ({
  'User-Agent': rUA(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'DNT': '1', 'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
  ...x,
});

const aH = (x = {}) => ({
  'User-Agent': rUA(),
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  ...x,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Ultra-fast parallel proxy race ───────────────────────────────────────────
//
//  SPEED DESIGN:
//  • All proxies + direct fetch fire at the SAME instant
//  • Each has its own AbortController — winner cancels all losers immediately
//  • Hard 8s global timeout — never wait longer than that
//  • 8 proxy sources total; fastest one wins
//  • Direct fetch attempted first with 200ms head-start via Promise.race trick

function withTimeout(promise, ms, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return promise.finally(() => clearTimeout(timer));
}

async function raceProxies(url, referer = null) {
  const enc  = encodeURIComponent(url);
  const ok   = t => typeof t === 'string' && t.length > 300;
  const hdrs = bH(referer ? { Referer: referer } : {});
  const ag   = agent(url);

  const controllers = Array.from({ length: 9 }, () => new AbortController());
  let settled = false;

  const wrap = (idx, promise) => promise.then(text => {
    if (!ok(text)) throw new Error(`proxy${idx} empty`);
    if (!settled) {
      settled = true;
      controllers.forEach((c, i) => { if (i !== idx) try { c.abort(); } catch {} });
      console.log(`[Proxy] winner=proxy${idx} len=${text.length}`);
    }
    return text;
  });

  const strategies = [
    // 0. Direct with keep-alive agent — fastest if not CF-blocked
    wrap(0, fetch(url, { headers: hdrs, redirect: 'follow', signal: controllers[0].signal, agent: ag })
      .then(r => { if (r.status === 403 || r.status === 503) throw new Error('CF'); if (!r.ok) throw new Error('d' + r.status); return r.text(); })),

    // 1. allorigins (JSON wrapper)
    wrap(1, fetch(`https://api.allorigins.win/get?url=${enc}`, { headers: aH(), signal: controllers[1].signal, agent: httpsAgent })
      .then(r => r.ok ? r.json() : Promise.reject('ao' + r.status))
      .then(d => d.contents || Promise.reject('ao empty'))),

    // 2. allorigins raw (no JSON, slightly faster)
    wrap(2, fetch(`https://api.allorigins.win/raw?url=${enc}`, { headers: aH(), signal: controllers[2].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('aor' + r.status))),

    // 3. corsproxy.io
    wrap(3, fetch(`https://corsproxy.io/?${enc}`, { headers: hdrs, signal: controllers[3].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('cp' + r.status))),

    // 4. codetabs
    wrap(4, fetch(`https://api.codetabs.com/v1/proxy?quest=${enc}`, { headers: hdrs, signal: controllers[4].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('ct' + r.status))),

    // 5. thingproxy
    wrap(5, fetch(`https://thingproxy.freeboard.io/fetch/${url}`, { headers: hdrs, signal: controllers[5].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('tp' + r.status))),

    // 6. cors.sh
    wrap(6, fetch(`https://proxy.cors.sh/${url}`, { headers: { ...hdrs, 'x-cors-api-key': 'temp_test' }, signal: controllers[6].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('cs' + r.status))),

    // 7. Cloudflare Workers CORS proxy (public)
    wrap(7, fetch(`https://cors-anywhere.azurewebsites.net/${url}`, { headers: { ...hdrs, 'X-Requested-With': 'XMLHttpRequest' }, signal: controllers[7].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('ca' + r.status))),

    // 8. htmlreceiver via workers (backup)
    wrap(8, fetch(`https://api.allorigins.win/get?url=${enc}&charset=utf-8`, { headers: aH(), signal: controllers[8].signal, agent: httpsAgent })
      .then(r => r.ok ? r.json() : Promise.reject('ao2' + r.status))
      .then(d => d.contents || Promise.reject('ao2 empty'))),
  ];

  // 8s hard deadline
  const deadline = new Promise((_, rej) => setTimeout(() => {
    controllers.forEach(c => { try { c.abort(); } catch {} });
    rej(new Error('timeout'));
  }, 8000));

  return Promise.race([Promise.any(strategies), deadline]).catch(e => {
    controllers.forEach(c => { try { c.abort(); } catch {} });
    throw new Error(`All proxies failed for ${url}: ${e.message}`);
  });
}

async function scrapeHtml(url, referer = null) {
  if (isProtected(url)) {
    console.log(`[Proxy] racing ${url}`);
    const text = await raceProxies(url, referer);
    return { text, finalUrl: url };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: bH(referer ? { Referer: referer } : {}),
      redirect: 'follow',
      signal: ac.signal,
      agent: agent(url),
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return { text: await r.text(), finalUrl: r.url };
  } catch (e) { clearTimeout(timer); throw e; }
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function parseLinks(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hM = /\bhref=["']([^"']+)["']/i.exec(m[1]);
    const cM = /\bclass=["']([^"']+)["']/i.exec(m[1]);
    if (!hM) continue;
    out.push({
      href: hM[1].trim(),
      classes: cM ? cM[1] : '',
      text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

// Handles multi-class like "btn btn-secondary"
const hrefByClass = (html, cls) =>
  parseLinks(html).find(l => l.classes.split(/\s+/).includes(cls))?.href ?? null;

const reGet = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };

function normPixel(link) {
  if (!link.includes('pixeld')) return link;
  if (link.includes('/u/')) {
    const t = link.split('/u/')[1].split('?')[0];
    return link.split('/u/')[0] + '/api/file/' + t;
  }
  if (!link.includes('/api/')) {
    const p = link.split('/');
    return p.slice(0, -2).join('/') + '/api/file/' + p[p.length - 1];
  }
  return link;
}

// ─── Redirect API ─────────────────────────────────────────────────────────────

const RAPI = 'https://ssbackend-2r7z.onrender.com/api/redirect';
async function resolveViaApi(url) {
  try {
    const r = await fetch(`${RAPI}?url=${encodeURIComponent(url)}`, { headers: aH() });
    if (!r.ok) return null;
    return (await r.json()).finalUrl ?? null;
  } catch { return null; }
}

// ─── hcloud.shop Bypasser ─────────────────────────────────────────────────────
//
//  hcloud pages list multiple download servers (Server 1, Server 2, etc.)
//  as <a id="download-btn1">, <a id="download-btn2"> etc.
//  We fetch the page, extract all server links, and return them all.

// ─── hshare.ink Bypasser ──────────────────────────────────────────────────────
//
//  Two URL patterns:
//
//  1. /redirect.php?id=...       — countdown page → token POST → final CDN URL
//  2. /file.php?id=...&key=...   — hcloud URL embedded in id param → decode → servers
//
//  bypassHshare()      returns STRING  (single final URL)
//  bypassHshareMulti() returns ARRAY   of {server, link}

// ─── Extract embedded hcloud URL from a mangled hshare URL ───────────────────
//
//  Some hshare file.php URLs have the hcloud link directly embedded in the
//  id= param, like:
//    id=BASE64_FILENAME...https://hcloud.shop/redirect.php?url=BASE64...KEY
//
//  We extract it directly — no HTTP request needed. Zero latency.

function extractEmbeddedHcloud(url) {
  try {
    // Pattern 1: raw https://hcloud.shop embedded directly in the URL string
    const rawMatch = /(https?:\/\/hcloud\.shop\/[^\s&"'<>]+)/.exec(url);
    if (rawMatch) return rawMatch[1];

    // Pattern 2: hcloud URL is inside the id= param (URL-encoded or raw)
    const idMatch = /[?&]id=([^&]+)/.exec(url);
    if (!idMatch) return null;

    let idVal = decodeURIComponent(idMatch[1]);

    // The id param may contain the hcloud URL directly after some base64 prefix
    // e.g. "BASE64_STUFFhttps://hcloud.shop/..."
    const inId = /(https?:\/\/hcloud\.shop\/[^\s"'<>]+)/.exec(idVal);
    if (inId) return inId[1];

    // Pattern 3: the id= param itself is base64 — decode and look for hcloud
    try {
      const decoded = Buffer.from(idVal, 'base64').toString('utf8');
      const inDecoded = /(https?:\/\/hcloud\.shop\/[^\s"'<>]+)/.exec(decoded);
      if (inDecoded) return inDecoded[1];
    } catch {}

    // Pattern 4: hcloud redirect.php?url=BASE64 — decode the nested base64
    const redirectMatch = /hcloud\.shop\/redirect\.php\?url=([A-Za-z0-9+/=%-]+)/.exec(url);
    if (redirectMatch) {
      try {
        const inner = decodeURIComponent(redirectMatch[1]);
        const decoded = Buffer.from(inner, 'base64').toString('utf8');
        // decoded is now the actual hcloud page URL
        const hcloudUrl = 'https://hcloud.shop/redirect.php?url=' + encodeURIComponent(
          Buffer.from(decoded).toString('base64')
        );
        return 'https://hcloud.shop/redirect.php?url=' + redirectMatch[1];
      } catch {}
    }

    return null;
  } catch (e) {
    console.log(`[extractEmbeddedHcloud] error: ${e}`);
    return null;
  }
}

// ─── Decode hcloud double-base64 chain → final CDN URL ───────────────────────
//
//  Chain:
//   hcloud.shop/redirect.php?url=B64_1
//     → decode B64_1 → hcloud.shop/direct/index.php?url=B64_2
//       → decode B64_2 → FINAL CDN URL (workers.dev / drive / etc.)
//
//  This is done purely in memory — zero HTTP requests.

function decodeHcloudChain(hcloudUrl) {
  try {
    const u = new URL(hcloudUrl);
    const urlParam = u.searchParams.get('url');
    if (!urlParam) return null;

    // First decode
    const decoded1 = Buffer.from(urlParam, 'base64').toString('utf8');
    console.log(`[hcloud/decode] step1: ${decoded1.slice(0, 80)}`);

    // If it's another hcloud URL, decode again
    if (decoded1.includes('hcloud.shop')) {
      const u2 = new URL(decoded1);
      const urlParam2 = u2.searchParams.get('url');
      if (urlParam2) {
        const decoded2 = Buffer.from(urlParam2, 'base64').toString('utf8');
        console.log(`[hcloud/decode] step2 (final): ${decoded2.slice(0, 80)}`);
        return decoded2;
      }
      return decoded1;
    }

    return decoded1;
  } catch (e) {
    console.log(`[hcloud/decode] error: ${e}`);
    return null;
  }
}

async function bypassHshareMulti(url) {
  console.log(`[hshare/multi] ${url}`);

  if (url.includes('/file.php') && url.includes('id=') && url.includes('key=')) {

    // ── Ultra-fast path: hcloud URL embedded in the URL string ───────────────
    // The id= param often contains the hcloud link raw (no fetch needed at all)
    const embeddedHcloud = extractEmbeddedHcloud(url);
    if (embeddedHcloud) {
      console.log(`[hshare/file.php] embedded hcloud: ${embeddedHcloud}`);
      return bypassHcloud(embeddedHcloud);
    }

    // ── Normal path: fetch page, find hcloud link ─────────────────────────────
    let html = null;
    const directFetch = fetch(url, {
      headers: bH({ Referer: 'https://hshare.ink/' }),
      redirect: 'follow',
      agent: httpsAgent,
    }).then(async r => {
      if (!r.ok) throw new Error('direct ' + r.status);
      const t = await r.text();
      if (t.length < 300) throw new Error('direct empty');
      return t;
    });

    const proxyFetch = raceProxies(url, 'https://hshare.ink/');

    try {
      html = await Promise.any([directFetch, proxyFetch]);
      console.log(`[hshare/file.php] page fetched len=${html.length}`);
    } catch (e) {
      console.log(`[hshare/file.php] all fetches failed: ${e}`);
      return [{ server: 'HShare', link: url }];
    }

    // hcloud link in href
    const hcloudM = /(https?:\/\/[^\s"'<>]*hcloud[^\s"'<>]*)/i.exec(html);
    if (hcloudM) {
      console.log(`[hshare/file.php] → hcloud: ${hcloudM[1]}`);
      return bypassHcloud(hcloudM[1]);
    }

    // Scan anchors
    const streams = [];
    for (const el of parseLinks(html)) {
      if (!el.href.startsWith('http') || el.href.includes('hshare')) continue;
      if (el.href.includes('hcloud')) {
        streams.push(...(await bypassHcloud(el.href)));
      } else {
        streams.push({ server: el.text || 'HShare', link: el.href });
      }
    }
    if (!streams.length) {
      const direct = extractFinalFromHtml(html);
      if (direct) streams.push({ server: 'HShare', link: direct });
    }
    return streams.length ? streams : [{ server: 'HShare', link: url }];
  }

  // redirect.php — single URL from token bypass
  const finalUrl = await bypassHshare(url);
  return [{ server: 'HShare', link: finalUrl }];
}

async function bypassHcloud(url) {
  console.log(`[hcloud] ${url}`);
  try {
    // Fast path: decode the base64 chain without any HTTP request
    if (url.includes('hcloud.shop') && url.includes('url=')) {
      const finalUrl = decodeHcloudChain(url);
      if (finalUrl && finalUrl.startsWith('http') && !finalUrl.includes('hcloud.shop')) {
        console.log(`[hcloud] decoded (no fetch): ${finalUrl.slice(0, 80)}`);
        return [{ server: 'HCloud', link: finalUrl }];
      }
      // decoded is another hcloud page — fetch it for server buttons
      if (finalUrl && finalUrl.includes('hcloud.shop')) {
        return fetchHcloudPage(finalUrl);
      }
    }
    return fetchHcloudPage(url);
  } catch (e) {
    console.log(`[hcloud] error: ${e}`);
    return [{ server: 'HCloud', link: url }];
  }
}

async function fetchHcloudPage(url) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 6000);
  let html;
  try {
    const r = await fetch(url, {
      headers: bH({ Referer: 'https://hshare.ink/' }),
      redirect: 'follow',
      signal: ac.signal,
      agent: httpsAgent,
    });
    html = await r.text();
  } catch {
    try { ({ text: html } = await scrapeHtml(url, 'https://hshare.ink/')); }
    catch { return [{ server: 'HCloud', link: url }]; }
  }

  const servers = [];
  for (let i = 1; i <= 10; i++) {
    const m = new RegExp(
      `id=["']download-btn${i}["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*id=["']download-btn${i}["']`, 'i'
    ).exec(html);
    if (m) servers.push({ server: `Server ${i}`, link: m[1] || m[2] });
  }
  if (!servers.length) {
    for (const el of parseLinks(html)) {
      if (/server\s*\d+/i.test(el.text) && el.href.startsWith('http'))
        servers.push({ server: el.text.trim(), link: el.href });
    }
  }
  if (!servers.length) {
    const direct = extractFinalFromHtml(html);
    if (direct) servers.push({ server: 'HCloud', link: direct });
  }
  console.log(`[hcloud/page] ${servers.length} server(s)`);
  return servers.length ? servers : [{ server: 'HCloud', link: url }];
}

function extractFinalFromHtml(html) {
  // reurl JS variable (most common hshare response format)
  const reurlM = /var\s+reurl\s*=\s*["']([^"']+)["']/.exec(html);
  if (reurlM && reurlM[1].startsWith('http')) return reurlM[1];

  // window.location redirect
  const locM = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(html);
  if (locM && locM[1].startsWith('http') && !locM[1].includes('hshare')) return locM[1];

  // Direct download/CDN link in anchors
  for (const el of parseLinks(html)) {
    if (!el.href.startsWith('http') || el.href.includes('hshare')) continue;
    const isDownload =
      el.text.toLowerCase().includes('download') ||
      el.text.toLowerCase().includes('get link') ||
      el.text.toLowerCase().includes('click here') ||
      el.classes.includes('btn-success') ||
      el.classes.includes('btn-primary') ||
      el.classes.includes('btn-warning') ||
      /\.(mkv|mp4|zip|rar)(\?|$)/i.test(el.href) ||
      el.href.includes('drive.google') ||
      el.href.includes('googleapis') ||
      el.href.includes('r2.dev') ||
      el.href.includes('pixeldrain') ||
      el.href.includes('gofile.io');
    if (isDownload) return el.href;
  }
  return null;
}

async function bypassHshare(url) {
  console.log(`[hshare] bypassing: ${url}`);

  // ── hshare.ink/file.php?id=...&key=... — direct file download page ───────
  // This endpoint shows an hcloud.shop download page with server buttons.
  // We fetch it, find the hcloud link, then follow it to get server URLs.
  if (url.includes('/file.php') && url.includes('id=') && url.includes('key=')) {
    console.log(`[hshare/file.php] detected — fetching download page`);
    try {
      let html;
      try {
        ({ text: html } = await scrapeHtml(url, 'https://hshare.ink/'));
      } catch {
        // Try direct fetch if proxy fails
        const r = await fetch(url, { headers: bH({ Referer: 'https://hshare.ink/' }), redirect: 'follow' });
        html = await r.text();
      }

      // Look for hcloud.shop link or any direct CDN link
      const hcloudM = /href=["'](https?:\/\/[^"']*hcloud[^"']+)["']/i.exec(html);
      if (hcloudM) {
        console.log(`[hshare/file.php] found hcloud: ${hcloudM[1]}`);
        return bypassHcloud(hcloudM[1]);
      }

      // Look for direct download button / CDN link on the page
      const direct = extractFinalFromHtml(html);
      if (direct && !direct.includes('hshare')) {
        console.log(`[hshare/file.php] direct link: ${direct}`);
        return direct;
      }

      // Try following any button link on the page
      for (const el of parseLinks(html)) {
        if (el.href.startsWith('http') && !el.href.includes('hshare') && !el.href.includes('javascript')) {
          console.log(`[hshare/file.php] fallback link: ${el.href}`);
          // If it looks like an hcloud page, bypass it
          if (el.href.includes('hcloud')) return bypassHcloud(el.href);
          return el.href;
        }
      }
    } catch (e) {
      console.log(`[hshare/file.php] error: ${e}`);
    }
    return url;
  }

  let html;
  try {
    ({ text: html } = await scrapeHtml(url, 'https://hshare.ink/'));
  } catch (e) {
    console.log(`[hshare] page fetch failed: ${e}`);
    return url;
  }

  // Extract token and form action
  const tokenM = /(?:name=["']token["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']token["'])/i.exec(html);
  const actionM = /<form[^>]*action=["']([^"']+)["']/i.exec(html);
  const waitM   = /var\s+(?:seconds|countdown|timer)\s*=\s*(\d+)/.exec(html);
  const waitSecs = waitM ? Math.min(parseInt(waitM[1]), 15) : 0;

  // ── Strategy 1: Token POST (waits for countdown then POSTs) ─────────────
  const postStrategy = tokenM ? (async () => {
    const token  = tokenM[1] || tokenM[2];
    const action = actionM
      ? (actionM[1].startsWith('/') ? new URL(actionM[1], url).href : actionM[1])
      : url;

    if (waitSecs > 0) {
      console.log(`[hshare] waiting ${waitSecs}s for token unlock…`);
      await sleep(waitSecs * 1000);
    }

    const body = new URLSearchParams({ token });
    const goM = /name=["']go["'][^>]*value=["']([^"']+)["']/i.exec(html);
    if (goM) body.append('go', goM[1]);

    const r = await fetch(action, {
      method: 'POST',
      headers: {
        ...bH({ Referer: url }),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      redirect: 'follow',
    });
    const resultHtml = await r.text();
    const final = extractFinalFromHtml(resultHtml);
    if (final) return final;

    // Sometimes the POST itself redirects to the final URL
    if (r.url && r.url !== action && !r.url.includes('hshare')) return r.url;
    return null;
  })() : Promise.resolve(null);

  // ── Strategy 2: JS redirect already in page (no wait needed) ────────────
  const jsStrategy = (async () => {
    const patterns = [
      /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
      /window\.location\.replace\(["']([^"']+)["']\)/,
      /location\.href\s*=\s*["']([^"']+)["']/,
    ];
    for (const p of patterns) {
      const m = p.exec(html);
      if (m && m[1].startsWith('http') && !m[1].includes('hshare')) return m[1];
    }
    return null;
  })();

  // ── Strategy 3: Meta refresh ─────────────────────────────────────────────
  const metaStrategy = (async () => {
    const m = /content=["']\d+;\s*url=([^"'\s>]+)/i.exec(html);
    if (m) {
      const link = m[1].replace(/['"]/g, '').trim();
      if (link.startsWith('http') && !link.includes('hshare')) return link;
    }
    return null;
  })();

  // ── Strategy 4: reurl / direct link already in page ─────────────────────
  const directStrategy = (async () => extractFinalFromHtml(html))();

  // Race all — fastest non-null result wins
  // Note: postStrategy may take waitSecs seconds, others are instant
  const results = await Promise.allSettled([
    postStrategy, jsStrategy, metaStrategy, directStrategy,
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      console.log(`[hshare] resolved → ${r.value}`);
      return r.value;
    }
  }

  console.log(`[hshare] all strategies failed, returning original`);
  return url;
}

// ─── VCloud Extractor ─────────────────────────────────────────────────────────

async function vcloudExtract(url) {
  console.log(`[VCloud] ${url}`);
  const streams = [];
  let mid = null;

  for (let i = 1; i <= 3; i++) {
    try {
      const { text } = await scrapeHtml(url);
      mid = reGet(text, /var\s+url\s*=\s*'([^']+)'/)
         ?? reGet(text, /const\s+url\s*=\s*'([^']+)'/)
         ?? reGet(text, /url\s*=\s*'([^']+)'/)
         ?? reGet(text, /'(https?:\/\/[^']*hubcloud\.php[^']*)'/);
      if (mid) break;
    } catch (e) {
      if (i === 3) return [];
      await sleep(i * 1000);
    }
  }
  if (!mid) return [];

  try {
    const { text } = await scrapeHtml(mid, 'https://vcloud.lol/');
    const excl = ['google.com/search','t.me/','telegram.me/','whatsapp.com','facebook.com','twitter.com','instagram.com'];
    const futs = [];
    for (const el of parseLinks(text)) {
      let lnk = el.href;
      if (!lnk || lnk.startsWith('#') || lnk.startsWith('javascript')) continue;
      if (excl.some(p => lnk.includes(p))) continue;
      if (lnk.includes('hshare.ink'))    { futs.push(bypassHshareMulti(lnk).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' })))); continue; }
      if (lnk.includes('pixeld'))         { streams.push({ server: 'Pixeldrain', link: normPixel(lnk), type: 'mkv' }); continue; }
      if (lnk.includes('pixel.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); })); continue; }
      if (lnk.includes('gpdl2.hubcdn.fans') || lnk.includes('gpdl.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || lnk, type: 'mkv' }))); continue; }
      if (el.classes.includes('btn-danger')) streams.push({ server: '10Gbps Server', link: lnk, type: 'mkv' });
      else if (lnk.includes('.r2.dev'))  streams.push({ server: 'R2 CDN', link: lnk, type: 'mkv' });
      else if (el.classes.includes('btn-success')) streams.push({ server: 'Server 1', link: lnk, type: 'mkv' });
      else if (lnk.includes('download') || /\.(mkv|mp4)(\?|$)/.test(lnk)) streams.push({ server: 'VCloud', link: lnk, type: 'mkv' });
    }
    await Promise.all(futs);
  } catch (e) { console.log(`[VCloud] step2: ${e}`); }

  console.log(`[VCloud] ${streams.length} streams`);
  return streams;
}

// ─── HubCloud Extractor ───────────────────────────────────────────────────────

async function hubcloudExtract(url) {
  console.log(`[HubCloud] ${url}`);
  let origin = '';
  try { origin = new URL(url).origin; } catch {}

  let html1 = '';
  try {
    ({ text: html1 } = await scrapeHtml(url));
    console.log(`[HubCloud] page1 len=${html1.length}`);
  } catch (e) {
    console.log(`[HubCloud] page1 error: ${e}`);
    return [{ server: '_error', link: String(e), type: 'error' }];
  }

  const jsP = [
    /var\s+url\s*=\s*'([^']+)'/, /const\s+url\s*=\s*'([^']+)'/, /let\s+url\s*=\s*'([^']+)'/,
    /var\s+url\s*=\s*"([^"]+)"/, /const\s+url\s*=\s*"([^"]+)"/, /let\s+url\s*=\s*"([^"]+)"/,
    /url\s*=\s*'([^']+)'/, /url\s*=\s*"([^"]+)"/,
  ];
  let redirectUrl = null;
  for (const p of jsP) { const v = reGet(html1, p); if (v?.startsWith('http')) { redirectUrl = v; break; } }

  let vcloudLink = null;
  if (redirectUrl) {
    try {
      const rp = new URL(redirectUrl).searchParams.get('r');
      if (rp) { try { vcloudLink = Buffer.from(rp, 'base64').toString('utf8'); } catch { vcloudLink = redirectUrl; } }
      else vcloudLink = redirectUrl;
    } catch { vcloudLink = redirectUrl; }
  }

  if (!vcloudLink) {
    const btns = parseLinks(html1).filter(l =>
      l.classes.includes('btn-success') || l.classes.includes('btn-danger') || l.classes.includes('btn-secondary')
    );
    if (btns.length) return processHubButtons(html1, url);
    const any = parseLinks(html1).find(l =>
      l.href.includes('gamerxyt') || l.href.includes('hubcloud') || l.href.includes('vcloud')
    );
    vcloudLink = any ? any.href : url;
  }

  if (vcloudLink.startsWith('/')) vcloudLink = `${origin}${vcloudLink}`;

  if (vcloudLink.includes('gamerxyt.com') && vcloudLink.includes('hubcloud.php')) {
    return hubGamerxyt(vcloudLink, origin);
  }

  let html2 = '';
  try {
    ({ text: html2 } = await scrapeHtml(vcloudLink, url));
    console.log(`[HubCloud] page2 len=${html2.length}`);
  } catch {
    return processHubButtons(html1, url);
  }

  const gxM = /href="(https:\/\/[^"]*gamerxyt\.com[^"]*hubcloud\.php[^"]*)"/.exec(html2);
  if (gxM) return hubGamerxyt(gxM[1], origin);

  return processHubButtons(html2, vcloudLink);
}

async function processHubButtons(html, pageUrl) {
  const streams = [];
  const futs = [];

  for (const el of parseLinks(html)) {
    let lnk = el.href;
    if (!lnk || lnk.startsWith('#') || lnk.startsWith('javascript')) continue;
    if (!lnk.startsWith('http')) { try { lnk = new URL(lnk, pageUrl).href; } catch { continue; } }

    if (lnk.includes('hshare.ink'))     { futs.push(bypassHshareMulti(lnk).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' })))); continue; }
    if (lnk.includes('gdflix'))          { streams.push({ server: 'GDFlix', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('pixeld'))          { streams.push({ server: 'Pixeldrain', link: normPixel(lnk), type: 'mkv' }); continue; }
    if (lnk.includes('gpdl2.hubcdn.fans') || lnk.includes('gpdl.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || lnk, type: 'mkv' }))); continue; }
    if (lnk.includes('pixel.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); })); continue; }
    if (lnk.includes('.dev') && !lnk.includes('/?id=')) { streams.push({ server: 'Cf Worker', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('cloudflarestorage')) { streams.push({ server: 'CfStorage', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('fastdl'))          { streams.push({ server: 'FastDl', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('hubcdn') && !lnk.includes('hubcloud')) { streams.push({ server: 'HubCdn', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('hubcloud') || lnk.includes('/?id=')) {
      futs.push((async lk => {
        try {
          const r = await fetch(lk, { method: 'HEAD', headers: bH({ Referer: pageUrl }), redirect: 'manual' });
          const loc = r.headers.get('location');
          streams.push({ server: 'HubCloud', link: loc ? (loc.includes('link=') ? loc.split('link=').pop() : loc) : lk, type: 'mkv' });
        } catch { streams.push({ server: 'HubCloud', link: lnk, type: 'mkv' }); }
      })(lnk)); continue;
    }
  }

  await Promise.all(futs);
  console.log(`[HubCloud/btn] ${streams.length} streams`);
  return streams;
}

async function hubGamerxyt(link, refOrigin) {
  const streams = [];
  let html;
  try { ({ text: html } = await scrapeHtml(link, refOrigin)); }
  catch { return []; }

  const futs = [];
  for (const el of parseLinks(html)) {
    const h = el.href; const t = el.text;
    if (!h?.startsWith('http')) continue;
    if (h.includes('telegram') || h.includes('bloggingvector') || h.includes('ampproject.org')) continue;

    if (h.includes('hshare.ink'))    { futs.push(bypassHshareMulti(h).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' })))); continue; }
    if (t.includes('FSL Server') || t.includes('FSLv2 Server') || h.includes('.r2.dev') || h.includes('fsl.cdnbaba') || h.includes('cdn.fsl-buckets')) { streams.push({ server: 'Cf Worker', link: h, type: 'mkv' }); continue; }
    if (h.includes('gpdl2.hubcdn.fans') || h.includes('gpdl.hubcdn.fans')) { futs.push(resolveViaApi(h).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || h, type: 'mkv' }))); continue; }
    if (h.includes('pixel.hubcdn.fans')) { futs.push(resolveViaApi(h).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); })); continue; }
    if (t.includes('PixeLServer') || h.includes('pixeldrain') || h.includes('pixeld')) { streams.push({ server: 'Pixeldrain', link: normPixel(h), type: 'mkv' }); continue; }
    if (h.includes('mega.hubcloud') || t.toLowerCase().includes('mega')) { streams.push({ server: 'Mega', link: h, type: 'mkv' }); continue; }
    if (h.includes('cloudserver') || h.includes('workers.dev') || t.toLowerCase().includes('zipdisk')) { streams.push({ server: 'ZipDisk', link: h, type: 'zip' }); continue; }
    if (h.includes('cloudflarestorage')) { streams.push({ server: 'CfStorage', link: h, type: 'mkv' }); continue; }
    if (h.includes('fastdl'))  { streams.push({ server: 'FastDl', link: h, type: 'mkv' }); continue; }
    if (h.includes('gdflix'))  { streams.push({ server: 'GDFlix', link: h, type: 'mkv' }); continue; }
  }

  await Promise.all(futs);
  console.log(`[HubCloud/gamerxyt] ${streams.length} streams`);
  return streams;
}

// ─── GDFlix Extractor ─────────────────────────────────────────────────────────

async function gdflixExtract(url) {
  console.log(`[GDFlix] ${url}`);
  const streams = [];
  const origin = new URL(url).origin;

  let html;
  try { ({ text: html } = await scrapeHtml(url)); }
  catch (e) { console.log(`[GDFlix] fetch: ${e}`); return []; }

  const resumeHref  = hrefByClass(html, 'btn-secondary');
  const seedHref    = hrefByClass(html, 'btn-danger');
  const pixelHref   = hrefByClass(html, 'btn-success');
  const gofileLinks = parseLinks(html).filter(l => l.classes.includes('btn-outline-info'));
  const hshareLinks = parseLinks(html).filter(l => l.href.includes('hshare.ink'));

  console.log(`[GDFlix] resume=${resumeHref} seed=${seedHref} pixel=${pixelHref} gofile=${gofileLinks.length} hshare=${hshareLinks.length}`);

  const tasks = [];

  // Resume (.btn-secondary)
  if (resumeHref) {
    tasks.push((async () => {
      if (resumeHref.includes('indexbot')) {
        try {
          const { text: bh } = await scrapeHtml(resumeHref);
          const tM = /formData\.append\('token', '([a-f0-9]+)'\)/.exec(bh);
          const pM = /fetch\('\/download\?id=([a-zA-Z0-9\/+=]+)'/.exec(bh);
          if (tM && pM) {
            const body = new URLSearchParams({ token: tM[1] });
            const r = await fetch(`${resumeHref.split('/download')[0]}/download?id=${pM[1]}`, {
              method: 'POST',
              headers: { ...bH({ Referer: resumeHref }), 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'PHPSESSID=7e9658ce7c805dab5bbcea9046f7f308' },
              body: body.toString(),
            });
            if (r.ok) { const d = await r.json(); if (d.url) streams.push({ server: 'ResumeBot', link: d.url, type: 'mkv' }); }
          }
        } catch (e) { console.log(`[GDFlix/bot] ${e}`); }
      } else {
        try {
          const ru = resumeHref.startsWith('http') ? resumeHref : `${origin}${resumeHref}`;
          const { text: rc } = await scrapeHtml(ru);
          const rl = hrefByClass(rc, 'btn-success');
          if (rl) streams.push({ server: 'ResumeCloud', link: rl, type: 'mkv' });
        } catch (e) { console.log(`[GDFlix/cloud] ${e}`); }
      }
    })());
  }

  // Instant / G-Drive seed (.btn-danger)
  if (seedHref) {
    tasks.push((async () => {
      try {
        if (seedHref.includes('instant.busycdn.xyz') && seedHref.includes('::')) {
          const f = await resolveViaApi(seedHref);
          if (f) {
            const c = f.includes('fastcdn-dl.pages.dev/?url=')
              ? decodeURIComponent(f.split('fastcdn-dl.pages.dev/?url=')[1]) : f;
            streams.push({ server: 'G-Drive', link: c, type: 'mkv' });
          }
        } else if (!seedHref.includes('?url=')) {
          const r = await fetch(seedHref, { method: 'HEAD', headers: bH(), redirect: 'manual' });
          let nl = r.headers.get('location') || seedHref;
          if (nl.includes('fastcdn-dl.pages.dev/?url=')) nl = decodeURIComponent(nl.split('?url=')[1]);
          streams.push({ server: 'G-Drive', link: nl, type: 'mkv' });
        } else {
          const token = seedHref.split('=')[1];
          const su = new URL(seedHref);
          const body = new URLSearchParams({ keys: token });
          const r = await fetch(`${su.protocol}//${su.host}/api`, {
            method: 'POST',
            headers: { ...bH(), 'x-token': `${su.protocol}//${su.host}/api`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          if (r.ok) { const d = await r.json(); if (!d.error && d.url) streams.push({ server: 'Gdrive-Instant', link: d.url, type: 'mkv' }); }
        }
      } catch (e) { console.log(`[GDFlix/seed] ${e}`); }
    })());
  }

  // Pixeldrain (.btn-success)
  if (pixelHref?.includes('pixeldrain')) {
    streams.push({ server: 'Pixeldrain', link: normPixel(pixelHref), type: 'mkv' });
  }

  // hshare links — bypass all in parallel
  for (const el of hshareLinks) {
    tasks.push(bypassHshareMulti(el.href).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' }))));
  }

  // GoFile (.btn-outline-info)
  for (const el of gofileLinks) {
    if (el.text.includes('GoFile [Multiup]') && el.href) {
      tasks.push((async () => {
        try {
          const { text: mh } = await scrapeHtml(el.href);
          const gm = /namehost=["']gofile\.io["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*namehost=["']gofile\.io["']/.exec(mh);
          const gu = gm ? (gm[1] || gm[2]) : null;
          if (gu?.includes('/d/')) {
            const gr = await gofileExtract(gu.split('/d/')[1].split('?')[0]);
            if (gr.success) streams.push({ server: 'GoFile', link: gr.link, type: 'mkv', headers: { referer: 'https://gofile.io/', cookie: `accountToken=${gr.token}` } });
          }
        } catch (e) { console.log(`[GDFlix/gofile] ${e}`); }
      })());
      break;
    }
  }

  await Promise.all(tasks);
  console.log(`[GDFlix] ${streams.length} streams`);
  return streams;
}

// ─── GoFile Extractor ─────────────────────────────────────────────────────────

async function gofileExtract(id) {
  try {
    const ar = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: aH() });
    if (!ar.ok) throw new Error(`account ${ar.status}`);
    const ad = await ar.json();
    if (ad.status !== 'ok') throw new Error('account failed');
    const token = ad.data.token;
    const cr = await fetch(
      `https://api.gofile.io/contents/${id}?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1`,
      { headers: aH({ Authorization: `Bearer ${token}`, 'x-website-token': '4fd6sg89d7s6', origin: 'https://gofile.io', referer: 'https://gofile.io/' }) }
    );
    if (!cr.ok) throw new Error(`content ${cr.status}`);
    const cd = await cr.json();
    if (cd.status !== 'ok') throw new Error('content failed');
    const ch = cd.data?.children;
    if (!ch || !Object.keys(ch).length) throw new Error('no children');
    const link = ch[Object.keys(ch)[0]].link;
    if (!link) throw new Error('no link');
    return { success: true, link, token };
  } catch (e) { console.log(`[GoFile] ${e}`); return { success: false, link: '', token: '' }; }
}

// ─── GDirect Extractor ────────────────────────────────────────────────────────

async function gdirectExtract(url) {
  if (url.includes('zee-dl.shop')) {
    try {
      const { text } = await scrapeHtml(url);
      const m = /id=["']vd["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*id=["']vd["']/.exec(text);
      if (m) return [{ server: 'DRIVE', link: m[1] || m[2], type: 'mkv' }];
    } catch {}
    return [];
  }
  const f = await resolveViaApi(url);
  if (!f) return [];
  let c = f;
  if (c.includes('fastdl.zip/dl.php?link=')) c = c.split('fastdl.zip/dl.php?link=')[1];
  return [{ server: 'DRIVE (G-Direct)', link: c, type: 'mkv' }];
}

// ─── FilePress Extractor ──────────────────────────────────────────────────────

async function filepressExtract(url) {
  const streams = [];
  let pl = url;
  if (url.includes('filebee.xyz')) { const f = await resolveViaApi(url); if (f) pl = f; }
  const fm = /(?:filepress\.cloud|filepress\.wiki|filebee\.xyz)\/file\/([a-zA-Z0-9]+)/.exec(pl);
  if (!fm) return [];
  const fid = fm[1];
  const base = (/^(https:\/\/[^/]+)/.exec(pl) || [])[1] || 'https://new1.filepress.cloud';
  try {
    const ir = await fetch(`${base}/api/file/get/${fid}`, { headers: aH({ Referer: pl }) });
    if (!ir.ok) throw new Error(`info ${ir.status}`);
    const fi = await ir.json();
    if (!fi.status) throw new Error('status false');
    const alts = fi.data?.alternativeSource ?? [];
    const s2 = await fetch(`${base}/api/file/downlaod/`, {
      method: 'POST',
      headers: { ...aH(), 'Content-Type': 'application/json', Referer: pl, Cookie: '_gid=GA1.2.44308207.1770031912;', Origin: base },
      body: JSON.stringify({ id: fid, method: 'cloudR2Downlaod', captchaValue: '' }),
    });
    if (!s2.ok) throw new Error(`step2 ${s2.status}`);
    const s2d = await s2.json();
    if (!s2d.status || !s2d.data?.downloadId) throw new Error('no downloadId');
    const s3 = await fetch(`${base}/api/file/downlaod2/`, {
      method: 'POST',
      headers: { ...aH(), 'Content-Type': 'application/json', Referer: pl },
      body: JSON.stringify({ id: s2d.data.downloadId, method: 'cloudR2Downlaod', captchaValue: null }),
    });
    let dl = '';
    if (s3.ok) {
      const d = await s3.json();
      if (d.status && d.data) {
        if (typeof d.data === 'string') dl = d.data;
        else if (Array.isArray(d.data) && d.data.length) dl = d.data[0];
        else if (typeof d.data === 'object') dl = d.data.link || d.data.url || d.data.downloadUrl || '';
      }
    }
    if (dl) streams.push({ server: 'FilePress', link: dl, type: 'mkv', headers: { Referer: pl, Origin: base } });
    for (const a of alts) { if (a.url) streams.push({ server: `FilePress-${a.name}`, link: a.url, type: 'mkv' }); }
  } catch (e) { console.log(`[FilePress] ${e}`); }
  return streams;
}

// ─── Auto-detect ──────────────────────────────────────────────────────────────

async function autoDetect(url) {
  const l = url.toLowerCase();
  if (l.includes('hshare.ink')) {
    const streams = await bypassHshareMulti(url);
    return { extractor: 'HShare', streams: streams.map(s => ({ ...s, type: s.type || 'mkv' })) };
  }
  if (l.includes('vcloud.zip') || l.includes('vcloud.lol'))
    return { extractor: 'VCloud',    streams: await vcloudExtract(url) };
  if (l.includes('gdflix'))
    return { extractor: 'GDFlix',    streams: await gdflixExtract(url) };
  if (l.includes('hubcloud'))
    return { extractor: 'HubCloud',  streams: await hubcloudExtract(url) };
  if (l.includes('filepress') || l.includes('filebee'))
    return { extractor: 'FilePress', streams: await filepressExtract(url) };
  if (l.includes('gofile.io/d/')) {
    const id = url.split('/d/')[1].split('?')[0];
    const r = await gofileExtract(id);
    return { extractor: 'GoFile', streams: r.success
      ? [{ server: 'GoFile', link: r.link, type: 'mkv', headers: { referer: 'https://gofile.io/', cookie: `accountToken=${r.token}` } }]
      : [] };
  }
  if (l.includes('zee-dl.shop') || l.includes('gdirect'))
    return { extractor: 'GDirect', streams: await gdirectExtract(url) };

  // Unknown host — race all extractors simultaneously
  console.log(`[AutoDetect] unknown — racing all extractors`);
  const [v, h, g] = await Promise.allSettled([
    vcloudExtract(url), hubcloudExtract(url), gdirectExtract(url),
  ]);
  if (v.status === 'fulfilled' && v.value.length) return { extractor: 'VCloud (auto)',   streams: v.value };
  if (h.status === 'fulfilled' && h.value.length) return { extractor: 'HubCloud (auto)', streams: h.value };
  if (g.status === 'fulfilled' && g.value.length) return { extractor: 'GDirect (auto)',  streams: g.value };
  return { extractor: 'Unknown', streams: [] };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stream Bypass API</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surf:#111118;--bdr:#1e1e2e;--acc:#7c6af7;--acc2:#f76a8c;--tx:#e8e8f0;--mute:#6b6b85;--grn:#4ade80;--ylw:#fbbf24;--red:#f87171}
body{background:var(--bg);color:var(--tx);font-family:'Syne',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:4rem 1.5rem}
header{text-align:center;margin-bottom:3rem}
.eyebrow{font-family:'Space Mono',monospace;font-size:.75rem;letter-spacing:.2em;color:var(--acc);text-transform:uppercase;margin-bottom:1rem}
h1{font-size:clamp(2rem,6vw,3.5rem);font-weight:800;background:linear-gradient(135deg,var(--acc),var(--acc2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{color:var(--mute);margin-top:.75rem}
.card{background:var(--surf);border:1px solid var(--bdr);border-radius:12px;padding:2rem;width:100%;max-width:760px;margin-bottom:1.5rem}
.card h2{font-size:1.1rem;font-weight:700;margin-bottom:1rem}
.ep{font-family:'Space Mono',monospace;background:#0d0d14;border:1px solid var(--bdr);border-radius:8px;padding:.9rem 1.1rem;font-size:.82rem;color:var(--grn);word-break:break-all;margin-bottom:.6rem}
.badge{display:inline-block;padding:.2rem .55rem;border-radius:999px;font-family:'Space Mono',monospace;font-size:.68rem;margin-right:.3rem}
.bg{background:rgba(74,222,128,.15);color:var(--grn);border:1px solid rgba(74,222,128,.3)}
.bp{background:rgba(251,191,36,.15);color:var(--ylw);border:1px solid rgba(251,191,36,.3)}
table{width:100%;border-collapse:collapse;font-size:.88rem}
td,th{padding:.55rem .7rem;text-align:left;border-bottom:1px solid var(--bdr)}
th{font-weight:700;color:var(--mute);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}
tr:last-child td{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--grn)}
.new{width:6px;height:6px;border-radius:50%;display:inline-block;margin-left:6px;background:var(--acc2);vertical-align:middle}
.row{display:flex;gap:.7rem;margin-top:1.25rem}
input{flex:1;background:#0d0d14;border:1px solid var(--bdr);border-radius:8px;padding:.7rem 1rem;color:var(--tx);font-family:'Space Mono',monospace;font-size:.8rem;outline:none}
input:focus{border-color:var(--acc)}
button{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;border:none;border-radius:8px;padding:.7rem 1.4rem;font-family:'Syne',sans-serif;font-weight:700;cursor:pointer;white-space:nowrap}
#spin{display:none;margin-top:.75rem;color:var(--mute);font-size:.85rem}
#out{display:none;margin-top:1rem;background:#0d0d14;border:1px solid var(--bdr);border-radius:8px;padding:1rem;font-family:'Space Mono',monospace;font-size:.75rem;white-space:pre-wrap;word-break:break-all;max-height:460px;overflow-y:auto}
.err{color:var(--red)}
</style>
</head>
<body>
<header>
  <p class="eyebrow">Express · Render.com</p>
  <h1>Stream Bypass API</h1>
  <p class="sub">Auto-detect · parallel proxy race · hshare.ink bypass · zero paid services</p>
</header>
<div class="card">
  <h2>🔀 Endpoints</h2>
  <div class="ep"><span class="badge bg">GET</span>/bypass?url=&lt;encoded_url&gt;</div>
  <div class="ep"><span class="badge bp">POST</span>/bypass → {"url":"..."}</div>
  <div class="ep"><span class="badge bg">GET</span>/extract/hshare|vcloud|hubcloud|gdflix|gdirect|filepress|gofile?url=</div>
  <div class="ep"><span class="badge bg">GET</span>/health</div>
</div>
<div class="card">
  <h2>⚙️ Extractors</h2>
  <table>
    <thead><tr><th>Extractor</th><th>Detected by</th><th>Servers</th></tr></thead>
    <tbody>
      <tr><td><span class="dot" style="background:var(--acc2)"></span>HShare <span class="new"></span></td><td>hshare.ink</td><td>redirect.php → token POST bypass · file.php → hcloud server list</td></tr>
      <tr><td><span class="dot"></span>VCloud</td><td>vcloud.zip / vcloud.lol</td><td>10Gbps, R2 CDN, Pixeldrain, HubCdn</td></tr>
      <tr><td><span class="dot"></span>HubCloud</td><td>hubcloud.*</td><td>Cf Worker, Pixeldrain, Mega, ZipDisk, CfStorage, FastDl</td></tr>
      <tr><td><span class="dot"></span>GDFlix</td><td>gdflix.*</td><td>ResumeCloud, ResumeBot, G-Drive, Gdrive-Instant, Pixeldrain, GoFile</td></tr>
      <tr><td><span class="dot"></span>GoFile</td><td>gofile.io/d/</td><td>GoFile (with auth token)</td></tr>
      <tr><td><span class="dot"></span>GDirect</td><td>zee-dl.shop</td><td>DRIVE, G-Direct</td></tr>
      <tr><td><span class="dot"></span>FilePress</td><td>filepress.* / filebee.xyz</td><td>FilePress CloudR2, alts</td></tr>
    </tbody>
  </table>
</div>
<div class="card">
  <h2>🧪 Try It</h2>
  <div class="row">
    <input id="u" type="text" placeholder="https://hshare.ink/…  https://hubcloud.foo/…  https://gdflix.dev/…"/>
    <button onclick="go()">Extract</button>
  </div>
  <div id="spin">⚡ Racing proxies in parallel…</div>
  <pre id="out"></pre>
</div>
<script>
async function go(){
  const url=document.getElementById('u').value.trim();if(!url)return;
  const out=document.getElementById('out'),spin=document.getElementById('spin');
  out.style.display='none';out.className='';spin.style.display='block';
  try{
    const r=await fetch('/bypass?url='+encodeURIComponent(url));
    const d=await r.json();
    out.textContent=JSON.stringify(d,null,2);
    if(!d.success||d.count===0)out.classList.add('err');
    out.style.display='block';
  }catch(e){out.textContent='Error: '+e.message;out.classList.add('err');out.style.display='block';}
  finally{spin.style.display='none';}
}
document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/bypass',  handleBypass);
app.post('/bypass', handleBypass);

async function handleBypass(req, res) {
  let target = req.query.url || (req.body && req.body.url);
  if (!target) return res.status(400).json({ error: 'Missing url' });
  try { new URL(target); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  const t0 = Date.now();
  try {
    const { extractor, streams } = await autoDetect(target);
    res.json({ success: true, extractor, url: target, count: streams.length, streams, elapsed_ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e), url: target, elapsed_ms: Date.now() - t0 });
  }
}

app.get('/extract/:type', async (req, res) => {
  const { type } = req.params;
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing url' });
  const t0 = Date.now();
  let streams = [];
  try {
    switch (type) {
      case 'hshare':    streams = (await bypassHshareMulti(target)).map(s => ({ ...s, type: s.type || 'mkv' })); break;
      case 'vcloud':    streams = await vcloudExtract(target);    break;
      case 'hubcloud':  streams = await hubcloudExtract(target);  break;
      case 'gdflix':    streams = await gdflixExtract(target);    break;
      case 'gdirect':   streams = await gdirectExtract(target);   break;
      case 'filepress': streams = await filepressExtract(target); break;
      case 'gofile': {
        const id = target.includes('/d/') ? target.split('/d/')[1].split('?')[0] : target;
        const r = await gofileExtract(id);
        if (r.success) streams = [{ server: 'GoFile', link: r.link, type: 'mkv', headers: { referer: 'https://gofile.io/', cookie: `accountToken=${r.token}` } }];
        break;
      }
      default: return res.status(400).json({ error: `Unknown extractor: ${type}` });
    }
    res.json({ success: true, extractor: type, url: target, count: streams.length, streams, elapsed_ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e), elapsed_ms: Date.now() - t0 });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    routes: ['GET /', 'GET /health', 'GET|POST /bypass?url=', 'GET /extract/{hshare,vcloud,hubcloud,gdflix,gdirect,filepress,gofile}?url='],
  });
});

app.listen(PORT, () => console.log(`Stream Bypass API running on port ${PORT}`));
