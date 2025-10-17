// extract-and-send.js
// Aggressive extractor with reloads + fallback for tokened and non-tokened m3u8
// Usage (env): TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_RELOADS = 3;
const NAV_TIMEOUT = 30000;      // navigation timeout per attempt
const WAIT_AFTER_LOAD = 5000;   // wait for page JS to run
const RESP_TIMEOUT = 15000;     // wait for network responses
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
  console.log(`[${now()}] TARGET_URL: ${TARGET_URL} HEADLESS: ${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || 
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
    extraHTTPHeaders: { "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8" }
  });

  const page = await context.newPage();
  const candidates = new Set();
  const seenRequests = new Set();

  // capture requests
  page.on('request', req => {
    try {
      const u = req.url();
      if (seenRequests.has(u)) return;
      seenRequests.add(u);
      if (u.includes('.m3u8') || u.includes('.ts') || u.includes('token=')) {
        candidates.add(u);
        console.log("[REQ]", u);
      }
    } catch(e){ }
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (seenRequests.has(u)) seenRequests.add(u);
      const ct = (resp.headers()['content-type']||'').toLowerCase();
      if (u.includes('.m3u8') || ct.includes('mpegurl')) {
        candidates.add(u);
        console.log("[RES] probable m3u8:", u);
      }
    } catch(e){ }
  });

  // reload loop
  for (let attempt = 1; attempt <= MAX_RELOADS; attempt++) {
    console.log(`\n--- Attempt ${attempt}/${MAX_RELOADS} ---`);
    try {
      await page.goto(TARGET_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    } catch(e) { console.log("[warn] goto failed:", e.message); }
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // scan DOM + video elements
    try {
      const domLinks = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('video, source').forEach(v=>{
          if(v.src) out.add(v.src);
          if(v.currentSrc) out.add(v.currentSrc);
        });
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while(node = walker.nextNode()) {
          if(node.nodeValue && node.nodeValue.includes('.m3u8')) {
            node.nodeValue.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/ig)?.forEach(u=>out.add(u));
          }
        }
        return Array.from(out);
      });
      domLinks.forEach(u => candidates.add(u));
      if(domLinks.length) console.log("[dom-scan] found:", domLinks);
    } catch(e){}

    const list = Array.from(candidates);
    if(list.length) {
      const best = pickBest(list);
      if(best) {
        const ok = await sendToWorker(best, WORKER_BASE, WORKER_SECRET);
        if(ok) {
          console.log("[success] sent to worker:", best);
          await browser.close();
          process.exit(0);
        } else console.log("[warn] worker rejected:", best);
      }
    }

    if(attempt < MAX_RELOADS){
      console.log("[info] reloading page before next attempt...");
      await page.reload({ waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(()=>{});
      await page.waitForTimeout(3000);
    }
  }

  console.log("[final] no m3u8 captured");
  await browser.close();
  process.exit(1);

  function pickBest(list){
    // remove ads / known non-video patterns (example filter)
    const filtered = list.filter(u => !u.includes('ads') && u.includes('.m3u8'));
    // prefer tokened
    const tokened = filtered.filter(u => /token=|sig=|signature=/.test(u));
    if(tokened.length) return tokened[0];
    if(filtered.length) return filtered[0]; // fallback to first m3u8
    return null;
  }

  async function sendToWorker(url, base, secret){
    try {
      const res = await fetch(base.replace(/\/+$/,'') + "/update", {
        method: "POST",
        headers: { "Content-Type":"application/json", "Authorization":`Bearer ${secret}` },
        body: JSON.stringify({ playlistUrl: url })
      });
      console.log("[worker] status", res.status);
      return res.ok;
    } catch(e){ console.log("[worker] send error:", e.message); return false; }
  }

})();
