// extract-and-send.js
// Çok daha sabırlı ve çok-şekilli yakalama stratejisi
// Usage: node extract-and-send.js
// Requires: playwright, node-fetch
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = parseInt(process.env.ATTEMPTS || "6"); // kaç yükleme denemesi
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "60000"); // goto timeout ms
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "15000"); // yüklemeden sonra bekle ms
const WAIT_FOR_RESPONSE_TIMEOUT = parseInt(process.env.RESP_TIMEOUT || "60000"); // waitForResponse ms
const CLICK_PLAY_SELECTORS = [
  'button.play', '.play-button', '.vjs-play-control', '.jwplayer .jw-icon-play',
  '#play', '.player-play', '[data-play]', '.playBtn', '.btn-play'
];

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
    console.error("Missing TARGET_URL, WORKER_UPDATE_URL or WORKER_SECRET env vars");
    process.exit(1);
  }

  console.log("TARGET_URL:", TARGET_URL);
  console.log("Worker update base:", WORKER_UPDATE_URL);
  console.log("Max attempts:", MAX_ATTEMPTS);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  // Koleksiyonlar
  const found = new Set();
  const foundBodies = new Set();
  const seenRequests = new Set();

  // Response listener: URL'leri ve body'leri kontrol et
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (seenRequests.has(url)) return;
      seenRequests.add(url);

      // Direkt url'de .m3u8 varsa ve token varsa hemen al
      if (url.match(/\.m3u8(\?|$)/i)) {
        console.log("Response URL .m3u8 seen:", url);
        found.add(url);
        return;
      }

      // .ts segmentleri (token içeriyorsa bunlar da faydalı olabilir)
      if (url.match(/\.ts(\?|$)/i) && url.includes("token=")) {
        console.log("Response TS with token seen:", url);
        // try to infer manifest by replacing segment name with likely index name
        const inferred = url.replace(/\/[^\/]*\.ts(\?.*)?$/, "/index.m3u8");
        found.add(inferred);
        return;
      }

      // Eğer content-type m3u8 veya text ve body içinde #EXTM3U var mı bak
      const ct = (response.headers()['content-type'] || "").toLowerCase();
      if (ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl") || url.match(/\.m3u8(\?|$)/i) || ct.includes("text")) {
        const txt = await safeText(response);
        if (txt && txt.includes("#EXTM3U")) {
          console.log("Found m3u8 content in response body from:", url);
          foundBodies.add(url);
          // prefer request url if it's .m3u8, else keep response url
          if (url.match(/\.m3u8(\?|$)/i)) found.add(url); else found.add(url);
        } else if (txt) {
          // search for urls inside body
          const m = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
          if (m && m.length) {
            m.forEach(u => found.add(u));
            console.log("Found m3u8 inside response body:", m);
          }
        }
      }

      // JSON responses: tarayıp içinde m3u8 url arama
      if (ct.includes("application/json")) {
        const jtxt = await safeText(response);
        if (jtxt) {
          const m = jtxt.match(/https?:\/\/[^\s"']+\.m3u8\?[^"']+/i);
          if (m) {
            console.log("Found m3u8 in JSON response:", m[0]);
            found.add(m[0]);
          }
        }
      }
    } catch (e) {
      /* ignore per-response errors */
    }
  });

  // Request listener: token içeren ts veya m3u8 isteklerini not et
  page.on("request", request => {
    try {
      const url = request.url();
      if (url && (url.includes(".m3u8") || url.includes(".ts"))) {
        if (url.includes("token=") || url.includes("signature=") || url.includes("sig=")) {
          console.log("Request observed (token likely):", url);
          found.add(url);
        }
      }
    } catch (e) {}
  });

  // Deneme döngüsü
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n===== ATTEMPT ${attempt} / ${MAX_ATTEMPTS} =====`);
    try {
      // Navigation: iki strateji sırayla deneyebiliriz (networkidle sonra load)
      try {
        console.log("Navigating (networkidle) ... timeout", NAV_TIMEOUT);
        await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
      } catch (e) {
        console.log("networkidle failed, trying 'load' navigation:", e.message);
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: NAV_TIMEOUT });
      }

      // Sayfa yüklendikten sonra uzun bir bekleme yap (scriptlerin çalışması için)
      console.log(`Waiting ${WAIT_AFTER_LOAD}ms after load for late network activity...`);
      await page.waitForTimeout(WAIT_AFTER_LOAD);

      // 1) quick evaluate: global window scan for any m3u8-like string
      try {
        const jsCandidates = await page.evaluate(() => {
          const out = new Set();
          try {
            // search in window keys
            for (const k of Object.keys(window)) {
              try {
                const v = window[k];
                if (!v) continue;
                if (typeof v === "string" && v.includes(".m3u8")) {
                  out.add(v);
                } else if (typeof v === "object") {
                  try {
                    const s = JSON.stringify(v);
                    const matches = s.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
                    if (matches) matches.forEach(m => out.add(m));
                  } catch(e){}
                }
              } catch(e) {}
            }
          } catch(e){}
          return Array.from(out);
        });
        if (jsCandidates && jsCandidates.length) {
          jsCandidates.forEach(u => found.add(u));
          console.log("Found via window-scan:", jsCandidates);
        } else {
          console.log("No window-scan results");
        }
      } catch (e) {
        console.log("window-eval failed:", e.message);
      }

      // 2) Try to click possible play buttons to trigger network calls
      for (const sel of CLICK_PLAY_SELECTORS) {
        try {
          const el = await page.$(sel);
          if (el) {
            console.log("Clicking selector to trigger player:", sel);
            await el.click({ force: true }).catch(()=>{});
            await page.waitForTimeout(1500);
          }
        } catch (e) {}
      }

      // 3) Wait for any .m3u8 response (timeout generous)
      try {
        console.log(`Waiting up to ${WAIT_FOR_RESPONSE_TIMEOUT}ms for .m3u8 response...`);
        const resp = await page.waitForResponse(
          r => {
            const u = r.url();
            if (!u) return false;
            if (u.match(/\.m3u8(\?|$)/i) && u.includes("token=")) return true;
            return false;
          },
          { timeout: WAIT_FOR_RESPONSE_TIMEOUT }
        );
        if (resp) {
          console.log("waitForResponse matched URL:", resp.url());
          found.add(resp.url());
        }
      } catch (e) {
        console.log("waitForResponse timed out or not found:", e.message);
      }

      // 4) Give a short extra time for late requests
      await page.waitForTimeout(3000);

      // 5) Collect potential candidates from response and request handlers already executed
      const candidates = Array.from(found);
      if (candidates.length) {
        console.log("Candidates gathered this attempt:");
        candidates.forEach(c => console.log("  -", c));
        // pick best candidate: prefer .m3u8 with token and content-type match
        const best = pickBestCandidate(candidates);
        if (best) {
          console.log("Selected best candidate:", best);
          const ok = await sendToWorker(best, WORKER_UPDATE_URL, WORKER_SECRET);
          if (ok) {
            console.log("SUCCESS: playlist sent to Worker:", best);
            await browser.close();
            process.exit(0);
          } else {
            console.log("Failed to send to worker; will retry attempts.");
          }
        } else {
          console.log("No suitable best candidate found this attempt.");
        }
      } else {
        console.log("No candidates found this attempt.");
      }

      // If not found, reload and try again (with exponential backoff)
      const backoff = 2000 * attempt;
      console.log(`Reloading page and backing off ${backoff}ms before next attempt...`);
      try { await page.reload({ waitUntil: "networkidle", timeout: NAV_TIMEOUT }); } catch(e){ console.log("reload failed:", e.message); }
      await page.waitForTimeout(backoff);

    } catch (err) {
      console.log("Attempt error:", err && err.message);
    }
  } // attempts loop

  console.log("All attempts exhausted — no playlist found.");
  await browser.close();
  process.exit(1);
})();

//
// Helpers
//
function pickBestCandidate(list) {
  // prioritize .m3u8 with token param
  const uniq = Array.from(new Set(list));
  const m3u8Tokens = uniq.filter(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
  if (m3u8Tokens.length) return m3u8Tokens[0];
  const m3u8Any = uniq.filter(u => /\.m3u8/i.test(u));
  if (m3u8Any.length) return m3u8Any[0];
  // fallback: ts with token -> try infer index.m3u8
  const tsToken = uniq.find(u => /\.ts(\?|$)/i.test(u) && u.includes("token="));
  if (tsToken) {
    try {
      return tsToken.replace(/\/[^\/]*\.ts(\?.*)?$/, "/index.m3u8");
    } catch(e){}
  }
  // nothing suitable
  return null;
}

async function sendToWorker(playlistUrl, workerBase, secret) {
  try {
    const url = workerBase.replace(/\/+$/, "") + "/update";
    console.log("POST to worker:", url);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`
      },
      body: JSON.stringify({ playlistUrl })
    });
    console.log("Worker response status:", res.status);
    const text = await res.text().catch(()=>"");
    console.log("Worker response body:", text);
    return res.ok;
  } catch (e) {
    console.log("sendToWorker error:", e && e.message);
    return false;
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (e) {
    return null;
  }
}
