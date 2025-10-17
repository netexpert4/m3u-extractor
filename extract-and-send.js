const playwright = require("playwright");
const fetch = require("node-fetch");

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Eksik env değişkeni (TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET)");
  process.exit(1);
}

function looksLikeM3U(url, mime = "") {
  return (
    url.includes(".m3u8") ||
    mime.includes("application/vnd.apple.mpegurl") ||
    mime.includes("application/x-mpegURL")
  );
}

(async () => {
  console.log("=== extractor: auto-reload until m3u8 found ===");
  console.log("TARGET:", TARGET_URL);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
  });
  const page = await context.newPage();

  let foundM3U = null;

  // capture responses
  page.on("response", async (res) => {
    try {
      const url = res.url();
      const mime = res.headers()["content-type"] || "";
      if (looksLikeM3U(url, mime) && !foundM3U) {
        console.log("FOUND .m3u8 response:", url);
        foundM3U = url;
      }
    } catch {}
  });

  // capture requests
  page.on("request", (req) => {
    const url = req.url();
    if (looksLikeM3U(url) && !foundM3U) {
      console.log("FOUND .m3u8 request:", url);
      foundM3U = url;
    }
  });

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`--- Attempt ${attempt}/${maxAttempts} ---`);

    if (attempt === 1) {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    }

    // wait up to 15s
    for (let i = 0; i < 15; i++) {
      if (foundM3U) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (foundM3U) break;
    console.log("No m3u8 yet, retrying...");
  }

  if (!foundM3U) {
    console.error("❌ Hiç .m3u8 yakalanamadı (reload sonrası da yok)");
    await browser.close();
    process.exit(1);
  }

  console.log("✅ FINAL FOUND M3U:", foundM3U);

  const res = await fetch(WORKER_UPDATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-secret": WORKER_SECRET,
    },
    body: JSON.stringify({ url: foundM3U }),
  });

  console.log("Worker response:", await res.text());
  await browser.close();
})();
