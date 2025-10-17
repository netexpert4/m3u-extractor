// extract-and-send-stealth.js
// Requires: playwright, node-fetch
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Missing env vars: TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
  process.exit(1);
}

const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "90000"); // 90s
const GLOBAL_SCAN_TIMEOUT = parseInt(process.env.GLOBAL_SCAN_TIMEOUT || "30000"); // 30s
const WAIT_AFTER_CLICK = parseInt(process.env.WAIT_AFTER_CLICK || "4000"); // 4s
const TOTAL_RUN_TIMEOUT = parseInt(process.env.TOTAL_RUN_TIMEOUT || "180000"); // 3min overall

function sleep(ms) { return new Promise(r=>setTimeout(r, ms)); }

(async () => {
  console.log("STEALTH EXTRACTOR START");
  console.log("TARGET_URL:", TARGET_URL);

  const totalTimer = setTimeout(() => {
    console.error("TOTAL_RUN_TIMEOUT reached, exiting.");
    process.exit(2);
  }, TOTAL_RUN_TIMEOUT);

  const browser = await chromium.launch({
    headless: process.env.HEADLESS === "false" ? false : true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  // stealth context
  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  // Inject stealth props
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
    try { window.chrome = { runtime: {} }; } catch(e){}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4], configurable: true }); } catch(e){}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'], configurable: true }); } catch(e){}
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true }); } catch(e){}
  });

  const page = await context.newPage();

  // collectors
  const requestsSeen = new Set();
  const responsesSeen = new Set();
  const m3uCandidates = new Set();

  page.on("request", req => {
    const u = req.url();
    if (!u) return;
    requestsSeen.add(u);
    if (u.match(/\.m3u8(\?|$)/i) || (u.match(/\.ts(\?|$)/i) && u.includes("token="))) {
      console.log("REQUEST candidate:", u);
      m3uCandidates.add(u);
    }
  });

  page.on("response", async resp => {
    try {
      const u = resp.url();
      responsesSeen.add(u);
      const ct = (resp.headers()['content-type'] || "").toLowerCase();
      if (u.match(/\.m3u8(\?|$)/i)) {
        console.log("RESPONSE candidate URL:", u);
        m3uCandidates.add(u);
        return;
      }
      if (ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl")) {
        console.log("RESPONSE content-type m3u8 from:", u);
        m3uCandidates.add(u);
        return;
      }
      // small body scan
      if (ct.includes("json") || ct.includes("text") || ct.includes("html")) {
        const text = await safeText(resp, 200000);
        if (text && text.includes("#EXTM3U")) {
          console.log("RESPONSE body contains #EXTM3U from:", u);
          m3uCandidates.add(u);
        } else if (text) {
          const matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
          if (matches) {
            matches.forEach(m => m3uCandidates.add(m));
            console.log("Found .m3u8 inside response body:", matches);
          }
        }
      }
    } catch(e){}
  });

  // Navigation
  try {
    console.log("Navigating...", TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: "load", timeout: NAV_TIMEOUT });
    console.log("Page loaded (load). Sleeping 2s");
    await sleep(2000);
  } catch (e) {
    console.warn("page.goto(load) failed:", e.message, "-> trying networkidle");
    try {
      await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
      console.log("Page loaded (networkidle)");
    } catch (e2) {
      console.warn("page.goto(networkidle) also failed:", e2.message);
    }
  }

  // Print top-level info for debug
  console.log("Initial requests count:", requestsSeen.size);

  // Attempt: scan window for any strings that include .m3u8
  console.log("Scanning window object for .m3u8 strings (this may be slow)...");
  let windowScan = [];
  try {
    windowScan = await page.evaluate(() => {
      const out = [];
      try {
        const keys = Object.keys(window);
        // limit to first 500 keys to avoid blowup
        for (let i = 0; i < Math.min(keys.length, 500); i++) {
          const k = keys[i];
          try {
            const v = window[k];
            if (!v) continue;
            if (typeof v === "string" && v.includes(".m3u8")) out.push({ key: k, value: v });
            if (typeof v === "object" && v !== null) {
              try {
                const s = JSON.stringify(v);
                const m = s.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/ig);
                if (m) m.forEach(x => out.push({ key: k, value: x }));
              } catch(e){}
            }
          } catch(e){}
        }
      } catch(e){}
      return out;
    });
    if (windowScan && windowScan.length) {
      console.log("windowScan results count:", windowScan.length);
      windowScan.forEach(x => {
        console.log("windowScan ->", x.key, x.value);
        m3uCandidates.add(x.value);
      });
    } else {
      console.log("windowScan found nothing");
    }
  } catch(e){
    console.warn("window-scan evaluate failed:", e.message);
  }

  // Try to click play buttons (realistic)
  const playSelectors = ['button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jwplayer .jw-icon-play', '#play', '.player-play'];
  for (const sel of playSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log("Clicking possible play selector:", sel);
        await humanMouseMoveAndClick(page, el);
        await sleep(WAIT_AFTER_CLICK);
      }
    } catch(e){ /* ignore */ }
  }

  // After interactions, wait more time for network
  console.log("Waiting extra 5s for network activity after interactions...");
  await sleep(5000);

  // Perform a second intensive scan: responses + body search
  console.log("Collecting response list and scanning for embedded m3u8 strings...");
  // dump some network urls for diagnosis
  if (responsesSeen.size > 0) {
    console.log("Responses seen (sample 20):");
    Array.from(responsesSeen).slice(0,20).forEach(u => console.log("  RESP:", u));
  } else {
    console.log("No responses recorded");
  }

  // Final candidate list
  const final = Array.from(m3uCandidates);
  console.log("FINAL CANDIDATES COUNT:", final.length);
  final.forEach((c,i) => console.log(`${i+1}. ${c}`));

  if (final.length === 0) {
    console.error("No candidates found. ACTION ITEMS for you:");
    console.error(" - Run this script LOCALLY with HEADLESS=false to see the browser and open DevTools.");
    console.error(" - In your desktop browser open the TARGET_URL, open DevTools->Network and find the .m3u8 URL; copy the request & response details and paste here.");
    console.error(" - If you can paste the local browser network request URL here I will adapt the script to fetch it.");
    await browser.close();
    clearTimeout(totalTimer);
    process.exit(1);
  }

  // Pick best candidate: prefer .m3u8 with token
  let best = final.find(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
  if (!best) best = final.find(u => /\.m3u8/i.test(u));
  if (!best) best = final[0];
  console.log("Chosen best candidate:", best);

  // Send to worker
  try {
    const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
    console.log("Posting to worker:", postUrl);
    const r = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": `Bearer ${WORKER_SECRET}` },
      body: JSON.stringify({ playlistUrl: best }),
    });
    const txt = await r.text().catch(()=>"<no body>");
    console.log("Worker response:", r.status, txt);
    await browser.close();
    clearTimeout(totalTimer);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error("POST error:", e && e.message);
    await browser.close();
    clearTimeout(totalTimer);
    process.exit(1);
  }
})();

async function humanMouseMoveAndClick(page, elHandle) {
  try {
    const box = await elHandle.boundingBox();
    if (!box) {
      await elHandle.click({ force: true });
      return;
    }
    const from = { x: 100 + Math.random()*200, y: 100 + Math.random()*200 };
    const to = { x: box.x + box.width/2, y: box.y + box.height/2 };
    const steps = 30;
    for (let i=0;i<steps;i++){
      await page.mouse.move(from.x + (to.x-from.x)*(i/steps) + Math.random()*2, from.y + (to.y-from.y)*(i/steps) + Math.random()*2);
      await sleep(10 + Math.random()*20);
    }
    await page.mouse.down();
    await sleep(30 + Math.random()*40);
    await page.mouse.up();
  } catch(e){}
}

async function safeText(response, max = 200000) {
  try {
    const b = await response.body();
    if (!b) return null;
    const s = b.toString().slice(0, max);
    return s;
  } catch (e) {
    try { return await response.text(); } catch(e) { return null; }
  }
}
