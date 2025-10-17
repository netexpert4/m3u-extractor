// extract-and-send.js
// Aggressive extractor for tokened and non-tokened m3u8 detection
// Usage (env): TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
// Optional envs: ATTEMPTS, NAV_TIMEOUT, WAIT_AFTER_LOAD, RESP_TIMEOUT, HEADLESS
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = parseInt(process.env.ATTEMPTS || "6", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "90000", 10); // ms
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "20000", 10); // ms
const RESP_TIMEOUT = parseInt(process.env.RESP_TIMEOUT || "45000", 10); // ms
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
    try { Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }], configurable: true }); } catch(e){}
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
          console.log(`[CDP] requestWillBeSent: ${u}`);
          candidates.add(u);
        }
      } catch(e){}
    });
  } catch(e) {
    console.log("[warn] CDP session not available:", e.message);
  }

  // page listeners
  page.on('request', req => {
    try {
      const u = req.url();
      if (seenRequests.has(u)) return;
      seenRequests.add(u);
      if (u.match(/\.m3u8(\?|$)/i) || u.match(/\.ts(\?|$)/i) || u.includes('token=')) {
        console.log(`[REQ] ${u}`);
        candidates.add(u);
      }
    } catch(e){}
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (seenRequests.has(u)) { /* continue */ } else seenRequests.add(u);
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (u.match(/\.m3u8(\?|$)/i) || ct.includes('mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
        console.log(`[RES] probable m3u8: ${u} status=${resp.status()}`);
        candidates.add(u);
        return;
      }
      // read body opportunistically (text), but not for large binary
      if (ct.includes('text') || ct.includes('json') || u.match(/\.m3u8(\?|$)/i)) {
        const txt = await safeText(resp);
        if (txt) {
          const found = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
          if (found) {
            found.forEach(f => candidates.add(f));
            console.log(`[RES-BODY] found in body: ${found}`);
            return;
          }
          if (txt.includes('#EXTM3U')) {
            console.log(`[RES-BODY] fragment m3u8 body at: ${u}`);
            candidates.add(u);
            return;
          }
        }
      }
    } catch(e){}
  });

  // Inject fetch/XHR monkeypatch to capture dynamic requests (runs in page context)
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

  // helper: attempt loop
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n--- ATTEMPT ${attempt}/${MAX_ATTEMPTS} ---`);

    // try navigation (first networkidle, fallback to load)
    try {
      console.log(`[${now()}] goto (networkidle) ${TARGET_URL} timeout ${NAV_TIMEOUT}`);
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    } catch (e) {
      console.log(`[warn] networkidle failed: ${e.message}. trying load()`);
      try {
        await page.goto(TARGET_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      } catch (e2) {
        console.log(`[warn] load() failed: ${e2.message}`);
      }
    }

    // wait for page JS to run
    console.log(`[${now()}] waitAfterLoad ${WAIT_AFTER_LOAD}ms`);
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // try to click obvious play buttons
    const playSelectors = [
      'button.play', '.play-button', '.vjs-play-control', '#play', '[data-play]',
      '.jw-icon-play','button[title="Play"]','button[aria-label*="play"]'
    ];
    let didClick = false;
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log(`[click] selector ${sel} found — clicking`);
          await el.click({ force: true }).catch(()=>{});
          didClick = true;
          await page.waitForTimeout(2000);
          break;
        }
      } catch(e){}
    }
    if (!didClick) {
      // try keyboard press in case player responds to space/enter
      try {
        console.log("[key] pressing Space and Enter to stimulate player");
        await page.keyboard.press('Space');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
      } catch(e){}
    }

    // After interactions, check window.__capturedRequests
    try {
      const winReqs = await page.evaluate(() => {
        try { return window.__capturedRequests || []; } catch(e) { return []; }
      });
      if (Array.isArray(winReqs) && winReqs.length) {
        winReqs.forEach(u => {
          if (typeof u === 'string') candidates.add(u);
        });
        console.log(`[winReqs] captured ${winReqs.length} requests from page context`);
      }
    } catch(e){}

    // Wait for .m3u8 responses specifically (aggressive wait)
    try {
      console.log(`[waitForResponse] waiting up to ${RESP_TIMEOUT}ms for m3u8?token=`);
      const resp = await page.waitForResponse(r => {
        const u = r.url();
        if (!u) return false;
        if (u.match(/\.m3u8(\?|$)/i) && /token=|signature=|sig=|expires=|exp=/.test(u)) return true;
        return false;
      }, { timeout: RESP_TIMEOUT });
      if (resp) {
        console.log("[waitForResponse] matched:", resp.url());
        candidates.add(resp.url());
      }
    } catch(e){
      console.log("[waitForResponse] none matched or timed out");
    }

    // short extra delay for late requests
    await page.waitForTimeout(3000);

    // scan DOM + window for any m3u8 strings (very exhaustive)
    try {
      const domCandidates = await page.evaluate(() => {
        const out = new Set();
        try {
          // check <video> src and source tags
          const vids = Array.from(document.querySelectorAll('video, source'));
          for (const v of vids) {
            try {
              if (v.currentSrc) out.add(v.currentSrc);
              if (v.src) out.add(v.src);
              if (v.getAttribute) {
                const a = v.getAttribute('src') || v.getAttribute('data-src') || v.getAttribute('data-href');
                if (a) out.add(a);
              }
            } catch(e){}
          }
          // scan for any text nodes containing .m3u8
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let txt;
          while (walker.nextNode()) {
            txt = walker.currentNode.nodeValue;
            if (txt && txt.includes('.m3u8')) {
              const matches = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
              if (matches) matches.forEach(m => out.add(m));
            }
          }
          // also check global JS objects
          for (const k of Object.keys(window)) {
            try {
              const val = window[k];
              if (!val) continue;
              if (typeof val === 'string' && val.includes('.m3u8')) out.add(val);
              else if (typeof val === 'object') {
                try {
                  const s = JSON.stringify(val);
                  const m = s.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/ig);
                  if (m) m.forEach(x => out.add(x));
                } catch(e){}
              }
            } catch(e){}
          }
        } catch(e){}
        return Array.from(out);
      });
      if (domCandidates && domCandidates.length) {
        domCandidates.forEach(u => candidates.add(u));
        console.log("[dom-scan] found candidates:", domCandidates);
      } else {
        console.log("[dom-scan] nothing found");
      }
    } catch(e){ console.log("[dom-scan] eval failed:", e.message); }

    // Evaluate best candidate
    const list = Array.from(candidates);
    if (list.length) {
      console.log("[candidates] total:", list.length);
      const best = pickBest(list);
      if (best) {
        console.log("[best] choosing:", best);
        const ok = await sendToWorker(best, WORKER_BASE, WORKER_SECRET);
        if (ok) {
          console.log("[success] sent to worker:", best);
          await browser.close();
          process.exit(0);
        } else {
          console.log("[error] worker rejected or failed; continuing attempts");
        }
      } else {
        console.log("[candidates] none suitable yet");
      }
    } else {
      console.log("[info] no candidates this attempt");
    }

    // reload & backoff
    const backoff = 1000 * attempt * 2;
    console.log(`[info] reloading and backing off ${backoff}ms before next attempt`);
    try { await page.reload({ waitUntil: "networkidle", timeout: NAV_TIMEOUT }); } catch(e){ console.log("[warn] reload failed:", e.message); }
    await page.waitForTimeout(backoff);
  }

  console.log("[final] attempts exhausted — no tokened URL captured");
  await browser.close();
  process.exit(1);

  // ---------- helpers ----------
  async function safeText(response) {
    try {
      return await response.text();
    } catch (e) { return null; }
  }

  function pickBest(list) {
    // prefer .m3u8 with token params
    const uniq = Array.from(new Set(list));
    const ordered = uniq.filter(u => /\.m3u8(\?|$)/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
    if (ordered.length) return ordered[0];
    const anyM3u8 = uniq.filter(u => /\.m3u8(\?|$)/i.test(u));
    if (anyM3u8.length) return anyM3u8[0];
    // fallback: if ts with token exists, infer index.m3u8
    const ts = uniq.find(u => /\.ts(\?|$)/i.test(u) && /token=|signature=|sig=/.test(u));
    if (ts) {
      try { return ts.replace(/\/[^\/]*\.ts(\?.*)?$/, "/index.m3u8"); } catch(e){}
    }
    return null;
  }

  async function sendToWorker(playlistUrl, workerBase, secret) {
    try {
      const url = workerBase.replace(/\/+$/, "") + "/update";
      console.log("[worker] POST", url);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`
        },
        body: JSON.stringify({ playlistUrl })
      });
      console.log("[worker] status", res.status);
      const txt = await res.text().catch(()=>"");
      console.log("[worker] body:", txt);
      return res.ok;
    } catch (e) {
      console.log("[worker] send error:", e && e.message);
      return false;
    }
  }

})();
