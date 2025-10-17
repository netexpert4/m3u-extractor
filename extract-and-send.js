const playwright = require("playwright");
const fetch = require("node-fetch");

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("Eksik env değişkeni (TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET)");
  process.exit(1);
}

function looksLikeM3U(url, mimeType = "") {
  if (url.includes(".m3u8")) return true;
  if (mimeType.includes("application/vnd.apple.mpegurl")) return true;
  if (mimeType.includes("application/x-mpegURL")) return true;
  return false;
}

(async () => {
  console.log("=== extractor: strict m3u8 capture ===");
  console.log("TARGET:", TARGET_URL);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
  });
  const page = await context.newPage();

  let foundM3U = null;

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const mime = response.headers()["content-type"] || "";
      if (looksLikeM3U(url, mime)) {
        console.log("FOUND m3u8 response:", url, mime);
        foundM3U = url;
      }
    } catch (e) {}
  });

  page.on("request", (req) => {
    const url = req.url();
    if (looksLikeM3U(url)) {
      console.log("FOUND m3u8 request:", url);
      foundM3U = url;
    }
  });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Play tuşuna basmayı dene
  try {
    const btn = await page.$("button, .play, .vjs-big-play-button, .plyr__control");
    if (btn) {
      console.log("Clicking play button");
      await btn.click();
    } else {
      console.log("No explicit play button, sending Space key");
      await page.keyboard.press(" ");
    }
  } catch (e) {
    console.log("Play click error:", e);
  }

  // 30 saniye boyunca m3u8 bekle
  for (let i = 0; i < 30; i++) {
    if (foundM3U) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  if (!foundM3U) {
    console.error("❌ Hiç .m3u8 bulunamadı");
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
