/**
 * ============================================================
 *  Stream Bypass Worker — Cloudflare Workers
 *  /bypass?url=   Auto-detects: VCloud · HubCloud · GDFlix
 *                               GoFile · GDirect · FilePress
 *
 *  SPEED: proxies are raced in PARALLEL — fastest wins.
 *  CF-BYPASS: hubcloud.*, gdflix.* routed through free proxy race.
 * ============================================================
 */

// ─── CF-Protected domain list ─────────────────────────────────────────────────

const CF_PROTECTED = [
  'hubcloud.foo','hubcloud.art','hubcloud.bond','hubcloud.ltd','hubcloud.men',
  'hubcloud.bar','hubcloud.media','hubcloud.lol','hubcloud.cam','hubcloud.skin',
  'hubcloud.hair','hubcloud.vip','hubcloud.luxury','hubcloud.top',
  'gdflix.dev','gdflix.sbs','gdflix.xyz','gdflix.lol','gdflix.top',
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

// ─── Parallel proxy race ──────────────────────────────────────────────────────
//
//  ALL proxies fire at the same time. First one that returns
//  valid HTML (>300 chars, not an error page) wins and the rest
//  are discarded.  This makes CF-protected fetches as fast as the
//  fastest available proxy rather than the sum of all retries.

async function raceProxies(url) {
  // Each strategy returns a Promise<string> or rejects
  const strategies = [
    // 1. allorigins
    fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { headers: aH() })
      .then(r => r.ok ? r.json() : Promise.reject('allorigins ' + r.status))
      .then(d => {
        if (!d.contents || d.contents.length < 300) throw new Error('allorigins empty');
        return d.contents;
      }),

    // 2. corsproxy.io
    fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { headers: bH() })
      .then(r => r.ok ? r.text() : Promise.reject('corsproxy ' + r.status))
      .then(t => { if (t.length < 300) throw new Error('corsproxy empty'); return t; }),

    // 3. codetabs
    fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, { headers: bH() })
      .then(r => r.ok ? r.text() : Promise.reject('codetabs ' + r.status))
      .then(t => { if (t.length < 300) throw new Error('codetabs empty'); return t; }),

    // 4. htmlreceiver via thingproxy
    fetch(`https://thingproxy.freeboard.io/fetch/${url}`, { headers: bH() })
      .then(r => r.ok ? r.text() : Promise.reject('thingproxy ' + r.status))
      .then(t => { if (t.length < 300) throw new Error('thingproxy empty'); return t; }),

    // 5. Direct (may work if site only blocks by IP range, not all CF)
    fetch(url, { headers: bH(), redirect: 'follow' })
      .then(r => {
        if (r.status === 403 || r.status === 503) throw new Error('direct CF block');
        if (!r.ok) throw new Error('direct ' + r.status);
        return r.text();
      })
      .then(t => { if (t.length < 300) throw new Error('direct empty'); return t; }),
  ];

  // Promise.any returns first fulfillment
  return Promise.any(strategies).catch(() => {
    throw new Error(`All proxy strategies failed for ${url}`);
  });
}

/**
 * scrapeHtml — smart fetch:
 * - Protected domains → parallel proxy race
 * - Normal domains → direct fetch
 */
