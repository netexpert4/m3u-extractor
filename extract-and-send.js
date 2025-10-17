// extract-and-send.js
// Aggressive extractor for tokened and non-tokened m3u8 detection
// Sends only non-ad, playable m3u8 to worker
// Usage (env): TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
// Optional envs: NAV_TIMEOUT, WAIT_AFTER_LOAD, RESP_TIMEOUT, HEADLESS
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = 1; // sadece bir deneme
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "90000", 10); // ms
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "15000", 10); // ms
const RESP_TIMEOUT = parseInt(process.env.RESP_TIMEOUT || "30000", 10); // ms
const HEADLESS = process.env.HEADLESS !== "false"; // default true

function now() { return new Date().toISOString(); }

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const WORKER_BASE = process.env.WORKER_UPDATE_URL;
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if (!TARGET_URL || !WORKER_BASE || !WORKER_SECRET) {
    console.error("[fatal] Missing envs. Set TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
    process.exit(1);
  }

  console.log(`[${now()}] extractor: start`);
  console.log(`[${now()}] TARGET_URL: ${TARGET_URL}  HEADLESS: ${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-infobars"
    ]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: process.env.LOCALE || "tr-TR",
    timezoneId: process.env.TIMEZONE || "Europe/Istanbul",
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  // stealth-ish init
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
    try { window.chrome = window.chrome || { runtime: {} }; } catch(e){}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3], configurable: true }); } catch(e){}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'], configurable: true }); } catch(e){}
  });

  const page = await context.newPage();

  // store candidates
  const candidates = new Set();
  const seenRequests = new Set();

  // CDP session to capture low-level network events
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', e => {
      try {
        const u = e.request && e.request.url;
        if (!u) return;
        if (seenRequests.has(u)) return;
        seenRequests.add(u);
        if (u.match(/\.m3u8(\?|$)/i) || u.match(/\.ts(\?|$)/i) || u.includes('token=')) {
          candidates.add(u);
        }
      } catch(e){}
    });
  } catch(e) {
    console.log("[warn] CDP session not available:", e.message);
  }

  page.on('request', req => {
    try {
      const u = req.url();
      if (seenRequests.has(u)) return;
      seenRequests.add(u);
      if (u.match(/\.m3u8(\?|$)/i) || u.match(/\.ts(\?|$)/i) || u.includes('token=')) {
        candidates.add(u);
      }
    } catch(e){}
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (!seenRequests.has(u)) seenRequests.add(u);
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (u.match(/\.m3u8(\?|$)/i) || ct.includes('mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
        candidates.add(u);
        return;
      }
    } catch(e){}
  });

  // Inject fetch/XHR monkeypatch
  await context.addInitScript(() => {
    try {
      window.__capturedRequests = window.__capturedRequests || [];
      const _fetch = window.fetch;
      window.fetch = async function(...args) {
        try {
          const arg0 = args[0];
          if (typeof arg0 === 'string') window.__capturedRequests.push(arg0);
          else if (arg0 && arg0.url) window.__capturedRequests.push(arg0.url);
        } catch(e){}
        return _fetch.apply(this, args);
      };
      const XHR = window.XMLHttpRequest;
      const open = XHR.prototype.open;
      XHR.prototype.open = function(method, url) {
        try { window.__capturedRequests.push(String(url)); } catch(e){}
        return open.apply(this, arguments);
      };
    } catch(e){}
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n--- Attempt ${attempt}/${MAX_ATTEMPTS} ---`);
    try {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    } catch (e) {
      console.log("[warn] networkidle failed, trying load()", e.message);
      try { await page.goto(TARGET_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT }); } catch(e2){}
    }
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // capture window requests
    try {
      const winReqs = await page.evaluate(() => window.__capturedRequests || []);
      if (winReqs.length) winReqs.forEach(u => candidates.add(u));
    } catch(e){}

    // reload to try capture if nothing yet
    if (!candidates.size) {
      try { await page.reload({ waitUntil: "networkidle", timeout: NAV_TIMEOUT }); } catch(e){}
      await page.waitForTimeout(3000);
    }

    // finalize pick
    const list = Array.from(candidates);
    if (list.length) {
      const best = pickBest(list);
      if (best) {
        const ok = await sendToWorker(best, WORKER_BASE, WORKER_SECRET);
        if (ok) {
          console.log("[success] sent to worker:", best);
          await browser.close();
          process.exit(0);
        }
      }
    }
  }

  console.log("[final] attempts exhausted — no m3u8 captured");
  await browser.close();
  process.exit(1);

  // ---------- helpers ----------
  function pickBest(list) {
    const uniq = Array.from(new Set(list));
    // reklam gibi görünenleri filtrele
    const filtered = uniq.filter(u => !u.includes('ads') && !u.includes('adserver'));
    if (!filtered.length) return uniq[0]; // fallback
    // tokenli varsa öncelik ver
    const tokened = filtered.filter(u => /token=|signature=|sig=|expires=|exp=/.test(u));
    if (tokened.length) return tokened[0];
    // token yoksa tokensizi gönder
    return filtered[0];
  }

  async function sendToWorker(playlistUrl, workerBase, secret) {
    try {
      const url = workerBase.replace(/\/+$/, "") + "/update";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
        body: JSON.stringify({ playlistUrl })
      });
      console.log("[worker] status", res.status);
      return res.ok;
    } catch (e) {
      console.log("[worker] send error:", e.message);
      return false;
    }
  }

})();
