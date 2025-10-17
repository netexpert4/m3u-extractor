// extract-and-send.js (verbose, timeout-safe)
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

// timeout ayarları (ms)
const TOP_LEVEL_TIMEOUT = parseInt(process.env.TOP_LEVEL_TIMEOUT || "110000"); // 110s total
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "45000"); // 45s per navigation
const RESPONSE_TIMEOUT = parseInt(process.env.RESPONSE_TIMEOUT || "30000"); // 30s wait for responses
const POST_TIMEOUT = parseInt(process.env.POST_TIMEOUT || "15000"); // 15s worker post
const EXTRA_WAIT_AFTER_LOAD = parseInt(process.env.EXTRA_WAIT_AFTER_LOAD || "3000"); // 3s

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Missing env vars. Ensure TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET are set.");
  process.exit(1);
}

console.log("Starting extractor");
console.log("TARGET_URL:", TARGET_URL);
console.log("Worker base URL:", WORKER_UPDATE_URL);
console.log("TOP_LEVEL_TIMEOUT:", TOP_LEVEL_TIMEOUT, "NAV_TIMEOUT:", NAV_TIMEOUT, "RESPONSE_TIMEOUT:", RESPONSE_TIMEOUT);

let timedOut = false;
const timeoutHandle = setTimeout(() => {
  console.error(`TOP_LEVEL_TIMEOUT ${TOP_LEVEL_TIMEOUT}ms reached, exiting.`);
  timedOut = true;
}, TOP_LEVEL_TIMEOUT);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "tr-TR"
  });

  const page = await context.newPage();

  // collect candidates from requests/responses
  const candidates = new Set();
  page.on("request", req => {
    try {
      const u = req.url();
      if (!u) return;
      if (u.match(/\.m3u8(\?|$)/i) || (u.match(/\.ts(\?|$)/i) && u.includes("token="))) {
        console.log("REQUEST observed:", u);
        candidates.add(u);
      }
    } catch(e){}
  });

  page.on("response", async resp => {
    try {
      const u = resp.url();
      if (!u) return;
      // prefer direct m3u8 urls
      if (u.match(/\.m3u8(\?|$)/i)) {
        console.log("RESPONSE url m3u8:", u);
        candidates.add(u);
        return;
      }
      // small-ish bodies only
      const ct = (resp.headers()['content-type'] || "").toLowerCase();
      if (ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl")) {
        console.log("RESPONSE content-type m3u8 at", u);
        candidates.add(u);
        return;
      }
      if (ct.includes("json") || ct.includes("text")) {
        const txt = await safeText(resp, 200000); // limit big responses
        if (txt && txt.includes("#EXTM3U")) {
          console.log("RESPONSE body contains #EXTM3U from", u);
          candidates.add(u);
        } else if (txt) {
          const m = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
          if (m) {
            m.forEach(x => candidates.add(x));
            console.log("Found m3u8 in response body:", m);
          }
        }
      }
    } catch(e){}
  });

  try {
    // Try navigation strategies
    console.log("NAVIGATION: try networkidle then load fallback");
    try {
      await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
      console.log("page.goto networkidle OK");
    } catch (e) {
      console.log("networkidle failed:", e.message, "-> trying load");
      try {
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: NAV_TIMEOUT });
        console.log("page.goto load OK");
      } catch (e2) {
        console.log("page.goto load also failed:", e2.message);
      }
    }

    console.log(`Waiting extra ${EXTRA_WAIT_AFTER_LOAD}ms for late loads`);
    await page.waitForTimeout(EXTRA_WAIT_AFTER_LOAD);

    // Try waitForResponse for m3u8 with token
    try {
      console.log("Waiting for response that contains .m3u8 and token= ... (timeout:", RESPONSE_TIMEOUT, ")");
      const r = await page.waitForResponse(r => {
        const u = r.url();
        return u && u.match(/\.m3u8(\?|$)/i) && /token=|signature=|sig=|expires=|exp=/.test(u);
      }, { timeout: RESPONSE_TIMEOUT });
      if (r) {
        console.log("waitForResponse matched:", r.url());
        candidates.add(r.url());
      }
    } catch (e) {
      console.log("waitForResponse timed out or failed:", e.message);
    }

    // Give some time for any pending network calls
    await page.waitForTimeout(1500);

    // Try window-scan for any strings
    try {
      console.log("Window-scan for .m3u8 strings");
      const jsFound = await page.evaluate(() => {
        const out = [];
        try {
          for (const k of Object.keys(window)) {
            try {
              const v = window[k];
              if (!v) continue;
              if (typeof v === "string" && v.includes(".m3u8")) out.push(v);
              if (typeof v === "object" && v !== null) {
                try {
                  const s = JSON.stringify(v);
                  const m = s.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/ig);
                  if (m) m.forEach(x => out.push(x));
                } catch(e){}
              }
            } catch(e){}
          }
        } catch(e){}
        return Array.from(new Set(out));
      });
      if (jsFound && jsFound.length) {
        console.log("Window-scan results:", jsFound);
        jsFound.forEach(u => candidates.add(u));
      } else {
        console.log("Window-scan found nothing");
      }
    } catch (e) { console.log("window-scan failed:", e.message); }

    // If still no candidate, attempt to click common play selectors to trigger streams
    if (candidates.size === 0) {
      console.log("No candidates yet — trying to click possible play buttons to trigger network activity");
      const playSelectors = ['button.play', '.play-button', '.vjs-play-control', '[data-play]', '.jwplayer .jw-icon-play', '#play'];
      for (const sel of playSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            console.log("Clicking", sel);
            await el.click({ force: true }).catch(()=>{});
            await page.waitForTimeout(1500);
          }
        } catch(e){}
      }
    }

    // After interactions, wait a bit and then gather candidates
    await page.waitForTimeout(1500);

    // Collect candidates
    const finalCandidates = Array.from(candidates);
    console.log("FINAL CANDIDATES COUNT:", finalCandidates.length);
    finalCandidates.forEach((c, i) => console.log(`${i+1}. ${c}`));

    // Choose best candidate
    const pick = pickBest(finalCandidates);
    if (!pick) {
      console.error("No valid m3u8 candidate found — exiting with failure.");
      await browser.close();
      clearTimeout(timeoutHandle);
      process.exit(1);
    }

    console.log("Picked candidate to send:", pick);

    // Send to worker
    const ok = await postToWorker(pick);
    await browser.close();
    clearTimeout(timeoutHandle);
    if (ok) {
      console.log("Done: success");
      process.exit(0);
    } else {
      console.error("POST failed, exiting with error");
      process.exit(1);
    }

  } catch (err) {
    console.error("Top-level error:", err && err.message);
    await browser.close();
    clearTimeout(timeoutHandle);
    process.exit(1);
  }
})();

