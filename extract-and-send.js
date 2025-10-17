// extract-and-send-retry5.js
// Playwright extractor: click + reload (5 attempts), verify manifest, send playlistContent to Worker
// Requires: playwright, node-fetch
const { chromium } = require("playwright");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

// Config
const MAX_ATTEMPTS = 5;               // toplam reload denemesi (sen istedin 5)
const NAV_TIMEOUT = 60000;           // page.goto timeout
const AFTER_LOAD_WAIT = 2000;        // yüklemeden hemen sonra bekle (ms)
const AFTER_CLICK_WAIT = 2000;       // click sonrası bekle (ms)
const WAIT_FOR_RESPONSE_MS = 20000;  // waitForResponse timeout (ms) her denemede
const VERIFY_FETCH_TIMEOUT = 15000;  // manifest doğrulama fetch timeout (ms)
const HEADLESS = process.env.HEADLESS !== "false"; // env HEADLESS=false ile headful test

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Missing env vars. Set TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    }).join("\n");
  } catch(e) {
    return text;
  }
}

(async () => {
  console.log("Extractor (retry x5) starting");
  console.log("TARGET_URL:", TARGET_URL);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "tr-TR"
  });

  // küçük stealth injection (helpful)
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
    try { window.chrome = window.chrome || { runtime: {} }; } catch(e){}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'], configurable: true }); } catch(e){}
  });

  const page = await context.newPage();

  // candidate set (request urls and regex matches)
  const candidates = new Set();
  let confirmedManifest = null; // { url, content }

  // listen requests - en güvenilir: player doğrudan request atarsa yakalarız
  page.on("request", req => {
    try {
      const u = req.url();
      if (!u) return;
      if (/\.m3u8(\?|$)/i.test(u)) {
        console.log("[request] .m3u8 requested:", u);
        candidates.add(u);
      }
    } catch(e){}
  });

  // listen responses - manifest body veya gövdede gömülü linkler
  page.on("response", async resp => {
    try {
      const u = resp.url();
      if (!u) return;
      // eğer response URL doğrudan .m3u8 ise kontrol et
      if (/\.m3u8(\?|$)/i.test(u)) {
        const txt = await resp.text().catch(()=>null);
        if (txt && txt.includes("#EXTM3U")) {
          console.log("[response] direct m3u8 content from:", u);
          confirmedManifest = { url: u, content: normalizeManifest(txt, u) };
        } else {
          // yine candidate olarak kaydet
          candidates.add(u);
        }
        return;
      }
      // geniş gövde taraması: gövdede tokenli .m3u8 linkleri ara
      const body = await resp.text().catch(()=>null);
      if (!body) return;
      // daha katı arama: token veya signature içeren linkleri öncelikle al
      const reTokened = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*\b(token=|signature=|sig=|expires=|exp=)[^\s"'<>]*)/ig;
      let m;
      while ((m = reTokened.exec(body)) !== null) {
        console.log("[resp-body] tokened m3u8 found:", m[1].slice(0,200));
        candidates.add(m[1]);
      }
      // fallback: herhangi bir .m3u8 linki (daha geniş; false-positive olabilir)
      const reAny = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/ig;
      while ((m = reAny.exec(body)) !== null) {
        console.log("[resp-body] any m3u8 found:", m[1].slice(0,200));
        candidates.add(m[1]);
      }
    } catch(e){}
  });

  // helper: human-like click
  async function humanClickElement(el) {
    try {
      const box = await el.boundingBox();
      if (box) {
        const start = { x: 100 + Math.random()*200, y: 100 + Math.random()*200 };
        const steps = 20;
        for (let i=0;i<steps;i++){
          const x = start.x + (box.x + box.width/2 - start.x) * (i/steps) + (Math.random()-0.5)*6;
          const y = start.y + (box.y + box.height/2 - start.y) * (i/steps) + (Math.random()-0.5)*6;
          await page.mouse.move(x,y,{ steps: 1 });
          await sleep(8 + Math.random()*20);
        }
        await page.mouse.click(box.x + box.width/2, box.y + box.height/2, { force: true });
      } else {
        await el.click({ force: true });
      }
    } catch(e){
      try { await el.click({ force: true }); } catch(e2) {}
    }
  }

  // common play selectors
  const playSelectors = [
    'button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jw-icon-play',
    '.player-play', '#play', '.plyr__control--play', '.ytp-large-play-button', '[aria-label="Play"]'
  ];

  // attempt loop: 1..MAX_ATTEMPTS
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n===== ATTEMPT ${attempt} / ${MAX_ATTEMPTS} =====`);
    try {
      if (attempt === 1) {
        console.log("Navigating to page...");
        await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("goto warning:", e && e.message));
      } else {
        console.log("Reloading page (attempt)", attempt);
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("reload warning:", e && e.message));
      }

      await sleep(AFTER_LOAD_WAIT);

      // Quick scan: try clicking common play selectors
      let clicked = false;
      for (const sel of playSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            console.log("Clicking selector:", sel);
            await humanClickElement(el);
            clicked = true;
            await sleep(AFTER_CLICK_WAIT);
            if (confirmedManifest) break;
          }
        } catch(e){}
      }

      // If nothing clicked, try pressing Space / Enter
      if (!clicked) {
        try {
          console.log("No play selector clicked — sending keyboard events (Space, k, Enter)");
          await page.keyboard.press("Space").catch(()=>{});
          await sleep(500);
          await page.keyboard.press("k").catch(()=>{});
          await sleep(500);
          await page.keyboard.press("Enter").catch(()=>{});
          await sleep(AFTER_CLICK_WAIT);
        } catch(e){}
      }

      // Wait for direct m3u8 response (if player requests it)
      try {
        console.log("Waiting for .m3u8 response (up to", WAIT_FOR_RESPONSE_MS, "ms) ...");
        const resp = await page.waitForResponse(r => /\.m3u8(\?|$)/i.test(r.url()), { timeout: WAIT_FOR_RESPONSE_MS });
        if (resp) {
          const u = resp.url();
          console.log("waitForResponse matched:", u);
          const txt = await resp.text().catch(()=>null);
          if (txt && txt.includes("#EXTM3U")) {
            confirmedManifest = { url: u, content: normalizeManifest(txt, u) };
            console.log("Confirmed manifest from response:", u);
            break;
          } else {
            console.log("Response body for", u, "did not include #EXTM3U; adding as candidate");
            candidates.add(u);
          }
        }
      } catch (e) {
        console.log("No immediate .m3u8 response in this attempt (or timed out).");
      }

      // give small extra time for late requests
      await sleep(1500);

      // If we have confirmedManifest from earlier response handler, we can break
      if (confirmedManifest) break;

      // Try to verify any candidates collected so far
      if (candidates.size > 0) {
        console.log("Verifying candidates (count):", candidates.size);
        for (const u of Array.from(candidates)) {
          try {
            console.log("Verifying:", u.slice(0,200));
            // short fetch with timeout
            const controller = new AbortController();
            const to = setTimeout(()=>controller.abort(), VERIFY_FETCH_TIMEOUT);
            const r = await fetch(u, { signal: controller.signal });
            clearTimeout(to);
            const txt = await r.text().catch(()=>null);
            if (txt && txt.includes("#EXTM3U")) {
              confirmedManifest = { url: u, content: normalizeManifest(txt, u) };
              console.log("Verified manifest by fetch:", u);
              break;
            } else {
              console.log("Not a manifest:", u.slice(0,200));
            }
          } catch (err) {
            console.log("Fetch/verify failed for", u.slice(0,200), "err:", err && err.message);
          }
        }
      }

      if (confirmedManifest) break;

      // exponential backoff before next attempt
      const backoff = 2000 * attempt;
      console.log("No manifest yet — backing off", backoff, "ms before next attempt");
      await sleep(backoff);

    } catch (err) {
      console.log("Attempt error:", err && err.message);
    }
  } // attempts loop

  // after attempts
  if (!confirmedManifest) {
    console.error("All attempts exhausted — no manifest found. Candidates dump:");
    console.error(Array.from(candidates).slice(0,200));
    await browser.close();
    process.exit(1);
  }

  // send to worker
  try {
    console.log("Manifest FOUND from:", confirmedManifest.url);
    console.log("Manifest length:", confirmedManifest.content ? confirmedManifest.content.length : 0);
    const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
    const r = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WORKER_SECRET}` },
      body: JSON.stringify({ playlistContent: confirmedManifest.content, source: confirmedManifest.url }),
      timeout: 20000
    });
    const body = await r.text().catch(()=>"<no body>");
    console.log("Worker responded:", r.status, body);
    await browser.close();
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error("Failed to POST to worker:", e && e.message);
    await browser.close();
    process.exit(1);
  }
})();
