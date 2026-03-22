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

// ─── Keep-alive agents ────────────────────────────────────────────────────────
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, rejectUnauthorized: false });
const agent = u => u.startsWith('https') ? httpsAgent : httpAgent;

// ─── Pre-warm DNS ─────────────────────────────────────────────────────────────
const WARMUP_HOSTS = ['https://hshare.ink', 'https://hcloud.shop', 'https://api.allorigins.win', 'https://corsproxy.io'];
Promise.allSettled(WARMUP_HOSTS.map(h => fetch(h, { method: 'HEAD', agent: agent(h) }).catch(() => {})));

// =============================================================================
// ═══════════════════════  HINDMOVIE SCRAPER MODULE  ══════════════════════════
// =============================================================================

const HIND_BASE = 'https://hindmovie.ltd';

const HIND_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function hindFetch(url, followRedirects = true) {
  try {
    const res = await fetch(url, {
      headers: HIND_HEADERS,
      redirect: followRedirects ? 'follow' : 'manual',
      agent: agent(url),
    });
    if (![200, 301, 302].includes(res.status)) return { html: null, finalUrl: url };
    return { html: await res.text(), finalUrl: res.url ?? url };
  } catch {
    return { html: null, finalUrl: url };
  }
}

function hindStripTags(html) { return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function hindDecodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}

function hindParseArticles(html) {
  const articles = [];
  for (const block of html.match(/<article[\s\S]*?<\/article>/gi) || []) {
    const m = block.match(/class="entry-title"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
           || block.match(/rel="bookmark"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (m) articles.push({ link: hindDecodeEntities(m[1]), title: hindStripTags(m[2]) });
  }
  return articles;
}

function hindParseDownloadButtons(html) {
  const links = [];
  const re = /<a[^>]+href="(https?:\/\/mvlink\.site[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ctx = html.slice(Math.max(0, m.index - 150), m.index + 150);
    const qm  = /(4K|2160p|1080p|720p|480p)/i.exec(ctx);
    links.push({ quality: qm ? qm[1] : 'Unknown', link: hindDecodeEntities(m[1]), text: hindStripTags(m[2]).trim() });
  }
  return links;
}

function hindParseEpisodes(html) {
  const episodes = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?Episode\s*\d+[\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null)
    episodes.push({ title: hindStripTags(m[2]).trim(), link: hindDecodeEntities(m[1]) });
  if (!episodes.length) {
    const glm = /<a[^>]+href="([^"]+)"[^>]*>\s*Get\s*Links\s*<\/a>/i.exec(html);
    if (glm) episodes.push({ title: 'Movie Link', link: hindDecodeEntities(glm[1]) });
  }
  return episodes;
}

function hindParseHshare(html, finalUrl) {
  if (finalUrl.includes('hshare.ink')) return finalUrl;
  const m = /<a[^>]+href="(https?:\/\/hshare\.ink[^"]*)"[^>]*>/i.exec(html);
  return m ? hindDecodeEntities(m[1]) : null;
}

function hindParseHcloud(html) {
  const m = /<a[^>]+href="([^"]+)"[^>]*>\s*HPage\s*<\/a>/i.exec(html);
  return m ? hindDecodeEntities(m[1]) : null;
}

function hindParseServers(html) {
  const servers = {};
  for (let i = 1; i <= 6; i++) {
    const m = new RegExp(`id="download-btn${i}"[^>]+href="([^"]+)"|href="([^"]+)"[^>]+id="download-btn${i}"`, 'i').exec(html);
    if (m) servers[`Server ${i}`] = hindDecodeEntities(m[1] || m[2]);
  }
  if (!Object.keys(servers).length) {
    const re = /<a[^>]+href="([^"]+)"[^>]*>\s*(Server\s*\d+)\s*<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null)
      servers[m[2].trim()] = hindDecodeEntities(m[1]);
  }
  return servers;
}