function pickBest(list) {
  if (!list || !list.length) return null;
  // prefer m3u8 with token
  const uniq = Array.from(new Set(list));
  const m3utoken = uniq.find(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
  if (m3utoken) return m3utoken;
  const m3u = uniq.find(u => /\.m3u8/i.test(u));
  if (m3u) return m3u;
  const tsToken = uniq.find(u => /\.ts(\?|$)/i.test(u) && u.includes("token="));
  if (tsToken) return tsToken.replace(/\/[^\/]*\.ts(\?.*)?$/, "/index.m3u8");
  return null;
}

async function postToWorker(playlistUrl) {
  try {
    const url = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
    console.log("POSTing to worker:", url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WORKER_SECRET}` },
      body: JSON.stringify({ playlistUrl }),
      timeout: POST_TIMEOUT
    });
    console.log("Worker responded status:", res.status);
    const body = await res.text().catch(()=>"<no body>");
    console.log("Worker response body:", body);
    return res.ok;
  } catch (e) {
    console.error("postToWorker error:", e && e.message);
    return false;
  }
}

async function safeText(response, max = 200000) {
  try {
    const buf = await response.body();
    const txt = buf ? buf.toString().slice(0, max) : null;
    return txt;
  } catch(e) {
    try { return await response.text(); } catch(e2) { return null; }
  }
}
