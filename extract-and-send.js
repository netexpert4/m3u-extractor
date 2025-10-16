const { chromium } = require("playwright");
const fetch = require("node-fetch");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(process.env.TARGET_URL, { waitUntil: "networkidle" });

  let playlistUrl;
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes(".m3u8") && url.includes("token=")) {
      playlistUrl = url;
    }
  });

  await page.waitForTimeout(15000);

  if (playlistUrl) {
    await fetch(`${process.env.WORKER_UPDATE_URL}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WORKER_SECRET}`,
      },
      body: JSON.stringify({ playlistUrl }),
    });
    console.log("Playlist gönderildi:", playlistUrl);
  } else {
    console.log("Playlist bulunamadı");
  }

  await browser.close();
})();
