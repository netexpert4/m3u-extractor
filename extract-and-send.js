const { chromium } = require("playwright");

// --- Stealth / real browser taklidi için helper ---
async function makeStealthContext(browser, opts = {}) {
  const userAgent = opts.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const locale = opts.locale || "tr-TR";
  const timezone = opts.timezone || "Europe/Istanbul";
  const viewport = opts.viewport || { width: 1280, height: 720 };

  const context = await browser.newContext({
    userAgent,
    locale,
    timezoneId: timezone,
    viewport,
    javaScriptEnabled: true,
    // extra http headers like a real browser
    extraHTTPHeaders: {
      "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  // Değişkenleri sayfa başlamadan inject et (anti-detection)
  await context.addInitScript(() => {
    // navigator.webdriver = false
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch(e){}
    // window.chrome (Chrome varmış gibi)
    try {
      window.chrome = { runtime: {} };
    } catch(e){}
    // plugins mock
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5], configurable: true });
    } catch(e){}
    // languages
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'], configurable: true });
    } catch(e){}
    // mimeTypes
    try {
      Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }], configurable: true });
    } catch(e){}
    // hardwareConcurrency
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true });
    } catch(e){}
    // webdriver signature clear
    try {
      delete navigator.__proto__.webdriver;
    } catch(e){}
  });

  return context;
}

// --- Mouse hareketi (basit, insan benzeri) ---
async function humanMouseMove(page, from, to, steps = 20) {
  const dx = (to.x - from.x) / steps;
  const dy = (to.y - from.y) / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(from.x + dx * i + Math.random()*2, from.y + dy * i + Math.random()*2, { steps: 1 });
    await page.waitForTimeout(15 + Math.random()*40);
  }
  await page.mouse.move(to.x, to.y, { steps: 1 });
}

// Usage example
(async () => {
  const browser = await chromium.launch({
    headless: true, // headless=false daha iyi görünür ama serverda display gerekebilir
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-infobars",
    ],
  });

  const context = await makeStealthContext(browser, {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    locale: "tr-TR",
    timezone: "Europe/Istanbul",
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  // Referer ve legit headers
  await page.setExtraHTTPHeaders({
    "referer": "https://yoda.az/",
    "origin": "https://yoda.az",
  });

  // Giriş: hedef sayfa
  await page.goto(process.env.TARGET_URL, { waitUntil: "load", timeout: 60000 });

  // Fareyi oynatıp oynat düğmesine tıklamak
  try {
    // örnek: play butonunu bul ve tıkla
    const play = await page.$('button.play, .play-button, .vjs-play-control, [data-play]');
    if (play) {
      const box = await play.boundingBox();
      if (box) {
        await humanMouseMove(page, { x: 100, y: 100 }, { x: box.x + box.width/2, y: box.y + box.height/2 }, 25);
        await play.click({ force: true });
      } else {
        await play.click({ force: true });
      }
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    console.log("play click failed:", e.message);
  }

  // Buradan sonrası: network/response/domevaluate ile m3u8 yakalama mantığın devam eder
  // ...
})();