async function scrapeHtml(url, referer = null) {
  if (isProtected(url)) {
    console.log(`[Proxy] racing ${url}`);
    const text = await raceProxies(url);
    console.log(`[Proxy] got ${text.length} chars`);
    return { text, finalUrl: url };
  }
  // Direct fetch for normal domains
  const r = await fetch(url, { headers: bH(referer ? { Referer: referer } : {}), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return { text: await r.text(), finalUrl: r.url };
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

// Match class even when multiple classes exist: "btn btn-secondary" includes "btn-secondary"
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
    return p.slice(0, -2).join('/') + '/api/file/' + p.at(-1);
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
      console.log(`[VCloud] step1/${i}: ${e}`);
      if (i === 3) return [];
      await sleep(i * 1000);
    }
  }
  if (!mid) return [];
  console.log(`[VCloud] mid: ${mid}`);

  try {
    const { text } = await scrapeHtml(mid, 'https://vcloud.lol/');
    const excl = ['google.com/search','t.me/','telegram.me/','whatsapp.com','facebook.com','twitter.com','instagram.com'];
    const futs = [];
    for (const el of parseLinks(text)) {
      let lnk = el.href;
      if (!lnk || lnk.startsWith('#') || lnk.startsWith('javascript')) continue;
      if (excl.some(p => lnk.includes(p))) continue;
      if (lnk.includes('pixeld')) { streams.push({ server: 'Pixeldrain', link: normPixel(lnk), type: 'mkv' }); continue; }
      if (lnk.includes('pixel.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); })); continue; }
      if (lnk.includes('gpdl2.hubcdn.fans') || lnk.includes('gpdl.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || lnk, type: 'mkv' }))); continue; }
      if (el.classes.includes('btn-danger')) streams.push({ server: '10Gbps Server', link: lnk, type: 'mkv' });
      else if (lnk.includes('.r2.dev')) streams.push({ server: 'R2 CDN', link: lnk, type: 'mkv' });
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

  // Find JS redirect URL
  const jsP = [
    /var\s+url\s*=\s*'([^']+)'/, /const\s+url\s*=\s*'([^']+)'/, /let\s+url\s*=\s*'([^']+)'/,
    /var\s+url\s*=\s*"([^"]+)"/, /const\s+url\s*=\s*"([^"]+)"/, /let\s+url\s*=\s*"([^"]+)"/,
    /url\s*=\s*'([^']+)'/, /url\s*=\s*"([^"]+)"/,
  ];
  let redirectUrl = null;
  for (const p of jsP) { const v = reGet(html1, p); if (v?.startsWith('http')) { redirectUrl = v; break; } }
  console.log(`[HubCloud] redirectUrl: ${redirectUrl}`);

  // Decode base64 r param
  let vcloudLink = null;
  if (redirectUrl) {
    try {
      const rp = new URL(redirectUrl).searchParams.get('r');
      if (rp) { try { vcloudLink = atob(rp); } catch { vcloudLink = redirectUrl; } }
      else vcloudLink = redirectUrl;
      console.log(`[HubCloud] vcloudLink: ${vcloudLink}`);
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
  } catch (e) {
    console.log(`[HubCloud] page2 error: ${e}`);
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
    if (lnk.includes('gdflix')) { streams.push({ server: 'GDFlix', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('pixeld')) { streams.push({ server: 'Pixeldrain', link: normPixel(lnk), type: 'mkv' }); continue; }
    if (lnk.includes('gpdl2.hubcdn.fans') || lnk.includes('gpdl.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || lnk, type: 'mkv' }))); continue; }
    if (lnk.includes('pixel.hubcdn.fans')) { futs.push(resolveViaApi(lnk).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); })); continue; }
    if (lnk.includes('.dev') && !lnk.includes('/?id=')) { streams.push({ server: 'Cf Worker', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('cloudflarestorage')) { streams.push({ server: 'CfStorage', link: lnk, type: 'mkv' }); continue; }
    if (lnk.includes('fastdl')) { streams.push({ server: 'FastDl', link: lnk, type: 'mkv' }); continue; }
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
  catch (e) { console.log(`[HubCloud/gamerxyt] ${e}`); return []; }
  const futs = [];
  for (const el of parseLinks(html)) {
    const h = el.href; const t = el.text;
    if (!h?.startsWith('http')) continue;
    if (h.includes('telegram') || h.includes('bloggingvector') || h.includes('ampproject.org')) continue;
    if (t.includes('FSL Server') || t.includes('FSLv2 Server') || h.includes('.r2.dev') || h.includes('fsl.cdnbaba') || h.includes('cdn.fsl-buckets')) streams.push({ server: 'Cf Worker', link: h, type: 'mkv' });
    else if (h.includes('gpdl2.hubcdn.fans') || h.includes('gpdl.hubcdn.fans')) futs.push(resolveViaApi(h).then(f => streams.push({ server: 'HubCdn (DRIVE-ONLY)', link: f || h, type: 'mkv' })));
    else if (h.includes('pixel.hubcdn.fans')) futs.push(resolveViaApi(h).then(f => { if (f) streams.push({ server: 'DRIVE (NON-RESUME)', link: f, type: 'mkv' }); }));
    else if (t.includes('PixeLServer') || h.includes('pixeldrain') || h.includes('pixeld')) streams.push({ server: 'Pixeldrain', link: normPixel(h), type: 'mkv' });
    else if (h.includes('mega.hubcloud') || t.toLowerCase().includes('mega')) streams.push({ server: 'Mega', link: h, type: 'mkv' });
    else if (h.includes('cloudserver') || h.includes('workers.dev') || t.toLowerCase().includes('zipdisk')) streams.push({ server: 'ZipDisk', link: h, type: 'zip' });
    else if (h.includes('cloudflarestorage')) streams.push({ server: 'CfStorage', link: h, type: 'mkv' });
    else if (h.includes('fastdl')) streams.push({ server: 'FastDl', link: h, type: 'mkv' });
    else if (h.includes('gdflix')) streams.push({ server: 'GDFlix', link: h, type: 'mkv' });
  }
  await Promise.all(futs);
  console.log(`[HubCloud/gamerxyt] ${streams.length} streams`);
  return streams;
}

// ─── GDFlix Extractor ─────────────────────────────────────────────────────────
//
//  GDFlix page uses Bootstrap multi-class buttons:
//    <a class="btn btn-secondary ...">  → ResumeCloud / ResumeBot
//    <a class="btn btn-danger ...">     → Instant / G-Drive seed
//    <a class="btn btn-success ...">    → Pixeldrain
//    <a class="btn btn-outline-info">   → GoFile [Multiup]
//
//  hrefByClass() now splits on whitespace so "btn btn-secondary" matches "btn-secondary"

async function gdflixExtract(url) {
  console.log(`[GDFlix] ${url}`);
  const streams = [];
  const origin = new URL(url).origin;

  let html;
  try {
    ({ text: html } = await scrapeHtml(url));   // uses proxy race if CF-protected
    console.log(`[GDFlix] page len=${html.length}`);
  } catch (e) { console.log(`[GDFlix] fetch: ${e}`); return []; }

  // Collect all button hrefs upfront — run all network tasks in parallel
  const resumeHref   = hrefByClass(html, 'btn-secondary');
  const seedHref     = hrefByClass(html, 'btn-danger');
  const pixelHref    = hrefByClass(html, 'btn-success');
  const gofileLinks  = parseLinks(html).filter(l => l.classes.includes('btn-outline-info'));

  console.log(`[GDFlix] resume=${resumeHref} seed=${seedHref} pixel=${pixelHref} gofile=${gofileLinks.length}`);

  const tasks = [];

  // ── Resume (btn-secondary) ─────────────────────────────────────────────
  if (resumeHref) {
    tasks.push((async () => {
      if (resumeHref.includes('indexbot')) {
        try {
          const { text: bh } = await scrapeHtml(resumeHref);
          const tM = /formData\.append\('token', '([a-f0-9]+)'\)/.exec(bh);
          const pM = /fetch\('\/download\?id=([a-zA-Z0-9\/+=]+)'/.exec(bh);
          if (tM && pM) {
            const fd = new FormData(); fd.append('token', tM[1]);
            const r = await fetch(`${resumeHref.split('/download')[0]}/download?id=${pM[1]}`, {
              method: 'POST', headers: { Referer: resumeHref, Cookie: 'PHPSESSID=7e9658ce7c805dab5bbcea9046f7f308' }, body: fd,
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

  // ── Instant / G-Drive seed (btn-danger) ───────────────────────────────
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
          const token = seedHref.split('=')[1]; const su = new URL(seedHref);
          const fd = new FormData(); fd.append('keys', token);
          const r = await fetch(`${su.protocol}//${su.host}/api`, { method: 'POST', headers: { 'x-token': `${su.protocol}//${su.host}/api` }, body: fd });
          if (r.ok) { const d = await r.json(); if (!d.error && d.url) streams.push({ server: 'Gdrive-Instant', link: d.url, type: 'mkv' }); }
        }
      } catch (e) { console.log(`[GDFlix/seed] ${e}`); }
    })());
  }

  // ── Pixeldrain (btn-success) ──────────────────────────────────────────
  if (pixelHref?.includes('pixeldrain')) {
    streams.push({ server: 'Pixeldrain', link: normPixel(pixelHref), type: 'mkv' });
  }

  // ── GoFile (btn-outline-info) ─────────────────────────────────────────
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

// ─── GoFile ───────────────────────────────────────────────────────────────────

async function gofileExtract(id) {
  try {
    const ar = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: aH() });
    if (!ar.ok) throw new Error(`account ${ar.status}`);
    const { data: { token } } = await ar.json();
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

// ─── GDirect ──────────────────────────────────────────────────────────────────

async function gdirectExtract(url) {
  console.log(`[GDirect] ${url}`);
  if (url.includes('zee-dl.shop')) {
    try {
      const { text } = await scrapeHtml(url);
      const m = /id=["']vd["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*id=["']vd["']/.exec(text);
      if (m) return [{ server: 'DRIVE', link: m[1] || m[2], type: 'mkv' }];
    } catch (e) { console.log(`[GDirect/zeedl] ${e}`); }
    return [];
  }
  const f = await resolveViaApi(url);
  if (!f) return [];
  let c = f;
  if (c.includes('fastdl.zip/dl.php?link=')) c = c.split('fastdl.zip/dl.php?link=')[1];
  return [{ server: 'DRIVE (G-Direct)', link: c, type: 'mkv' }];
}

// ─── FilePress ────────────────────────────────────────────────────────────────

async function filepressExtract(url) {
  console.log(`[FilePress] ${url}`);
  const streams = [];
  let pl = url;
  if (url.includes('filebee.xyz')) { const f = await resolveViaApi(url); if (f) pl = f; }
  const fm = /(?:filepress\.cloud|filepress\.wiki|filebee\.xyz)\/file\/([a-zA-Z0-9]+)/.exec(pl);
  if (!fm) return [];
  const fid = fm[1];
  const base = /^(https:\/\/[^/]+)/.exec(pl)?.[1] ?? 'https://new1.filepress.cloud';
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
  console.log(`[FilePress] ${streams.length} streams`);
  return streams;
}

// ─── Auto-detect ──────────────────────────────────────────────────────────────

async function autoDetect(url) {
  const l = url.toLowerCase();
  if (l.includes('vcloud.zip') || l.includes('vcloud.lol'))              return { extractor: 'VCloud',    streams: await vcloudExtract(url) };
  if (l.includes('gdflix'))                                               return { extractor: 'GDFlix',    streams: await gdflixExtract(url) };
  if (l.includes('hubcloud'))                                             return { extractor: 'HubCloud',  streams: await hubcloudExtract(url) };
  if (l.includes('filepress') || l.includes('filebee'))                   return { extractor: 'FilePress', streams: await filepressExtract(url) };
  if (l.includes('gofile.io/d/')) {
    const id = url.split('/d/')[1].split('?')[0];
    const r = await gofileExtract(id);
    return { extractor: 'GoFile', streams: r.success ? [{ server: 'GoFile', link: r.link, type: 'mkv', headers: { referer: 'https://gofile.io/', cookie: `accountToken=${r.token}` } }] : [] };
  }
  if (l.includes('zee-dl.shop') || l.includes('gdirect'))               return { extractor: 'GDirect', streams: await gdirectExtract(url) };

  // Unknown — try all in parallel, return first with results
  console.log(`[AutoDetect] unknown host — racing all extractors`);
  const [v, h, g] = await Promise.allSettled([
    vcloudExtract(url), hubcloudExtract(url), gdirectExtract(url),
  ]);
  if (v.status === 'fulfilled' && v.value.length) return { extractor: 'VCloud (auto)',   streams: v.value };
  if (h.status === 'fulfilled' && h.value.length) return { extractor: 'HubCloud (auto)', streams: h.value };
  if (g.status === 'fulfilled' && g.value.length) return { extractor: 'GDirect (auto)',  streams: g.value };
  return { extractor: 'Unknown', streams: [] };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const jR = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const hR = b => new Response(b, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });

// ─── Landing page ─────────────────────────────────────────────────────────────

const LANDING = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stream Bypass Worker</title>
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
.row{display:flex;gap:.7rem;margin-top:1.25rem}
input{flex:1;background:#0d0d14;border:1px solid var(--bdr);border-radius:8px;padding:.7rem 1rem;color:var(--tx);font-family:'Space Mono',monospace;font-size:.8rem;outline:none;transition:border-color .2s}
input:focus{border-color:var(--acc)}
button{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;border:none;border-radius:8px;padding:.7rem 1.4rem;font-family:'Syne',sans-serif;font-weight:700;cursor:pointer;white-space:nowrap}
button:hover{opacity:.85}
#spin{display:none;margin-top:.75rem;color:var(--mute);font-size:.85rem}
#out{display:none;margin-top:1rem;background:#0d0d14;border:1px solid var(--bdr);border-radius:8px;padding:1rem;font-family:'Space Mono',monospace;font-size:.75rem;white-space:pre-wrap;word-break:break-all;max-height:460px;overflow-y:auto}
.err{color:var(--red)}
</style>
</head>
<body>
<header>
  <p class="eyebrow">Cloudflare Workers</p>
  <h1>Stream Bypass Worker</h1>
  <p class="sub">Auto-detect · parallel proxy race · zero paid services</p>
</header>
<div class="card">
  <h2>🔀 Endpoints</h2>
  <div class="ep"><span class="badge bg">GET</span>/bypass?url=&lt;encoded_url&gt;</div>
  <div class="ep"><span class="badge bp">POST</span>/bypass  →  {"url":"..."}</div>
  <div class="ep"><span class="badge bg">GET</span>/extract/vcloud|hubcloud|gdflix|gdirect|filepress|gofile?url=</div>
</div>
<div class="card">
  <h2>⚡ Speed — Parallel Proxy Race</h2>
  <table>
    <thead><tr><th>Proxy</th><th>Strategy</th></tr></thead>
    <tbody>
      <tr><td>allorigins.win</td><td>Fires simultaneously with all others</td></tr>
      <tr><td>corsproxy.io</td><td>Fires simultaneously with all others</td></tr>
      <tr><td>codetabs.com</td><td>Fires simultaneously with all others</td></tr>
      <tr><td>thingproxy</td><td>Fires simultaneously with all others</td></tr>
      <tr><td>Direct fetch</td><td>Fires simultaneously — wins if no CF block</td></tr>
    </tbody>
  </table>
  <p style="margin-top:.75rem;font-size:.85rem;color:var(--mute)">Total wait = fastest proxy, not the sum. GDFlix &amp; HubCloud pages typically resolve in 2–6 s.</p>
</div>
<div class="card">
  <h2>⚙️ Extractors</h2>
  <table>
    <thead><tr><th>Extractor</th><th>Detected by</th><th>Servers</th></tr></thead>
    <tbody>
      <tr><td><span class="dot"></span>VCloud</td><td>vcloud.zip / vcloud.lol</td><td>10Gbps, R2 CDN, Pixeldrain, HubCdn</td></tr>
      <tr><td><span class="dot"></span>HubCloud</td><td>hubcloud.*</td><td>Cf Worker, Pixeldrain, Mega, ZipDisk, CfStorage, FastDl, GDFlix</td></tr>
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
    <input id="u" type="text" placeholder="https://hubcloud.foo/drive/…  or  https://gdflix.dev/file/…"/>
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
  const t=Date.now();
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
</html>`;

// ─── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '') return hR(LANDING);

    if (url.pathname === '/bypass') {
      let target = url.searchParams.get('url');
      if (!target && request.method === 'POST') {
        try { target = (await request.json()).url; } catch { return jR({ error: 'Invalid JSON' }, 400); }
      }
      if (!target) return jR({ error: 'Missing url', usage: 'GET /bypass?url=<encoded>' }, 400);
      try { new URL(target); } catch { return jR({ error: 'Invalid URL' }, 400); }
      const t0 = Date.now();
      try {
        const { extractor, streams } = await autoDetect(target);
        return jR({ success: true, extractor, url: target, count: streams.length, streams, elapsed_ms: Date.now() - t0 });
      } catch (e) {
        return jR({ success: false, error: String(e), url: target, elapsed_ms: Date.now() - t0 }, 500);
      }
    }

    if (url.pathname.startsWith('/extract/')) {
      const type = url.pathname.replace('/extract/', '');
      const target = url.searchParams.get('url');
      if (!target) return jR({ error: 'Missing url' }, 400);
      const t0 = Date.now(); let streams = [];
      try {
        switch (type) {
          case 'vcloud':    streams = await vcloudExtract(target); break;
          case 'hubcloud':  streams = await hubcloudExtract(target); break;
          case 'gdflix':    streams = await gdflixExtract(target); break;
          case 'gdirect':   streams = await gdirectExtract(target); break;
          case 'filepress': streams = await filepressExtract(target); break;
          case 'gofile': {
            const id = target.includes('/d/') ? target.split('/d/')[1].split('?')[0] : target;
            const r = await gofileExtract(id);
            if (r.success) streams = [{ server: 'GoFile', link: r.link, type: 'mkv', headers: { referer: 'https://gofile.io/', cookie: `accountToken=${r.token}` } }];
            break;
          }
          default: return jR({ error: `Unknown extractor: ${type}` }, 400);
        }
        return jR({ success: true, extractor: type, url: target, count: streams.length, streams, elapsed_ms: Date.now() - t0 });
      } catch (e) {
        return jR({ success: false, error: String(e), elapsed_ms: Date.now() - t0 }, 500);
      }
    }

    return jR({ error: 'Not found', routes: ['GET /', 'GET|POST /bypass?url=', 'GET /extract/{vcloud,hubcloud,gdflix,gdirect,filepress,gofile}?url='] }, 404);
  },
};
