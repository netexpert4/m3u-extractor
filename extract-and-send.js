// extract-and-send.js
const { chromium } = require("playwright");
const fetch = require("node-fetch");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Sayfayı aç
  await page.goto(process.env.TARGET_URL, { waitUntil: "networkidle" });

  let playlistUrl;

  try {
    // 25 saniye boyunca .m3u8 & token içeren response bekle
    const response = await page.waitForResponse(
      r => r.url().includes(".m3u8") && r.url().includes("token="),
      { timeout: 25000 } // 25 saniye
    );

    playlistUrl = response.url();
  } catch (err) {
    console.log("Playlist bulunamadı (timeout veya network issue)");
    await browser.close();
    process.exit(1);
  }

  if (playlistUrl) {
    console.log("Playlist bulundu:", playlistUrl);

    // Worker'a gönder
    const res = await fetch(`${process.env.WORKER_UPDATE_URL}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.WORKER_SECRET}`
      },
      body: JSON.stringify({ playlistUrl })
    });

    if (res.ok) {
      console.log("Worker'a gönderildi ✅");
    } else {
      console.log("Worker'a gönderilemedi ❌", await res.text());
    }
  }

  await browser.close();
})();
