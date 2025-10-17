// extract-and-send.js
// Ultimate extractor with aggressive + extra detection layers

const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = parseInt(process.env.ATTEMPTS || "6", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "120000", 10);
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "30000", 10);
const RESP_TIMEOUT = parseInt(process.env.RESP_TIMEOUT || "60000", 10);
const HEADLESS = process.env.HEADLESS !== "false";

function now() { return new Date().toISOString(); }

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const WORKER_BASE = process.env.WORKER_UPDATE_URL;
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if (!TARGET_URL || !WORKER_BASE || !WORKER_SECRET) {
    console.error("[fatal] Missing envs");
    process.exit(1);
  }

  console.log(`[${now()}] extractor: start`);
  console.log(`[${now()}] TARGET_URL: ${TARGET_URL}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage", "--disable-extensions",
      "--disable-infobars"
    ]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul"
  });

  // stealth tweaks
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });

  const page = await context.newPage();
  const candidates = new Set();
  const seen = new Set();

  // capture via CDP
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', e => {
      const u = e.request?.url;
      if (u && !seen.has(u)) {
        seen.add(u);
        if (u.match(/\.m3u8/i) || u.match(/\.ts/i)) candidates.add(u);
      }
    });
  } catch {}

  // normal listeners
  page.on('request', req => {
    const u = req.url();
    if (!seen.has(u) && (u.includes(".m3u8") || u.includes(".ts"))) {
      candidates.add(u); seen.add(u);
    }
  });
  page.on('response', async resp => {
    const u = resp.url();
    const ct = (resp.headers()['content-type'] || "").toLowerCase();
    if (u.includes(".m3u8") || ct.includes("mpegurl")) {
      candidates.add(u);
    }
    if (ct.includes("text") || ct.includes("json")) {
      try {
        const txt = await resp.text();
        const found = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
        if (found) found.forEach(x => candidates.add(x));
      } catch {}
    }
  });

  // inject fetch/xhr + MutationObserver + performance API hook
  await context.addInitScript(() => {
    window.__capturedRequests = [];
    const _fetch = window.fetch;
    window.fetch = (...args) => {
      try { window.__capturedRequests.push(args[0].url || args[0]); } catch {}
      return _fetch(...args);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){ 
      try { window.__capturedRequests.push(u); } catch{} 
      return open.apply(this, arguments);
    };
    // observe DOM for new video/src attributes
    new MutationObserver(() => {
      document.querySelectorAll("video,source,script").forEach(el=>{
        ["src","data-src"].forEach(attr=>{
          const v=el.getAttribute(attr);
          if(v && v.includes(".m3u8")) window.__capturedRequests.push(v);
        });
      });
    }).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    // snapshot performance entries periodically
    setInterval(()=>{
      try {
        const entries = performance.getEntriesByType("resource")||[];
        entries.forEach(e=>{if(e.name.includes(".m3u8"))window.__capturedRequests.push(e.name);});
      } catch {}
    },5000);
  });

  for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
    console.log(`--- ATTEMPT ${attempt}/${MAX_ATTEMPTS} ---`);

    try {
      await page.goto(TARGET_URL,{waitUntil:"networkidle",timeout:NAV_TIMEOUT});
    } catch {
      await page.goto(TARGET_URL,{waitUntil:"load",timeout:NAV_TIMEOUT}).catch(()=>{});
    }

    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // collect from window
    const winReqs = await page.evaluate(()=>window.__capturedRequests||[]);
    winReqs.forEach(u=>candidates.add(u));

    // check DOM video/src
    const domCandidates = await page.evaluate(()=>{
      const out=[];
      document.querySelectorAll("video,source").forEach(v=>{
        if(v.src) out.push(v.src);
        if(v.currentSrc) out.push(v.currentSrc);
      });
      return out;
    });
    domCandidates.forEach(u=>candidates.add(u));

    const list=[...candidates];
    if(list.length){
      console.log("[candidates]",list);
      const best=pickBest(list);
      if(best){
        console.log("[best]",best);
        const ok=await sendToWorker(best,WORKER_BASE,WORKER_SECRET);
        if(ok){await browser.close();process.exit(0);}
      }
    }

    await page.reload({waitUntil:"networkidle",timeout:NAV_TIMEOUT}).catch(()=>{});
    await page.waitForTimeout(attempt*5000);
  }

  console.log("[final] no m3u8 found");
  await browser.close(); process.exit(1);

  function pickBest(list){
    const uniq=[...new Set(list)];
    const tokened=uniq.find(u=>u.includes(".m3u8") && /token=|sig=|exp=/.test(u));
    if(tokened) return tokened;
    const plain=uniq.find(u=>u.includes(".m3u8"));
    if(plain) return plain;
    return null;
  }

  async function sendToWorker(url,base,secret){
    try{
      const res=await fetch(base.replace(/\/+$/,"")+"/update",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+secret},
        body:JSON.stringify({playlistUrl:url})
      });
      return res.ok;
    }catch{return false;}
  }

})();
