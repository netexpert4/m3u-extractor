// extract-and-send-eval-token.js
// - patches fetch + XHR to capture outgoing URLs (window.__capturedRequests)
// - tries clicking play buttons (main + frames), retries up to 5
// - scans known player globals and <video> elements
// - verifies manifest (#EXTM3U) then POSTs playlistContent (or playlistUrl) to Worker
//
// Usage: HEADLESS=false TARGET_URL="..." WORKER_UPDATE_URL="..." WORKER_SECRET="..." node extract-and-send-eval-token.js

const { chromium } = require("playwright");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Missing env vars. Set TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
  process.exit(1);
}

const MAX_ATTEMPTS = 5;
const NAV_TIMEOUT = 60000;
const WAIT_AFTER_LOAD_MS = 1500;
const CLICK_WAIT_MS = 1200;
const WAIT_FOR_TOKEN_MS = 22000;
const HEADLESS = process.env.HEADLESS !== "false";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

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
  } catch(e){ return text; }
}

(async () => {
  console.log("=== extractor: eval + intercept token capture ===");
  console.log("TARGET_URL:", TARGET_URL, "HEADLESS:", HEADLESS);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "tr-TR",
  });

  // Inject capturing script before any page script runs
  await context.addInitScript(() => {
    // create container
    try {
      window.__capturedRequests = window.__capturedRequests || [];
      // patch fetch
      const _fetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          const url = (typeof input === 'string') ? input : (input && input.url) || '';
          if (url) {
            window.__capturedRequests.push({ type: 'fetch', url: String(url), ts: Date.now() });
          }
        } catch(e){}
        return _fetch.apply(this, arguments);
      };
      // patch XHR.open
      const X = window.XMLHttpRequest;
      if (X && X.prototype) {
        const _open = X.prototype.open;
        X.prototype.open = function(method, url) {
          try {
            if (url) window.__capturedRequests.push({ type: 'xhr', method: method, url: String(url), ts: Date.now() });
          } catch(e){}
          return _open.apply(this, arguments);
        };
      }
    } catch(e){}
  });

  const page = await context.newPage();

  // helper to human-click element handle (page or frame)
  async function humanClickEl(el, frameOrPage) {
    try {
      const box = await el.boundingBox();
      if (box) {
        const start = { x: 80 + Math.random()*200, y: 80 + Math.random()*200 };
        const steps = 18;
        for (let i=0;i<steps;i++){
          const x = start.x + (box.x + box.width/2 - start.x) * (i/steps) + (Math.random()-0.5)*6;
          const y = start.y + (box.y + box.height/2 - start.y) * (i/steps) + (Math.random()-0.5)*6;
          await (frameOrPage.mouse || page.mouse).move(x,y,{steps:1});
          await sleep(6 + Math.random()*12);
        }
        await (frameOrPage.mouse || page.mouse).click(box.x + box.width/2, box.y + box.height/2, { force: true });
        return true;
      } else {
        await el.click({ force: true });
        return true;
      }
    } catch(e){
      try { await el.click({ force: true }); return true; } catch(e2){ return false; }
    }
  }

  // play selectors
  const playSelectors = [
    'button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jw-icon-play',
    '.player-play', '#play', '.plyr__control--play', '.ytp-large-play-button', '[aria-label="Play"]'
  ];

  // tries: 1..MAX_ATTEMPTS (reloads)
  let finalCapturedUrl = null;
  let finalCapturedManifest = null;
  let captureMeta = null;

  try {
    for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
      console.log(`\n--- ATTEMPT ${attempt}/${MAX_ATTEMPTS} ---`);
      if (attempt===1) {
        console.log("goto:", TARGET_URL);
        await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("goto:", e && e.message));
      } else {
        console.log("reload page");
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(e=>console.warn("reload:", e && e.message));
      }

      // short wait for scripts to initialize
      await sleep(WAIT_AFTER_LOAD_MS);

      // 1) try clicking play selectors in main page
      let clicked = false;
      for (const sel of playSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            console.log("Clicking main selector:", sel);
            await humanClickEl(el, page);
            clicked = true;
            await sleep(CLICK_WAIT_MS);
          }
        } catch(e){}
      }

      // 2) try clicking selectors inside frames
      const frames = page.frames();
      for (const frame of frames) {
        for (const sel of playSelectors) {
          try {
            const el = await frame.$(sel);
            if (el) {
              console.log("Clicking in frame:", sel, "frame url:", frame.url().slice(0,100));
              await humanClickEl(el, frame);
              clicked = true;
              await sleep(CLICK_WAIT_MS);
            }
          } catch(e){}
        }
      }

      // 3) try generic keyboard interaction on main page
      if (!clicked) {
        console.log("No play button clicked, trying Space/Enter");
        try { await page.keyboard.press("Space"); } catch(e){}
        await sleep(400);
        try { await page.keyboard.press("Enter"); } catch(e){}
        await sleep(400);
      }

      // 4) Wait/poll for captured requests produced by patched fetch/XHR
      console.log(`Waiting up to ${WAIT_FOR_TOKEN_MS}ms for tokened .m3u8 in window.__capturedRequests...`);
      const start = Date.now();
      while ((Date.now() - start) < WAIT_FOR_TOKEN_MS) {
        // read capturedRequests from page
        const list = await page.evaluate(() => {
          try { return (window.__capturedRequests || []).slice(-50); } catch(e){ return []; }
        });
        if (list && list.length) {
          // check for any tokened m3u8
          for (let i = list.length - 1; i >= 0; i--) {
            const item = list[i];
            try {
              const u = item.url || item;
              if (!u) continue;
              if (/\.m3u8(\?|$)/i.test(u) && /(token=|signature=|sig=|expires=|exp=)/i.test(u)) {
                finalCapturedUrl = u;
                captureMeta = { source: 'capturedRequests', entry: item };
                break;
              }
            } catch(e){}
          }
        }
        if (finalCapturedUrl) break;
        await sleep(250);
      }

      // 5) if still not captured, also scan DOM globals / players for candidate .m3u8 (tokened or not)
      if (!finalCapturedUrl) {
        console.log("Scanning page globals and video elements for .m3u8/token values...");
        try {
          const scanResults = await page.evaluate(() => {
            const out = { found: [], videoSrcs: [], globals: [] };
            try {
              // video elements
              const videos = Array.from(document.querySelectorAll("video"));
              for (const v of videos) {
                try {
                  if (v.currentSrc) out.videoSrcs.push(v.currentSrc);
                  if (v.src) out.videoSrcs.push(v.src);
                  // sources child
                  const s = Array.from(v.querySelectorAll("source")).map(el => el.src).filter(Boolean);
                  out.videoSrcs.push(...s);
                } catch(e){}
              }
              // window globals: collect keys where value is string containing .m3u8 or 'token='
              for (const k of Object.keys(window)) {
                try {
                  const v = window[k];
                  if (typeof v === "string" && v.match(/\.m3u8/i) && /token=|signature=|sig=|expires=|exp=/i.test(v)) {
                    out.found.push({ key: k, value: v });
                  }
                  // shallow JSON stringify for objects to find urls
                  if (typeof v === "object" && v !== null) {
                    try {
                      const s = JSON.stringify(v);
                      const m = s.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*(token=|signature=|sig=|expires=|exp=)[^\s"']*/ig);
                      if (m) m.forEach(x => out.found.push({ key: k, value: x }));
                    } catch(e){}
                  }
                } catch(e){}
              }
            } catch(e){}
            return out;
          });
          // prefer scanResults.found
          if (scanResults && scanResults.found && scanResults.found.length) {
            finalCapturedUrl = scanResults.found[0].value;
            captureMeta = { source: 'globals-scan', info: scanResults.found[0] };
            console.log("Found candidate via globals-scan:", finalCapturedUrl);
          } else if (scanResults && scanResults.videoSrcs && scanResults.videoSrcs.length) {
            // take any video src that contains token
            const tok = scanResults.videoSrcs.find(u => u && u.match(/token=|signature=|sig=|expires=|exp=/i));
            if (tok) {
              finalCapturedUrl = tok;
              captureMeta = { source: 'video-src', info: tok };
              console.log("Found candidate via video element:", finalCapturedUrl);
            } else {
              console.log("Globals/video scan found no tokened url (videoSrcs sample):", scanResults.videoSrcs.slice(0,5));
            }
          } else {
            console.log("Globals/video scan returned nothing useful.");
          }
        } catch(e){ console.log("globals scan error:", e && e.message); }
      }

      // 6) If we have finalCapturedUrl, try to get manifest (response already captured or try fetching)
      if (finalCapturedUrl) {
        console.log("Captured URL:", finalCapturedUrl, "meta:", captureMeta);
        // try to get response inside page (if response happened)
        try {
          const resp = await page.waitForResponse(r => r.url() === finalCapturedUrl, { timeout: 3000 }).catch(()=>null);
          if (resp) {
            const t = await resp.text().catch(()=>null);
            if (t && t.includes("#EXTM3U")) {
              finalCapturedManifest = normalizeManifest(t, finalCapturedUrl);
              console.log("Got manifest text from response object.");
            }
          }
        } catch(e){}

        // try context.request fetch (within browser context, avoids some CORS issues)
        if (!finalCapturedManifest) {
          try {
            console.log("Trying context.request.get for manifest...");
            const r = await context.request.get(finalCapturedUrl, { timeout: 8000 }).catch(()=>null);
            if (r) {
              const t = await r.text().catch(()=>null);
              if (t && t.includes("#EXTM3U")) {
                finalCapturedManifest = normalizeManifest(t, finalCapturedUrl);
                console.log("Got manifest via context.request.get");
              } else {
                console.log("context.request.get didn't return manifest body (len:", (t && t.length) || 0, ")");
              }
            } else {
              console.log("context.request.get failed/returned null.");
            }
          } catch(e){ console.log("context.request error:", e && e.message); }
        }

        // fallback: node-fetch (may fail due to server checks)
        if (!finalCapturedManifest) {
          try {
            console.log("Trying node-fetch fallback...");
            const r2 = await fetch(finalCapturedUrl, { method: "GET", timeout: 8000 }).catch(()=>null);
            if (r2) {
              const t2 = await r2.text().catch(()=>null);
              if (t2 && t2.includes("#EXTM3U")) {
                finalCapturedManifest = normalizeManifest(t2, finalCapturedUrl);
                console.log("node-fetch retrieved manifest");
              } else {
                console.log("node-fetch body did not include #EXTM3U (len:", (t2 && t2.length) || 0, ")");
              }
            }
          } catch(e){ console.log("node-fetch err:", e && e.message); }
        }

        // send to worker: include playlistContent if available, otherwise only playlistUrl
        try {
          const payload = { playlistUrl: finalCapturedUrl };
          if (finalCapturedManifest) payload.playlistContent = finalCapturedManifest;
          const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
          console.log("Posting to worker:", postUrl);
          const res = await fetch(postUrl, {
            method: "POST",
            headers: { "Content-Type":"application/json", "Authorization": `Bearer ${WORKER_SECRET}` },
            body: JSON.stringify(payload),
            timeout: 15000
          });
          const txt = await res.text().catch(()=>"<no body>");
          console.log("Worker responded:", res.status, txt);
          await browser.close();
          process.exit(res.ok ? 0 : 1);
        } catch(e){ console.log("POST error:", e && e.message); await browser.close(); process.exit(1); }
      } // end if captured

      // no capture this attempt -> backoff and retry
      const backoff = 1500 * attempt;
      console.log("No token yet — backoff", backoff, "ms before next attempt");
      await sleep(backoff);

    } // end for attempts

    // after attempts exhausted
    console.error("Attempts exhausted. No tokened URL captured.");
    // dump last capturedRequests snapshot for debugging
    try {
      const snapshot = await page.evaluate(()=> (window.__capturedRequests || []).slice(-80));
      console.error("recent capturedRequests (tail):", snapshot.slice(-40));
    } catch(e){}
    await browser.close();
    process.exit(1);

  } catch (err) {
    console.error("Top-level error:", err && err.message);
    try { await browser.close(); } catch(_) {}
    process.exit(1);
  }

})();
