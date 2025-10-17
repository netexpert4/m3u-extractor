// extract-and-send.js
// Captures tokened and non-tokened m3u8 links, filters ads, sends best to Worker
// Usage (env): TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
// Optional envs: HEADLESS (default true), NAV_TIMEOUT (ms), WAIT_AFTER_LOAD (ms)

const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = 1; // only 1 attempt
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "90000", 10);
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "20000", 10);
const HEADLESS = process.env.HEADLESS !== "false";

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
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  const candidates = new Set();
  const seenRequests = new Set();

  // Network listeners to capture m3u8
  page.on('request', req => {
    try {
      const u = req.url();
      if (seenRequests.has(u)) return;
      seenRequests.add(u);
      if (u.includes(".m3u8")) candidates.add(u);
    } catch(e){}
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (seenRequests.has(u)) return;
      seenRequests.add(u);
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (u.includes(".m3u8") || ct.includes('mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
        candidates.add(u);
      }
    } catch(e){}
  });

  // Inject fetch/XHR hook
  await context.addInitScript(() => {
    try {
      window.__capturedRequests = window.__capturedRequests || [];
      const _fetch = window.fetch;
      window.fetch = async function(...args) {
        if (typeof args[0] === 'string') window.__capturedRequests.push(args[0]);
        else if (args[0] && args[0].url) window.__capturedRequests.push(args[0].url);
        return _fetch.apply(this, args);
      };
      const XHR = window.XMLHttpRequest;
      const open = XHR.prototype.open;
      XHR.prototype.open = function(method, url) {
        try { window.__capturedRequests.push(url); } catch(e){}
        return open.apply(this, arguments);
      };
    } catch(e){}
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`--- Attempt ${attempt}/${MAX_ATTEMPTS} ---`);
    try {
      await page.goto(TARGET_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    } catch(e) {
      console.log("[warn] navigation failed:", e.message);
    }
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // Capture requests from page context
    try {
      const winReqs = await page.evaluate(() => window.__capturedRequests || []);
      winReqs.forEach(u => candidates.add(u));
    } catch(e){}

    // Evaluate best candidate
    const list = Array.from(candidates);
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

  console.log("[final] attempts exhausted — no m3u8 captured");
  await browser.close();
  process.exit(1);

  function pickBest(list) {
    // remove duplicates
    const uniq = Array.from(new Set(list));

    // remove obvious ad URLs
    const filtered = uniq.filter(u => !u.includes('ads') && !u.includes('adserver') && !u.includes('doubleclick'));

    if (!filtered.length) return null;

    // prefer .m3u8 with token if available
    const tokened = filtered.find(u => u.includes(".m3u8") && /token=|signature=|sig=|expires=|exp=/.test(u));
    if (tokened) return tokened;

    // fallback: pick first non-tokened m3u8
    const nonTokened = filtered.find(u => u.includes(".m3u8"));
    if (nonTokened) return nonTokened;

    return null;
  }

  async function sendToWorker(url, base, secret) {
    try {
      const res = await fetch(base.replace(/\/+$/, "") + "/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
        body: JSON.stringify({ playlistUrl: url })
      });
      console.log("[worker] status", res.status);
      const txt = await res.text().catch(()=>"");
      console.log("[worker] body:", txt);
      return res.ok;
    } catch(e){
      console.log("[worker] send error:", e && e.message);
      return false;
    }
  }

})();