async function hindResolveChain(mvlinkUrl) {
  const { html: mvHtml, finalUrl } = await hindFetch(mvlinkUrl);
  if (!mvHtml) return {};
  const hshareUrl = hindParseHshare(mvHtml, finalUrl);
  if (!hshareUrl) return {};
  const { html: hshareHtml } = await hindFetch(hshareUrl);
  if (!hshareHtml) return {};
  const hcloudUrl = hindParseHcloud(hshareHtml);
  if (!hcloudUrl) return {};
  const { html: hcloudHtml } = await hindFetch(hcloudUrl);
  if (!hcloudHtml) return {};
  return hindParseServers(hcloudHtml);
}

async function hindScrape(query, season, episode) {
  const t0 = Date.now();
  const targetEp = episode != null ? `Episode ${String(episode).padStart(2, '0')}` : null;

  const { html: searchHtml } = await hindFetch(`${HIND_BASE}/?s=${encodeURIComponent(query)}`);
  if (!searchHtml) return { ok: false, error: 'Search request failed' };

  const articles = hindParseArticles(searchHtml);
  if (!articles.length) return { ok: false, error: `No results found for: ${query}` };

  const item = articles[0];
  const { html: itemHtml } = await hindFetch(item.link);
  if (!itemHtml) return { ok: false, error: 'Could not load content page' };

  const qualityButtons = hindParseDownloadButtons(itemHtml);
  if (!qualityButtons.length) return { ok: false, error: 'No download links found on page' };

  const mvResults = await Promise.all(qualityButtons.map(qb => hindFetch(qb.link)));

  const toResolve = [];
  for (let i = 0; i < mvResults.length; i++) {
    const { html: mvHtml } = mvResults[i];
    if (!mvHtml) continue;
    for (const ep of hindParseEpisodes(mvHtml)) {
      if (targetEp && !ep.title.includes(targetEp)) continue;
      toResolve.push({ ep, quality: qualityButtons[i].quality });
    }
  }

  if (!toResolve.length)
    return { ok: false, error: targetEp ? `Episode "${targetEp}" not found` : 'No episodes found' };

  const resolved = await Promise.all(
    toResolve.map(async ({ ep, quality }) => ({
      title: ep.title, quality, servers: await hindResolveChain(ep.link),
    }))
  );

  const grouped = {};
  for (const r of resolved)
    (grouped[r.quality] = grouped[r.quality] || []).push({ title: r.title, servers: r.servers });

  return {
    ok: true, query,
    found: item.title, source: item.link,
    target: targetEp || 'all',
    elapsed_ms: Date.now() - t0,
    results: grouped,
  };
}

// =============================================================================
// ═══════════════════════  STREAM BYPASS MODULE  ══════════════════════════════
// =============================================================================

const CF_PROTECTED = [
  'hubcloud.foo','hubcloud.art','hubcloud.bond','hubcloud.ltd','hubcloud.men',
  'hubcloud.bar','hubcloud.media','hubcloud.lol','hubcloud.cam','hubcloud.skin',
  'hubcloud.hair','hubcloud.vip','hubcloud.luxury','hubcloud.top',
  'gdflix.dev','gdflix.sbs','gdflix.xyz','gdflix.lol','gdflix.top',
  'hshare.ink','hcloud.shop',
];

