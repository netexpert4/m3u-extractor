// extract-and-send-manifest.js
// Playwright extractor: sadece GERÇEK manifestleri alır ve Worker'a manifest içeriğini gönderir.
// Requires: playwright, node-fetch
const { chromium } = require('playwright');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error('Missing env vars: TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET');
  process.exit(1);
}

(async () => {
  console.log('Starting extractor (manifest-first logic)');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  let foundManifestContent = null;
  let foundManifestSource = null;

  // Helper: normalize relative segment URLs to absolute based on response url
  function normalizeManifest(text, responseUrl) {
    try {
      const u = new URL(responseUrl);
      const base = u.origin + u.pathname.replace(/\/[^\/]*$/, '/');
      return text.split(/\r?\n/).map(line => {
        if (!line) return line;
        if (/^\s*#/.test(line)) return line;
        if (/^https?:\/\//i.test(line)) return line;
        if (line.match(/\.(ts|m3u8)(\?|$)/i)) {
          const cleaned = line.replace(/^\.\//,'').replace(/^\//,'');
          return base + cleaned;
        }
        return line;
      }).join('\n');
    } catch(e) {
      return text;
    }
  }

  // Response handler: only accept true manifest responses or responses containing m3u8 token links
  page.on('response', async resp => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();

      // 1) If response URL looks like a manifest (.m3u8) -> fetch its text and accept as manifest
      if (url.match(/\.m3u8(\?|$)/i)) {
        console.log('[resp] m3u8 response URL detected:', url);
        const text = await safeText(resp);
        if (text && text.includes('#EXTM3U')) {
          console.log('[resp] manifest content confirmed from URL:', url);
          foundManifestContent = normalizeManifest(text, url);
          foundManifestSource = url;
        } else {
          // If content-type is not manifest but url ends with .m3u8 (rare), still try to GET it directly (fallback)
          try {
            console.log('[resp] .m3u8 URL had no #EXTM3U in body, doing direct fetch for safety:', url);
            const r2 = await fetch(url, { method: 'GET' });
            const t2 = await r2.text().catch(()=>null);
            if (t2 && t2.includes('#EXTM3U')) {
              foundManifestContent = normalizeManifest(t2, url);
              foundManifestSource = url;
            }
          } catch(e){}
        }
        return;
      }

      // 2) If response body itself contains a full manifest (#EXTM3U) -> take it (some servers embed manifests in JSON/text)
      if (ct.includes('text') || ct.includes('json') || ct.includes('mpegurl') || ct.includes('application')) {
        const txt = await safeText(resp);
        if (txt && txt.includes('#EXTM3U')) {
          console.log('[resp] found #EXTM3U inside response body from:', url);
          foundManifestContent = normalizeManifest(txt, url);
          foundManifestSource = url;
          return;
        }
      }

      // 3) If response body contains direct m3u8 link(s) with token -> try fetch that link and verify it's a manifest
      //    This avoids treating JS file contents as manifest.
      if (ct.includes('json') || ct.includes('text') || ct.includes('html') || ct.includes('javascript')) {
        const txt = await safeText(resp);
        if (!txt) return;
        // search only for explicit token-bearing m3u8 links (less false-positive)
        const match = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*\b(token=|signature=|sig=|expires=|exp=)[^\s"'<>]*/i);
        if (match && match[0]) {
          const candidateUrl = match[0];
          console.log('[resp] found tokened m3u8 link inside body:', candidateUrl, '-> fetching to confirm');
          try {
            const r2 = await fetch(candidateUrl, { method: 'GET' });
            const t2 = await r2.text().catch(()=>null);
            if (t2 && t2.includes('#EXTM3U')) {
              console.log('[resp] fetched candidate manifest contains #EXTM3U:', candidateUrl);
              foundManifestContent = normalizeManifest(t2, candidateUrl);
              foundManifestSource = candidateUrl;
              return;
            } else {
              console.log('[resp] fetched candidate did not contain manifest:', candidateUrl);
            }
          } catch(e){
            console.log('[resp] fetch candidate failed:', e && e.message);
          }
        }
      }

    } catch (e) {
      // ignore per-response errors
    }
  });

  // open page
  console.log('Opening', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 90000 }).catch(e => {
    console.warn('goto warning:', e && e.message);
  });

  // wait a bit for background XHRs to finish
  await page.waitForTimeout(8000);

  // If manifest not yet found, try clicking typical play buttons to trigger player/network
  if (!foundManifestContent) {
    console.log('No manifest yet — trying to click play buttons to trigger requests');
    const playSelectors = ['button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jwplayer .jw-icon-play', '#play'];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log('Clicking', sel);
          await el.click({ force: true }).catch(()=>{});
          await page.waitForTimeout(2500);
        }
      } catch(e){}
    }
    // wait again
    await page.waitForTimeout(4000);
  }

  // Final check: if still not found, examine window variables but only look for tokened m3u8 strings (avoid JS false positives)
  if (!foundManifestContent) {
    console.log('Final window-scan for tokened m3u8 links (safe mode)');
    try {
      const results = await page.evaluate(() => {
        const out = [];
        try {
          for (const k of Object.keys(window)) {
            try {
              const v = window[k];
              if (typeof v === 'string' && v.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*(token=|signature=|sig=|expires=|exp=)/i)) {
                out.push(v);
              }
              if (typeof v === 'object' && v !== null) {
                try {
                  const s = JSON.stringify(v);
                  const m = s.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*(token=|signature=|sig=|expires=|exp=)[^\s"']*/ig);
                  if (m) m.forEach(x => out.push(x));
                } catch(e){}
              }
            } catch(e){}
          }
        } catch(e){}
        return Array.from(new Set(out));
      });
      if (results && results.length) {
        console.log('window-scan found tokened links:', results);
        // fetch first and confirm it's a manifest
        const cand = results[0];
        try {
          const r3 = await fetch(cand, { method: 'GET' });
          const t3 = await r3.text().catch(()=>null);
          if (t3 && t3.includes('#EXTM3U')) {
            foundManifestContent = normalizeManifest(t3, cand);
            foundManifestSource = cand;
          } else {
            console.log('fetched window-candidate did not contain manifest');
          }
        } catch(e){ console.log('fetch window-candidate failed:', e && e.message); }
      }
    } catch(e) { console.log('window-scan evaluate failed:', e && e.message); }
  }

  if (!foundManifestContent) {
    console.error('No manifest found after all strategies — aborting.');
    await browser.close();
    process.exit(1);
  }

  console.log('Manifest FOUND from:', foundManifestSource);
  // send manifest content to worker
  try {
    const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,'') + '/update';
    console.log('Posting playlistContent to worker:', postUrl);
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
      body: JSON.stringify({ playlistContent: foundManifestContent, source: foundManifestSource })
    });
    const body = await res.text().catch(()=>'<no body>');
    console.log('Worker responded:', res.status, body);
    await browser.close();
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error('POST to worker failed:', e && e.message);
    await browser.close();
    process.exit(1);
  }

})();

async function safeText(response) {
  try {
    // prefer text() but guard large bodies
    const t = await response.text();
    return t;
  } catch (e) {
    return null;
  }
}
