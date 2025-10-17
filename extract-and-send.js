const playwright = require("playwright");
const fetch = require("node-fetch");

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

(async () => {
  console.log("Extractor v3 (hybrid scan + network)");

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  let candidateUrls = new Set();

  // Ağ isteklerinde ara
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes(".m3u8")) {
      console.log("[request] candidate:", url);
      candidateUrls.add(url);
    }
  });

  // Response body içinde ara
  page.on("response", async (resp) => {
    try {
      const text = await resp.text();
      const matches = text.match(/https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/g);
      if (matches) {
        matches.forEach((m) => {
          console.log("[resp-body] found:", m);
          candidateUrls.add(m);
        });
      }
    } catch (_) {}
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("Page loaded, waiting for activity...");

    await page.waitForTimeout(25000); // Player’ın yüklenmesi için bekle

    let finalPlaylist = null;

    for (const url of candidateUrls) {
      try {
        const resp = await fetch(url);
        const body = await resp.text();
        if (body.includes("#EXTM3U")) {
          console.log("[verified] real manifest:", url);
          finalPlaylist = body;
          break;
        }
      } catch (err) {
        console.log("[verify-failed]", url, err.message);
      }
    }

    if (!finalPlaylist) {
      console.log("No valid manifest found.");
      process.exit(1);
    }

    // ✅ Worker’a gönder
    const updateResp = await fetch(`${WORKER_UPDATE_URL}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify({ playlistContent: finalPlaylist }),
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
