const { chromium } = require("playwright");
const fetch = require("node-fetch");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(process.env.TARGET_URL, { waitUntil: "networkidle" });

  // Sayfanın JS değişkenlerini evaluate ile oku
  const playlistUrl = await page.evaluate(() => {
    // window veya global JS değişkeninde linki bul
    // Bu örnek yoda.az özelinde değişebilir, genellikle player config içinde oluyor
    if (window.playerConfig && window.playerConfig.sources) {
      const source = window.playerConfig.sources.find(s => s.file && s.file.includes(".m3u8"));
      if (source) return source.file;
    }

    // Alternatif: global state içinde arama
    if (window.__INITIAL_STATE__) {
      const tracks = window.__INITIAL_STATE__.tracks || [];
      for (const t of tracks) {
        if (t.url && t.url.includes(".m3u8")) return t.url;
      }
    }

    return null;
  });

  if (!playlistUrl) {
    console.log("Playlist bulunamadı (JS değişkenlerinde yok)");
    await browser.close();
    process.exit(1);
  }

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

  await browser.close();
})();
