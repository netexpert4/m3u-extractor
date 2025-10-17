const playwright = require("playwright");
const fetch = require("node-fetch");

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

(async () => {
  console.log("Starting extractor (strict m3u8 logic)");
  console.log("Opening", TARGET_URL);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  let foundPlaylist = null;

  // 🔎 Ağ isteklerini yakala
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes(".m3u8") && url.includes("token=")) {
      console.log("[request] Detected tokened m3u8 request:", url);
      foundPlaylist = url;
    }
  });

  // 🔎 Response body içinde arama (ama sadece .m3u8 URL’lerinde)
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (!url.includes(".m3u8")) return; // sadece m3u8 dosyalarını incele
      const body = await resp.text();
      if (body.includes("#EXTM3U")) {
        console.log("[resp] Manifest confirmed from:", url);
        foundPlaylist = url;
      }
    } catch (_) {}
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 60000 });
    console.log("Page loaded. Waiting for activity...");

    // Biraz bekle ki player request atsın
    await page.waitForTimeout(20000);

    if (!foundPlaylist) {
      console.log("No m3u8 found. Exiting with error.");
      process.exit(1);
    }

    console.log("FINAL PLAYLIST:", foundPlaylist);

    // 🔗 M3U8 içeriğini çek
    const resp = await fetch(foundPlaylist);
    const playlistContent = await resp.text();

    // ✅ Worker’a gönder
    const updateResp = await fetch(`${WORKER_UPDATE_URL}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify({ playlistContent }),
    });
    const updateResult = await updateResp.text();
    console.log("Worker responded:", updateResult);
  } catch (err) {
    console.error("Extractor error:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
