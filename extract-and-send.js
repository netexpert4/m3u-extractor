// extract-and-send-capture-token.js
// Capture tokened .m3u8 by intercepting requests (XHR/fetch), clicking play (frames+main), retrying up to 5 times.
// Requires: playwright, node-fetch
// Usage (local debug): HEADLESS=false TARGET_URL="..." WORKER_UPDATE_URL="..." WORKER_SECRET="..." node extract-and-send-capture-token.js

const { chromium } = require("playwright");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Missing env vars. Set TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
  process.exit(1);
}

// Config
const MAX_ATTEMPTS = 5;
const NAV_TIMEOUT = 60000;
const WAIT_AFTER_LOAD_MS = 2000;
const CLICK_WAIT_MS = 1500;
const WAIT_FOR_TOKEN_MS = 25000; // wait for token request after click
const HEADLESS = process.env.HEADLESS !== "false";

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log("=== extractor: capture tokened .m3u8 (xhr intercept) ===");
  console.log("TARGET_URL:", TARGET_URL);
  console.log("HEADLESS:", HEADLESS);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  // stealth-ish
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
    try { window.chrome = window.chrome || { runtime: {} }; } catch(e){}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'], configurable: true }); } catch(e){}
  });

  const page = await context.newPage();

  // candidate holder
  let capturedUrl = null;
  let capturedResponseText = null;
  let captureMeta = null;

  // Listen all requests. This will capture fetch/XHR requests made by player (even in iframes).
  page.on("request", req => {
    try {
      const u = req.url();
      if (!u) return;
      // Detect m3u8 with token (common patterns)
      if (/\.m3u8(\?|$)/i.test(u) && /(token=|signature=|sig=|expires=|exp=)/i.test(u)) {
        console.log("[request] tokened m3u8 detected (request):", u);
        // capture first one
        if (!capturedUrl) {
          capturedUrl = u;
          captureMeta = { source: "request", timestamp: Date.now() };
        }
      }
    } catch(e){}
  });

  // Also listen responses to catch manifest bodies if requested
  page.on("response", async resp => {
    try {
      const u = resp.url();
      if (!u) return;
      if (/\.m3u8(\?|$)/i.test(u)) {
        // try to read text
        const text = await resp.text().catch(()=>null);
        if (text && text.includes("#EXTM3U")) {
          console.log("[response] m3u8 response body contains manifest:", u);
          if (!capturedUrl) {
            capturedUrl = u;
            capturedResponseText = text;
            captureMeta = { source: "response", timestamp: Date.now() };
          } else if (!capturedResponseText && capturedUrl === u) {
            capturedResponseText = text;
          }
        } else {
          // request URL might include token but response not manifest body (segments). still keep URL
          if (/token=/.test(u) && !capturedUrl) {
            capturedUrl = u;
            captureMeta = { source: "response-url", timestamp: Date.now() };
          }
        }
      }
    } catch(e){}
  });

  // helper: try to click a selector in all frames (main + iframes)
  async function tryClickSelectorInAllFrames(selector) {
    // main frame
    try {
      const el = await page.$(selector);
      if (el) {
        console.log("Clicking selector on main page:", selector);
        await humanClick(el);
        return true;
      }
    } catch(e){}
    // frames
    for (const frame of page.frames()) {
      try {
        const el = await frame.$(selector);
        if (el) {
          console.log("Clicking selector in frame:", selector, "frame url:", frame.url().slice(0,80));
          await humanClickInFrame(frame, el);
          return true;
        }
      } catch(e){}
    }
    return false;
  }

  // human-like click on ElementHandle (main page)
  async function humanClick(el) {
    try {
      const box = await el.boundingBox();
      if (box) {
        const start = { x: 100 + Math.random()*200, y: 100 + Math.random()*200 };
        const steps = 18;
        for (let i=0;i<steps;i++){
          const x = start.x + (box.x + box.width/2 - start.x) * (i/steps) + (Math.random()-0.5)*6;
          const y = start.y + (box.y + box.height/2 - start.y) * (i/steps) + (Math.random()-0.5)*6;
          await page.mouse.move(x,y,{ steps: 1 });
          await sleep(8 + Math.random()*12);
        }
        await page.mouse.click(box.x + box.width/2, box.y + box.height/2, { force: true });
        return;
      }
      await el.click({ force: true });
    } catch(e){
      try { await el.click({ force: true }); } catch(e){}
    }
  }

  // human-like click inside frame (use frame.mouse)
  async function humanClickInFrame(frame, el) {
    try {
      const box = await el.boundingBox();
      if (box) {
        const start = { x: 100 + Math.random()*200, y: 100 + Math.random()*200 };
        const steps = 18;
        for (let i=0;i<steps;i++){
          const x = start.x + (box.x + box.width/2 - start.x) * (i/steps) + (Math.random()-0.5)*6;
          const y = start.y + (box.y + box.height/2 - start.y) * (i/steps) + (Math.random()-0.5)*6;
          await frame.mouse.move(x,y,{ steps: 1 });
          await sleep(8 + Math.random()*12);
        }
        await frame.mouse.click(box.x + box.width/2, box.y + box.height/2, { force: true });
        return;
      }
      await el.click({ force: true });
    } catch(e){
      try { await el.click({ force: true }); } catch(e){}
    }
  }

  // play selectors to try
  const playSelectors = [
    'button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jw-icon-play',
    '.player-play', '#play', '.plyr__control--play', '.ytp-large-play-button', '[aria-label="Play"]'
  ];

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`\n--- ATTEMPT ${attempt}/${MAX_ATTEMPTS} ---`);
      if (attempt === 1) {
        console.log("Navigating to page...");
        await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("goto warning:", e && e.message));
      } else {
        console.log("Reloading page...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("reload warning:", e && e.message));
      }

      console.log("Waiting for initial scripts...");
      await sleep(WAIT_AFTER_LOAD_MS);

      // try clicking multiple selectors (main + frames)
      let clickedAny = false;
      for (const sel of playSelectors) {
        try {
          const did = await tryClickSelectorInAllFrames(sel);
          if (did) {
            clickedAny = true;
            // after click small wait
            await sleep(CLICK_WAIT_MS);
          }
        } catch(e){}
        if (capturedUrl) break;
      }

      // fallback: try keyboard presses in main page
      if (!clickedAny) {
        console.log("No play selector found — sending Space/Enter to main page");
        try { await page.keyboard.press("Space"); } catch(e){}
        await sleep(500);
        try { await page.keyboard.press("Enter"); } catch(e){}
        await sleep(500);
      }

      // wait for tokened m3u8 request to happen (page.on('request') sets capturedUrl)
      console.log(`Waiting up to ${WAIT_FOR_TOKEN_MS}ms for tokened m3u8 request...`);
      const startWait = Date.now();
      while (!capturedUrl && (Date.now() - startWait) < WAIT_FOR_TOKEN_MS) {
        await sleep(250);
      }

      if (capturedUrl) {
        console.log("Captured tokened URL:", capturedUrl);
        // try to get response body for this URL (if response already fired)
        try {
          const resp = await page.waitForResponse(r => r.url() === capturedUrl, { timeout: 4000 }).catch(()=>null);
          if (resp) {
            const txt = await resp.text().catch(()=>null);
            if (txt && txt.includes("#EXTM3U")) {
              capturedResponseText = txt;
              console.log("Captured manifest text from response");
            } else {
              console.log("Response for captured URL did not contain #EXTM3U (likely playlist points to segments). We'll fetch the manifest.");
            }
          } else {
            console.log("No response object captured yet for URL; will attempt fetch.");
          }
        } catch(e){ console.log("Error getting response text:", e && e.message); }

        // If we don't have manifest text yet, try to fetch it from browser context (context.request)
        if (!capturedResponseText) {
          try {
            console.log("Attempting to fetch manifest from browser context for", capturedUrl);
            // use Playwright APIRequestContext to make same-origin request without CORS issues
            const apiReq = await context.request.get(capturedUrl, { timeout: 8000 }).catch(()=>null);
            if (apiReq) {
              const txt = await apiReq.text().catch(()=>null);
              if (txt && txt.includes("#EXTM3U")) {
                capturedResponseText = txt;
                console.log("Fetched manifest via context.request and confirmed #EXTM3U");
              } else {
                console.log("context.request fetch did not return manifest body (length or missing).");
              }
            } else {
              console.log("context.request returned null/failed.");
            }
          } catch(e){
            console.log("context.request fetch error:", e && e.message);
          }
        }

        // fallback: fetch from node (may be blocked by CORS/auth) — try anyway
        if (!capturedResponseText) {
          try {
            console.log("Attempting node-fetch for", capturedUrl);
            const r2 = await fetch(capturedUrl, { method: "GET", timeout: 8000 }).catch(()=>null);
            if (r2) {
              const txt2 = await r2.text().catch(()=>null);
              if (txt2 && txt2.includes("#EXTM3U")) {
                capturedResponseText = txt2;
                console.log("node-fetch fetched manifest and confirmed #EXTM3U");
              } else {
                console.log("node-fetch body did not include manifest or failed.");
              }
            }
          } catch(e){
            console.log("node-fetch error:", e && e.message);
          }
        }

        // if we have either manifest text or at least URL, we can send to worker
        if (capturedResponseText || capturedUrl) {
          const payload = {
            playlistUrl: capturedUrl,
            source: captureMeta,
            playlistContent: capturedResponseText || null
          };
          console.log("Sending payload to worker (playlistUrl + playlistContent if available)...");
          try {
            const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
            const r = await fetch(postUrl, {
              method: "POST",
              headers: { "Content-Type":"application/json", "Authorization": `Bearer ${WORKER_SECRET}` },
              body: JSON.stringify(payload),
              timeout: 15000
            });
            const txt = await r.text().catch(()=>"<no body>");
            console.log("Worker response:", r.status, txt);
            await browser.close();
            process.exit(r.ok ? 0 : 1);
          } catch(e){
            console.error("Failed to POST to worker:", e && e.message);
            await browser.close();
            process.exit(1);
          }
        }
      } else {
        console.log("No tokened m3u8 detected in this attempt.");
      }

      // small backoff before next attempt
      const backoff = 1500 * attempt;
      console.log("Backoff", backoff, "ms before next attempt");
      await sleep(backoff);
    } // end attempts loop

    // after attempts, if no capture
    console.error("All attempts finished. capturedUrl:", capturedUrl);
    await browser.close();
    process.exit(1);

  } catch (e) {
    console.error("Top-level error:", e && e.message);
    try { await browser.close(); } catch(_) {}
    process.exit(1);
  }
})();
