const { chromium } = require("playwright");
const fetch = require("node-fetch");

const TARGET_URL = process.env.TARGET_URL;
const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET_URL || !WORKER_UPDATE_URL || !WORKER_SECRET) {
  console.error("❌ Missing TARGET_URL / WORKER_UPDATE_URL / WORKER_SECRET");
  process.exit(1);
}

(async () => {
  console.log("=== extractor: relaxed m3u8 capture with fallback ===");
  console.log("TARGET:", TARGET_URL);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let captured = [];

  // Ağdan yakala
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (url.includes(".m3u8")) {
        console.log("🎯 Captured candidate:", url);
        captured.push(url);
      }
    } catch {}
  });

  const maxAttempts = 5;
  let found = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`--- Attempt ${attempt}/${maxAttempts} ---`);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000); // sayfanın network isteğini yapması için

    // elimizde m3u8 varsa karar verelim
    if (captured.length > 0) {
      // önce tokenli olanı ara
      found = captured.find((u) => u.includes("token"));
      if (!found) {
        // yoksa ilk bulduğumuzu al
        found = captured[0];
      }
      break;
    }

    console.log("No m3u8 yet, retrying...");
    await page.waitForTimeout(3000);
  }

  await browser.close();

  if (!found) {
    console.error("❌ Hiç .m3u8 bulunamadı");
    process.exit(1);
  }

  console.log("✅ Selected .m3u8:", found);

  // Worker'a gönder
  const res = await fetch(WORKER_UPDATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": WORKER_SECRET,
    },
    body: JSON.stringify({ playlist: found }),
  });

  console.log("Worker response:", await res.text());
})();
