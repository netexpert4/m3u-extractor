// extract-and-send-manifest.js
const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
    console.error("Missing env vars");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  let foundManifest = null;
  let manifestSource = null;

  page.on("response", async resp => {
    try {
      const url = resp.url();
      // only check likely text responses
      const ct = (resp.headers()['content-type'] || "").toLowerCase();
      if (!(ct.includes("text") || ct.includes("mpegurl") || ct.includes("json") || url.match(/\.m3u8(\?|$)/i))) return;

      const text = await resp.text().catch(()=>null);
      if (!text) return;

      // if this response *is* a manifest (contains #EXTM3U), take it
      if (text.includes("#EXTM3U")) {
        console.log("Manifest body found from response:", url);
        // Normalize segment lines -> absolute URLs
        const normalized = normalizeManifest(text, url);
        foundManifest = normalized;
        manifestSource = url;
      } else {
        // also scan for embedded .m3u8 links inside JSON/text responses
        const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
        if (m && m.length) {
          console.log("Found m3u8 link(s) inside response body:", m[0]);
          // we could try to fetch the first m3u8 directly
        }
      }
    } catch (e) {
      /* ignore per-response errors */
    }
  });

  console.log("Opening page:", TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 90000 }).catch(e=>{
    console.warn("goto warning:", e && e.message);
  });

  // wait some time for responses
  await page.waitForTimeout(8000);

  if (!foundManifest) {
    console.error("No manifest found in responses");
    await browser.close();
    process.exit(1);
  }

  console.log("Sending manifest to worker. Source response:", manifestSource);
  const postUrl = WORKER_UPDATE_URL.replace(/\/+$/,"") + "/update";
  const res = await fetch(postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WORKER_SECRET}`
    },
    body: JSON.stringify({ playlistContent: foundManifest, source: manifestSource })
  });

  console.log("Worker returned:", res.status, await res.text().catch(()=>"<no body>"));
  await browser.close();
  process.exit(res.ok ? 0 : 1);
})();

// normalize .m3u8 content: make segment lines absolute using responseBase
function normalizeManifest(text, responseUrl) {
  const base = (() => {
    try {
      const u = new URL(responseUrl);
      // base directory for relative segment paths
      const path = u.pathname.replace(/\/[^\/]*$/, '/');
      return u.origin + path;
    } catch(e) {
      return responseUrl;
    }
  })();

  const lines = text.split(/\r?\n/);
  const out = lines.map(line => {
    if (!line) return line;
    // if line looks like a relative or absolute segment path (ts) or m3u8 line, make absolute if needed
    if (/^\s*#/.test(line)) return line; // comments
    if (/^https?:\/\//i.test(line)) return line; // already absolute
    // relative path -> convert
    if (line.match(/\.(ts|m3u8)(\?|$)/i)) {
      // remove leading ./ or /
      const cleaned = line.replace(/^\.\//, '').replace(/^\//, '');
      return base + cleaned;
    }
    return line;
  });
  return out.join("\n");
}
