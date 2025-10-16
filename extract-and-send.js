// extract-and-send.js
const { chromium } = require('playwright');
const fetch = require('node-fetch');

(async () => {
  const TARGET_PAGE = process.env.TARGET_PAGE || 'https://yoda.az/tv/biznestv/-/-';
  const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if (!WORKER_UPDATE_URL || !WORKER_SECRET) {
    console.error('Missing WORKER_UPDATE_URL or WORKER_SECRET');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let foundUrl = null;

  page.on('request', request => {
    const url = request.url();
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (/str\.yodacdn\.net|yodacdn\.net|moonlight\.wideiptv\.top/i.test(url)) {
        foundUrl = url;
        console.log('Found m3u8 request:', url);
      }
    }
    if (!foundUrl && /\.ts(\?|$)/i.test(url) && /\?token=/.test(url)) {
      console.log('Found ts request with token (possible):', url);
    }
  });

  page.on('response', async resp => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (/\bapplication\/vnd\.apple\.mpegurl\b/.test(ct) || /\.m3u8(\?|$)/i.test(url)) {
        const txt = await resp.text();
        if (txt && txt.includes('#EXTM3U')) {
          foundUrl = url;
          console.log('Found m3u8 response from:', url);
        }
      } else if (ct.includes('application/json')) {
        const j = await resp.json().catch(()=>null);
        if (j) {
          const s = JSON.stringify(j);
          const m = s.match(/https?:\/\/[^\s"']+\.m3u8\?token=[^"']+/i);
          if (m) {
            foundUrl = m[0];
            console.log('Found m3u8 in JSON response:', foundUrl);
          }
        }
      }
    } catch (e) {}
  });

  console.log('Opening page:', TARGET_PAGE);
  await page.goto(TARGET_PAGE, { waitUntil: 'networkidle' });

  for (let i = 0; i < 8 && !foundUrl; i++) {
    await page.waitForTimeout(1000);
  }

  if (!foundUrl) {
    console.error('No m3u8 url found');
    await browser.close();
    process.exit(2);
  }

  console.log('Sending foundUrl to worker:', foundUrl);
  const res = await fetch(WORKER_UPDATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WORKER_SECRET}`
    },
    body: JSON.stringify({ videoUrl: foundUrl })
  });

  console.log('Worker update status:', res.status, await res.text().catch(()=>'<no body>'));
  await browser.close();
  process.exit(0);
})();