function isProtected(url) {
  try {
    const h = new URL(url).hostname;
    return CF_PROTECTED.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

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
    wrap(0, fetch(url, { headers: hdrs, redirect: 'follow', signal: controllers[0].signal, agent: ag })
      .then(r => { if (r.status === 403 || r.status === 503) throw new Error('CF'); if (!r.ok) throw new Error('d' + r.status); return r.text(); })),
    wrap(1, fetch(`https://api.allorigins.win/get?url=${enc}`, { headers: aH(), signal: controllers[1].signal, agent: httpsAgent })
      .then(r => r.ok ? r.json() : Promise.reject('ao' + r.status))
      .then(d => d.contents || Promise.reject('ao empty'))),
    wrap(2, fetch(`https://api.allorigins.win/raw?url=${enc}`, { headers: aH(), signal: controllers[2].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('aor' + r.status))),
    wrap(3, fetch(`https://corsproxy.io/?${enc}`, { headers: hdrs, signal: controllers[3].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('cp' + r.status))),
    wrap(4, fetch(`https://api.codetabs.com/v1/proxy?quest=${enc}`, { headers: hdrs, signal: controllers[4].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('ct' + r.status))),
    wrap(5, fetch(`https://thingproxy.freeboard.io/fetch/${url}`, { headers: hdrs, signal: controllers[5].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('tp' + r.status))),
    wrap(6, fetch(`https://proxy.cors.sh/${url}`, { headers: { ...hdrs, 'x-cors-api-key': 'temp_test' }, signal: controllers[6].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('cs' + r.status))),
    wrap(7, fetch(`https://cors-anywhere.azurewebsites.net/${url}`, { headers: { ...hdrs, 'X-Requested-With': 'XMLHttpRequest' }, signal: controllers[7].signal, agent: httpsAgent })
      .then(r => r.ok ? r.text() : Promise.reject('ca' + r.status))),
    wrap(8, fetch(`https://api.allorigins.win/get?url=${enc}&charset=utf-8`, { headers: aH(), signal: controllers[8].signal, agent: httpsAgent })
      .then(r => r.ok ? r.json() : Promise.reject('ao2' + r.status))
      .then(d => d.contents || Promise.reject('ao2 empty'))),
  ];

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

function parseLinks(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hM = /\bhref=["']([^"']+)["']/i.exec(m[1]);
    const cM = /\bclass=["']([^"']+)["']/i.exec(m[1]);
    const iM = /\bid=["']([^"']+)["']/i.exec(m[1]);
    if (!hM) continue;
    out.push({
      href: hM[1].trim(),
      classes: cM ? cM[1] : '',
      id: iM ? iM[1] : '',
      text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

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

const RAPI = 'https://ssbackend-2r7z.onrender.com/api/redirect';
async function resolveViaApi(url) {
  try {
    const r = await fetch(`${RAPI}?url=${encodeURIComponent(url)}`, { headers: aH() });
    if (!r.ok) return null;
    return (await r.json()).finalUrl ?? null;
  } catch { return null; }
}

function extractFinalFromHtml(html) {
  const reurlM = /var\s+reurl\s*=\s*["']([^"']+)["']/.exec(html);
  if (reurlM && reurlM[1].startsWith('http')) return reurlM[1];
  const locM = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(html);
  if (locM && locM[1].startsWith('http') && !locM[1].includes('hshare')) return locM[1];
  for (const el of parseLinks(html)) {
    if (!el.href.startsWith('http') || el.href.includes('hshare')) continue;
    const isDownload =
      el.text.toLowerCase().includes('download') || el.text.toLowerCase().includes('get link') ||
      el.text.toLowerCase().includes('click here') || el.classes.includes('btn-success') ||
      el.classes.includes('btn-primary') || el.classes.includes('btn-warning') ||
      /\.(mkv|mp4|zip|rar)(\?|$)/i.test(el.href) || el.href.includes('drive.google') ||
      el.href.includes('googleapis') || el.href.includes('r2.dev') ||
      el.href.includes('pixeldrain') || el.href.includes('gofile.io');
    if (isDownload) return el.href;
  }
  return null;
}

function decodeHcloudRedirect(hcloudUrl) {
  try {
    const urlParam = new URL(hcloudUrl).searchParams.get('url');
    if (!urlParam) return null;
    return Buffer.from(decodeURIComponent(urlParam), 'base64').toString('utf8');
  } catch { return null; }
}

function decodeHcloudDirect(directUrl) {
  try {
    const urlParam = new URL(directUrl).searchParams.get('url');
    if (!urlParam) return null;
    const decoded = Buffer.from(decodeURIComponent(urlParam), 'base64').toString('utf8');
    if (decoded.startsWith('http') && !decoded.includes('hcloud.shop')) return decoded;
    return null;
  } catch { return null; }
}

function scrapeHcloudButtons(html) {
  const results = [];
  const seen = new Set();
  const tagRe = /<a\s([^<]*?id=["']download-btn(\d+)["'][^<]*?)>/gi;
  let tm;
  while ((tm = tagRe.exec(html)) !== null) {
    const hrefM = /\bhref=["']([^"']+)["']/i.exec(tm[1]);
    if (!hrefM) continue;
    const link = hrefM[1].trim();
    if (!link.startsWith('http') || link.includes('hcloud.shop') || seen.has(link)) continue;
    seen.add(link);
    results.push({ num: parseInt(tm[2], 10), server: `Server ${tm[2]}`, link });
  }
  if (!results.length) {
    const parts = html.split(/id=["']download-btn/i);
    for (let i = 1; i < parts.length; i++) {
      const numM = /^(\d+)["']/.exec(parts[i]);
      if (!numM) continue;
      const before = parts[i - 1];
      const hrefM = /href=["']([^"']+)["'][^<]*$/.exec(before);
      if (hrefM) {
        const link = hrefM[1].trim();
        if (link.startsWith('http') && !link.includes('hcloud.shop') && !seen.has(link)) {
          seen.add(link); results.push({ num: parseInt(numM[1], 10), server: `Server ${numM[1]}`, link }); continue;
        }
      }
      const hrefFwd = /href=["']([^"']+)["']/.exec(parts[i]);
      if (hrefFwd) {
        const link = hrefFwd[1].trim();
        if (link.startsWith('http') && !link.includes('hcloud.shop') && !seen.has(link)) {
          seen.add(link); results.push({ num: parseInt(numM[1], 10), server: `Server ${numM[1]}`, link });
        }
      }
    }
  }
  results.sort((a, b) => a.num - b.num);
  return results.map(({ server, link }) => ({ server, link, type: 'mkv' }));
}

async function fetchHcloudDirectPage(directUrl) {
  console.log(`[hcloud/direct-page] ${directUrl.slice(0, 120)}`);
  const seen = new Set();
  const servers = [];
  const add = (serverName, link) => {
    if (!link || !link.startsWith('http') || seen.has(link)) return;
    seen.add(link); servers.push({ server: serverName, link, type: 'mkv' });
  };
  const instantUrl = decodeHcloudDirect(directUrl);
  if (instantUrl) add('Server 1', instantUrl);
  let html = '';
  try {
    const enc = encodeURIComponent(directUrl);
    const hdrs = bH({ Referer: 'https://hshare.ink/' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const directFetch = fetch(directUrl, { headers: hdrs, redirect: 'follow', signal: ac.signal, agent: httpsAgent })
      .then(async r => { if (!r.ok) throw new Error(`direct ${r.status}`); const t = await r.text(); if (t.length < 200) throw new Error('direct too short'); return t; });
    const proxyFetch = raceProxies(directUrl, 'https://hshare.ink/');
    html = await Promise.any([directFetch, proxyFetch]);
    clearTimeout(timer);
  } catch (e) {
    console.log(`[hcloud/direct-page] all fetches failed: ${e.message}`);
    return servers.length ? servers : [{ server: 'HCloud', link: directUrl, type: 'mkv' }];
  }
  const btnResults = scrapeHcloudButtons(html);
  for (const s of btnResults) add(s.server, s.link);
  if (servers.length <= 1) {
    for (const el of parseLinks(html)) {
      if (!el.href.startsWith('http') || el.href.includes('hcloud.shop')) continue;
      if (el.classes.split(/\s+/).includes('button') || /^server\s*\d*$/i.test(el.text.trim()))
        add(el.text.trim() || 'Server', el.href);
    }
  }
  if (servers.length <= 1) {
    const workerRe = /(https?:\/\/[^\s"'<>\\]+\.workers\.dev\/[^\s"'<>\\]*)/g;
    let wm; let idx = 2;
    while ((wm = workerRe.exec(html)) !== null) {
      const link = wm[1].replace(/['"<>\\]/g, '');
      if (!seen.has(link)) add(`Server ${idx++}`, link);
    }
  }
  return servers.length ? servers : [{ server: 'HCloud', link: directUrl, type: 'mkv' }];
}

async function bypassHcloud(url) {
  console.log(`[hcloud] entry: ${url.slice(0, 120)}`);
  try {
    let directUrl = url;
    if (url.includes('hcloud.shop') && url.includes('redirect.php')) {
      const decoded = decodeHcloudRedirect(url);
      if (decoded && decoded.startsWith('http')) directUrl = decoded;
    }
    return await fetchHcloudDirectPage(directUrl);
  } catch (e) {
    return [{ server: 'HCloud', link: url, type: 'mkv' }];
  }
}

async function parseHshareDownloadPage(html, pageUrl) {
  const streams = [];
  const futs = [];
  for (const el of parseLinks(html)) {
    const href = el.href;
    const text = el.text.trim();
    if (!href || !href.startsWith('http')) continue;
    if (href.includes('hshare.ink') || href.startsWith('javascript') || href.startsWith('#')) continue;
    if (href.includes('hcloud.shop')) { futs.push(bypassHcloud(href).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' })))); continue; }
    if (href.includes('gdirect.sbs') || href.includes('gdirect.in') || (text.toLowerCase() === 'gdirect' && href.includes('redirect.php'))) {
      futs.push(gdirectExtract(href).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' })))); continue;
    }
    if (href.includes('gdtot')) { streams.push({ server: 'GDTOT', link: href, type: 'mkv' }); continue; }
    if (href.includes('pixeld')) { streams.push({ server: 'Pixeldrain', link: normPixel(href), type: 'mkv' }); continue; }
    const isDownload = el.classes.includes('btn-success') || el.classes.includes('btn-danger') ||
      el.classes.includes('btn-primary') || el.classes.includes('btn-info') || el.classes.includes('btn-warning') ||
      /download|server|drive/i.test(text);
    if (isDownload) streams.push({ server: text || 'Server', link: href, type: 'mkv' });
  }
  await Promise.all(futs);
  return streams;
}

async function bypassHshareFilePage(url) {
  let html = '';
  try { ({ text: html } = await scrapeHtml(url, 'https://hshare.ink/')); }
  catch { return [{ server: 'HShare', link: url, type: 'mkv' }]; }
  const streams = await parseHshareDownloadPage(html, url);
  return streams.length ? streams : [{ server: 'HShare', link: url, type: 'mkv' }];
}

async function bypassHshareRedirect(url) {
  let html = '';
  try { ({ text: html } = await scrapeHtml(url, 'https://hshare.ink/')); }
  catch { return [{ server: 'HShare', link: url, type: 'mkv' }]; }

  const tokenM = /(?:name=["']token["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']token["'])/i.exec(html);
  const actionM = /<form[^>]*action=["']([^"']+)["']/i.exec(html);
  const waitM   = /var\s+(?:seconds|countdown|timer)\s*=\s*(\d+)/.exec(html);
  const waitSecs = waitM ? Math.min(parseInt(waitM[1]), 15) : 0;

  if (tokenM) {
    const token  = tokenM[1] || tokenM[2];
    const action = actionM ? (actionM[1].startsWith('/') ? new URL(actionM[1], url).href : actionM[1]) : url;
    if (waitSecs > 0) await sleep(waitSecs * 1000);
    try {
      const body = new URLSearchParams({ token });
      const goM = /name=["']go["'][^>]*value=["']([^"']+)["']/i.exec(html);
      if (goM) body.append('go', goM[1]);
      const r = await fetch(action, { method: 'POST', headers: { ...bH({ Referer: url }), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'follow' });
      const resultHtml = await r.text();
      if (r.url && r.url !== action) {
        if (r.url.includes('hshare.ink')) return bypassHshareFilePage(r.url);
        if (r.url.includes('hcloud.shop')) return bypassHcloud(r.url);
      }
      if (resultHtml.includes('hcloud.shop') || resultHtml.includes('btn-group') || resultHtml.includes('btn btn-')) {
        const inlineStreams = await parseHshareDownloadPage(resultHtml, r.url || action);
        if (inlineStreams.length) return inlineStreams;
      }
      const filephpM = /(https?:\/\/hshare\.ink\/file\.php[^"'<>\s]+)/.exec(resultHtml);
      if (filephpM) return bypassHshareFilePage(filephpM[1]);
      const final = extractFinalFromHtml(resultHtml);
      if (final && !final.includes('hshare')) return [{ server: 'HShare', link: final, type: 'mkv' }];
    } catch (e) { console.log(`[hshare/redirect] POST failed: ${e.message}`); }
  }

  const jsPatterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
    /window\.location\.replace\(["']([^"']+)["']\)/,
    /content=["']\d+;\s*url=([^"'\s>]+)/i,
  ];
  for (const p of jsPatterns) {
    const m = p.exec(html);
    if (m && m[1].startsWith('http') && !m[1].includes('hshare')) {
      const target = m[1].replace(/['"]/g, '').trim();
      if (target.includes('hcloud.shop')) return bypassHcloud(target);
      return [{ server: 'HShare', link: target, type: 'mkv' }];
    }
  }
  const filephpM = /(https?:\/\/hshare\.ink\/file\.php[^"'<>\s]+)/.exec(html);
  if (filephpM) return bypassHshareFilePage(filephpM[1]);
  for (const el of parseLinks(html)) {
    if (!el.href.startsWith('http') || el.href.includes('hshare.ink')) continue;
    if (el.href.includes('hcloud.shop')) return bypassHcloud(el.href);
  }
  return [{ server: 'HShare', link: url, type: 'mkv' }];
}

async function bypassHshareMulti(url) {
  if (url.includes('/file.php'))     return bypassHshareFilePage(url);
  if (url.includes('/redirect.php')) return bypassHshareRedirect(url);
  return bypassHshareFilePage(url);
}

async function vcloudExtract(url) {
  const streams = [];
  let mid = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const { text } = await scrapeHtml(url);
      mid = reGet(text, /var\s+url\s*=\s*'([^']+)'/) ?? reGet(text, /const\s+url\s*=\s*'([^']+)'/) ??
            reGet(text, /url\s*=\s*'([^']+)'/) ?? reGet(text, /'(https?:\/\/[^']*hubcloud\.php[^']*)'/);
      if (mid) break;
    } catch { if (i === 3) return []; await sleep(i * 1000); }
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
      else if (lnk.includes('.r2.dev'))    streams.push({ server: 'R2 CDN', link: lnk, type: 'mkv' });
      else if (el.classes.includes('btn-success')) streams.push({ server: 'Server 1', link: lnk, type: 'mkv' });
      else if (lnk.includes('download') || /\.(mkv|mp4)(\?|$)/.test(lnk)) streams.push({ server: 'VCloud', link: lnk, type: 'mkv' });
    }
    await Promise.all(futs);
  } catch (e) { console.log(`[VCloud] step2: ${e}`); }
  return streams;
}

async function processHubButtons(html, pageUrl) {
  const streams = []; const futs = [];
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
  return streams;
}

async function hubGamerxyt(link, refOrigin) {
  const streams = []; let html;
  try { ({ text: html } = await scrapeHtml(link, refOrigin)); } catch { return []; }
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
    if (h.includes('fastdl')) { streams.push({ server: 'FastDl', link: h, type: 'mkv' }); continue; }
    if (h.includes('gdflix')) { streams.push({ server: 'GDFlix', link: h, type: 'mkv' }); continue; }
  }
  await Promise.all(futs);
  return streams;
}

async function hubcloudExtract(url) {
  let origin = ''; try { origin = new URL(url).origin; } catch {}
  let html1 = '';
  try { ({ text: html1 } = await scrapeHtml(url)); }
  catch (e) { return [{ server: '_error', link: String(e), type: 'error' }]; }

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
    const btns = parseLinks(html1).filter(l => l.classes.includes('btn-success') || l.classes.includes('btn-danger') || l.classes.includes('btn-secondary'));
    if (btns.length) return processHubButtons(html1, url);
    const any = parseLinks(html1).find(l => l.href.includes('gamerxyt') || l.href.includes('hubcloud') || l.href.includes('vcloud'));
    vcloudLink = any ? any.href : url;
  }

  if (vcloudLink.startsWith('/')) vcloudLink = `${origin}${vcloudLink}`;
  if (vcloudLink.includes('gamerxyt.com') && vcloudLink.includes('hubcloud.php')) return hubGamerxyt(vcloudLink, origin);

  let html2 = '';
  try { ({ text: html2 } = await scrapeHtml(vcloudLink, url)); }
  catch { return processHubButtons(html1, url); }

  const gxM = /href="(https:\/\/[^"]*gamerxyt\.com[^"]*hubcloud\.php[^"]*)"/.exec(html2);
  if (gxM) return hubGamerxyt(gxM[1], origin);
  return processHubButtons(html2, vcloudLink);
}

async function gdflixExtract(url) {
  const streams = [];
  const origin = new URL(url).origin;
  let html;
  try { ({ text: html } = await scrapeHtml(url)); }
  catch { return []; }

  const resumeHref  = hrefByClass(html, 'btn-secondary');
  const seedHref    = hrefByClass(html, 'btn-danger');
  const pixelHref   = hrefByClass(html, 'btn-success');
  const gofileLinks = parseLinks(html).filter(l => l.classes.includes('btn-outline-info'));
  const hshareLinks = parseLinks(html).filter(l => l.href.includes('hshare.ink'));
  const tasks = [];

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
              method: 'POST', headers: { ...bH({ Referer: resumeHref }), 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'PHPSESSID=7e9658ce7c805dab5bbcea9046f7f308' }, body: body.toString(),
            });
            if (r.ok) { const d = await r.json(); if (d.url) streams.push({ server: 'ResumeBot', link: d.url, type: 'mkv' }); }
          }
        } catch {}
      } else {
        try {
          const ru = resumeHref.startsWith('http') ? resumeHref : `${origin}${resumeHref}`;
          const { text: rc } = await scrapeHtml(ru);
          const rl = hrefByClass(rc, 'btn-success');
          if (rl) streams.push({ server: 'ResumeCloud', link: rl, type: 'mkv' });
        } catch {}
      }
    })());
  }

  if (seedHref) {
    tasks.push((async () => {
      try {
        if (seedHref.includes('instant.busycdn.xyz') && seedHref.includes('::')) {
          const f = await resolveViaApi(seedHref);
          if (f) {
            const c = f.includes('fastcdn-dl.pages.dev/?url=') ? decodeURIComponent(f.split('fastcdn-dl.pages.dev/?url=')[1]) : f;
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
            method: 'POST', headers: { ...bH(), 'x-token': `${su.protocol}//${su.host}/api`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
          });
          if (r.ok) { const d = await r.json(); if (!d.error && d.url) streams.push({ server: 'Gdrive-Instant', link: d.url, type: 'mkv' }); }
        }
      } catch {}
    })());
  }

  if (pixelHref?.includes('pixeldrain')) streams.push({ server: 'Pixeldrain', link: normPixel(pixelHref), type: 'mkv' });
  for (const el of hshareLinks) tasks.push(bypassHshareMulti(el.href).then(ss => ss.forEach(s => streams.push({ ...s, type: 'mkv' }))));
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
        } catch {}
      })()); break;
    }
  }

  await Promise.all(tasks);
  return streams;
}

async function gofileExtract(id) {
  try {
    const ar = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: aH() });
    if (!ar.ok) throw new Error('account');
    const ad = await ar.json();
    if (ad.status !== 'ok') throw new Error('account failed');
    const token = ad.data.token;
    const cr = await fetch(`https://api.gofile.io/contents/${id}?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1`,
      { headers: aH({ Authorization: `Bearer ${token}`, 'x-website-token': '4fd6sg89d7s6', origin: 'https://gofile.io', referer: 'https://gofile.io/' }) });
    if (!cr.ok) throw new Error('content');
    const cd = await cr.json();
    if (cd.status !== 'ok') throw new Error('content failed');
    const ch = cd.data?.children;
    if (!ch || !Object.keys(ch).length) throw new Error('no children');
    const link = ch[Object.keys(ch)[0]].link;
    if (!link) throw new Error('no link');
    return { success: true, link, token };
  } catch { return { success: false, link: '', token: '' }; }
}

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
    if (!ir.ok) throw new Error('info');
    const fi = await ir.json();
    if (!fi.status) throw new Error('status false');
    const alts = fi.data?.alternativeSource ?? [];
    const s2 = await fetch(`${base}/api/file/downlaod/`, {
      method: 'POST', headers: { ...aH(), 'Content-Type': 'application/json', Referer: pl, Cookie: '_gid=GA1.2.44308207.1770031912;', Origin: base },
      body: JSON.stringify({ id: fid, method: 'cloudR2Downlaod', captchaValue: '' }),
    });
    if (!s2.ok) throw new Error('step2');
    const s2d = await s2.json();
    if (!s2d.status || !s2d.data?.downloadId) throw new Error('no downloadId');
    const s3 = await fetch(`${base}/api/file/downlaod2/`, {
      method: 'POST', headers: { ...aH(), 'Content-Type': 'application/json', Referer: pl },
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
    for (const a of alts) if (a.url) streams.push({ server: `FilePress-${a.name}`, link: a.url, type: 'mkv' });
  } catch (e) { console.log(`[FilePress] ${e}`); }
  return streams;
}

async function autoDetect(url) {
  const l = url.toLowerCase();
  if (l.includes('hshare.ink'))
    return { extractor: 'HShare', streams: (await bypassHshareMulti(url)).map(s => ({ ...s, type: s.type || 'mkv' })) };
  if (l.includes('hcloud.shop'))
    return { extractor: 'HCloud', streams: (await bypassHcloud(url)).map(s => ({ ...s, type: s.type || 'mkv' })) };
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
  const [v, h, g] = await Promise.allSettled([vcloudExtract(url), hubcloudExtract(url), gdirectExtract(url)]);
  if (v.status === 'fulfilled' && v.value.length) return { extractor: 'VCloud (auto)',   streams: v.value };
  if (h.status === 'fulfilled' && h.value.length) return { extractor: 'HubCloud (auto)', streams: h.value };
  if (g.status === 'fulfilled' && g.value.length) return { extractor: 'GDirect (auto)',  streams: g.value };
  return { extractor: 'Unknown', streams: [] };
}

// =============================================================================
// ═══════════════════════════════  ROUTES  ════════════════════════════════════
// =============================================================================

// ─── Root — unified API docs ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Unified Stream API',
    modules: {
      hindmovie: {
        description: 'Search and resolve download links from hindmovie.ltd',
        endpoints: {
          'GET /hindmovie/search?q=<title>': 'Resolve all download links',
          'GET /hindmovie/search?q=<title>&s=1&e=7': 'Resolve specific episode',
        },
        examples: [
          '/hindmovie/search?q=Queen+Of+Tears',
          '/hindmovie/search?q=Queen+Of+Tears&s=1&e=16',
          '/hindmovie/search?q=Avengers+Endgame',
        ],
      },
      bypass: {
        description: 'Bypass hshare/hcloud/vcloud/hubcloud/gdflix download gates',
        endpoints: {
          'GET  /bypass?url=<encoded>': 'Auto-detect and bypass any supported URL',
          'POST /bypass': '{ "url": "..." }',
          'GET  /extract/:type?url=': 'Use a specific extractor directly',
        },
        extractors: ['hshare', 'hcloud', 'vcloud', 'hubcloud', 'gdflix', 'gdirect', 'filepress', 'gofile'],
      },
    },
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── HindMovie routes  (/hindmovie/*) ────────────────────────────────────────
app.get('/hindmovie', (req, res) => {
  res.json({
    usage: 'GET /hindmovie/search?q=<title>  or  GET /hindmovie/search?q=<title>&s=1&e=7',
    examples: ['/hindmovie/search?q=Queen+Of+Tears', '/hindmovie/search?q=Queen+Of+Tears&s=1&e=16'],
  });
});

app.get('/hindmovie/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Missing query parameter: q' });
  const s = req.query.s ? parseInt(req.query.s, 10) : null;
  const e = req.query.e ? parseInt(req.query.e, 10) : null;
  const t0 = Date.now();
  try {
    const result = await hindScrape(q, s, e);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), elapsed_ms: Date.now() - t0 });
  }
});

// ─── Stream Bypass routes  (/bypass, /extract/*) ─────────────────────────────
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
      case 'hcloud':    streams = (await bypassHcloud(target)).map(s => ({ ...s, type: s.type || 'mkv' })); break;
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

// ─── 404 catch-all ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    routes: [
      'GET /',
      'GET /health',
      'GET /hindmovie/search?q=&s=&e=',
      'GET|POST /bypass?url=',
      'GET /extract/{hshare,hcloud,vcloud,hubcloud,gdflix,gdirect,filepress,gofile}?url=',
    ],
  });
});

app.listen(PORT, () => console.log(`Unified Stream API running on port ${PORT}`));
