// extract-and-send.js
// Final short-run ultimate extractor: tries many hooks but stops fast (3 attempts, ~70s per attempt).
// Usage: ensure playwright + node-fetch installed. Env: TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET

const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = parseInt(process.env.ATTEMPTS || "3", 10); // 3 attempts
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "30000", 10); // 30s goto timeout
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "40000", 10); // 40s wait for resources after load
const HEADLESS = process.env.HEADLESS !== "false";

function now(){ return new Date().toISOString(); }

(async () => {
  const TARGET = process.env.TARGET_URL;
  const WORKER_BASE = (process.env.WORKER_UPDATE_URL || "").replace(/\/+$/,"");
  const WORKER_SECRET = process.env.WORKER_SECRET;

  if(!TARGET || !WORKER_BASE || !WORKER_SECRET){
    console.error("Missing envs: TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
    process.exit(1);
  }

  console.log(`[${now()}] short-run extractor start — target: ${TARGET}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox","--disable-setuid-sandbox",
      "--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    javaScriptEnabled: true,
    extraHTTPHeaders: { "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8" }
  });

  // stealth-ish init + monkey patches: fetch, XHR, URL.createObjectURL, MutationObserver + performance hook
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch(e){}
    try { window.chrome = window.chrome || { runtime: {} }; } catch(e){}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'] }); } catch(e){}

    // capture arrays
    window.__capturedRequests = window.__capturedRequests || [];
    window.__createdBlobs = window.__createdBlobs || [];

    // fetch patch
    try {
      const _fetch = window.fetch;
      window.fetch = function(...args){
        try {
          const u = args[0];
          if (typeof u === 'string') window.__capturedRequests.push(u);
          else if (u && u.url) window.__capturedRequests.push(u.url);
        } catch(e){}
        return _fetch.apply(this,args);
      };
    } catch(e){}

    // XHR patch
    try {
      const X = window.XMLHttpRequest;
      const open = X.prototype.open;
      X.prototype.open = function(method, url) {
        try { window.__capturedRequests.push(String(url)); } catch(e){}
        return open.apply(this, arguments);
      };
    } catch(e){}

    // createObjectURL patch (detect blobs)
    try {
      const _create = URL.createObjectURL;
      URL.createObjectURL = function(obj) {
        try { window.__createdBlobs.push(obj && obj.constructor && obj.constructor.name ? obj.constructor.name : String(obj)); } catch(e){}
        return _create.apply(this, arguments);
      };
    } catch(e){}

    // MutationObserver to catch late-added src attrs
    try {
      new MutationObserver((mutations) => {
        try {
          for (const m of mutations) {
            const nodes = m.addedNodes || [];
            nodes.forEach(n => {
              if (!n) return;
              if (n.nodeType === 1) {
                const el = n;
                if (el.src && el.src.includes(".m3u8")) window.__capturedRequests.push(el.src);
                // search children
                el.querySelectorAll && el.querySelectorAll("video,source,script").forEach(ch => {
                  try {
                    const s = ch.src || ch.getAttribute("data-src") || ch.getAttribute("data-href");
                    if (s && s.includes(".m3u8")) window.__capturedRequests.push(s);
                  } catch(e){}
                });
              }
            });
          }
        } catch(e){}
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    } catch(e){}

    // performance resources scan periodically
    try {
      setInterval(() => {
        try {
          const arr = performance.getEntriesByType("resource") || [];
          arr.forEach(en => {
            if (en && en.name && en.name.includes(".m3u8")) window.__capturedRequests.push(en.name);
          });
        } catch(e){}
      }, 3000);
    } catch(e){}
  });

  const page = await context.newPage();

  // CDP session for deeper events
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ev => {
      try {
        const u = ev.request && ev.request.url;
        if (u && (u.includes(".m3u8") || u.includes(".ts") || u.includes("token=") || u.includes("signature="))) {
          console.log(`[CDP REQ] ${u}`);
        }
      } catch(e){}
    });
    cdp.on('Network.webSocketFrameReceived', ev => {
      try {
        const payload = ev.response && ev.response.payloadData;
        if (payload && (payload.includes(".m3u8") || payload.includes("token="))) {
          console.log("[CDP WS FRAME] contains m3u8/token snippet:", payload.slice(0,300));
        }
      } catch(e){}
    });
    cdp.on('Network.responseReceived', async ev => {
      try{
        const url = ev.response && ev.response.url;
        const mime = (ev.response && ev.response.mimeType) || "";
        if (url && (url.includes(".m3u8") || mime.includes("mpegurl"))) {
          console.log(`[CDP RES] ${url} mime:${mime} status:${ev.response.status}`);
        }
        // try getResponseBody for suspicious responses (best-effort)
        if (url && (url.includes(".m3u8") || url.includes("token=") || mime.includes("mpegurl") )) {
          try {
            const body = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
            if (body && body.body && body.body.includes("#EXTM3U")) {
              console.log("[CDP RES BODY] contains #EXTM3U (snippet):", body.body.slice(0,800));
            }
          } catch(e){}
        }
      } catch(e){}
    });
  } catch(e){
    console.log("[warn] CDP not available:", e.message);
  }

  // page listeners
  const capturedSet = new Set();
  page.on('request', req => {
    try {
      const u = req.url();
      if (u && (u.includes(".m3u8") || u.includes(".ts") || u.includes("token=") || u.includes("signature="))) {
        capturedSet.add(u);
        console.log("[REQ] " + u);
      }
    } catch(e){}
  });
  page.on('response', async resp => {
    try {
      const u = resp.url();
      const ct = (resp.headers()['content-type']||"").toLowerCase();
      if (u && (u.includes(".m3u8") || ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl"))) {
        capturedSet.add(u);
        console.log("[RES] " + u + " ct:" + ct + " status:" + resp.status());
        // try opt body read for manifest detection
        if (ct.includes("text") || ct.includes("json") || u.includes(".m3u8")) {
          try {
            const t = await resp.text();
            if (t && t.includes("#EXTM3U")) {
              console.log("[RES BODY] manifest snippet found for", u);
            }
            // if body contains urls, collect them
            const found = t && t.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
            if (found) found.forEach(x=>capturedSet.add(x));
          } catch(e){}
        }
      }
    } catch(e){}
  });

  // attempt loop (MAX_ATTEMPTS ~3, each attempt ~ NAV_TIMEOUT + WAIT_AFTER_LOAD)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n[${now()}] attempt ${attempt}/${MAX_ATTEMPTS} — navigating...`);
    try {
      await page.goto(TARGET, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    } catch(e) {
      console.log("[warn] goto networkidle failed:", e.message);
      try { await page.goto(TARGET, { waitUntil: 'load', timeout: NAV_TIMEOUT }); } catch(_) {}
    }

    console.log(`[${now()}] waiting ${WAIT_AFTER_LOAD}ms for resources...`);
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    // pull window-captured
    try {
      const win = await page.evaluate(() => {
        try { return { reqs: window.__capturedRequests || [], blobs: window.__createdBlobs || [] }; } catch(e) { return { reqs: [], blobs: [] }; }
      });
      (win.reqs || []).forEach(u => capturedSet.add(u));
      if (win.blobs && win.blobs.length) console.log("[win blobs sample]", win.blobs.slice(0,5));
      if (win.reqs && win.reqs.length) console.log("[win capturedRequests sample]", win.reqs.slice(0,6));
    } catch(e){}

    // performance resources check
    try {
      const perf = await page.evaluate(() => (performance.getEntriesByType('resource')||[]).map(e=>e.name).filter(n=>n && n.includes('.m3u8')));
      perf.forEach(u => capturedSet.add(u));
      if (perf.length) console.log("[performance entries]", perf);
    } catch(e){}

    // DOM scan for video/src
    try {
      const dom = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('video,source').forEach(v=>{
          try {
            if (v.currentSrc) out.push(v.currentSrc);
            if (v.src) out.push(v.src);
            const ds = v.getAttribute && (v.getAttribute('data-src')||v.getAttribute('data-href'));
            if (ds) out.push(ds);
          } catch(e){}
        });
        // text nodes quick search
        const txts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        while(walker.nextNode()){
          const s = walker.currentNode.nodeValue;
          if (s && s.includes('.m3u8')) txts.push(s);
        }
        // return both
        return { resources: out, textMatches: txts.slice(0,10) };
      });
      (dom.resources||[]).forEach(u => capturedSet.add(u));
      if (dom.textMatches && dom.textMatches.length) console.log("[dom text matches sample]", dom.textMatches.slice(0,5));
    } catch(e){}

    // gather & pick best candidate
    const all = Array.from(capturedSet).filter(Boolean);
    if (all.length) {
      console.log(`[${now()}] candidates found:`, all.slice(0,12));
      // prefer .m3u8 with token
      const tokened = all.find(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
      const plain = all.find(u => /\.m3u8/i.test(u));
      const tsToken = all.find(u => /\.ts(\?|$)/i.test(u) && /token=|signature=|sig=/.test(u));
      let pick = tokened || plain || (tsToken ? tsToken.replace(/\/[^\/]*\.ts(\?.*)?$/, '/index.m3u8') : null);
      if (pick) {
        console.log("[pick] selected:", pick);
        // validate quickly with HEAD (copy cookies + referer)
        let ok = false;
        try {
          // collect cookies and referer from page
          const cookies = await context.cookies();
          const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const referer = TARGET;
          const head = { 'User-Agent': context._options.userAgent || 'Mozilla/5.0', 'Referer': referer };
          if (cookieHeader) head['Cookie'] = cookieHeader;
          const res = await fetch(pick, { method: 'HEAD', headers: head, timeout: 15000 });
          console.log("[HEAD] status", res.status, "ct:", res.headers && res.headers.get('content-type'));
          if (res.ok || res.status === 200) ok = true;
        } catch(e){
          console.log("[HEAD] validation error:", e.message);
        }
        // if HEAD failed but URL contains .m3u8, accept as fallback
        if (!ok && /\.m3u8/i.test(pick) && !pick.includes("token=")) {
          console.log("[fallback] accepting plain m3u8 candidate despite HEAD failure");
          ok = true;
        }
        if (ok) {
          // send to worker
          try {
            const workerUrl = WORKER_BASE + '/update';
            const wres = await fetch(workerUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + WORKER_SECRET },
              body: JSON.stringify({ playlistUrl: pick })
            });
            console.log("[worker] status", wres.status, "body:", await wres.text().catch(()=>"<no body>"));
            if (wres.ok) { await browser.close(); process.exit(0); }
          } catch(e){ console.log("[worker] send error:", e.message); }
        }
      }
    } else {
      console.log(`[${now()}] no candidates this attempt`);
    }

    // reload + small backoff before next attempt
    try {
      console.log(`[${now()}] reloading page and backoff before next attempt`);
      await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT }).catch(()=>{});
      await page.waitForTimeout(3000 * attempt);
    } catch(e){}
  } // attempts

  console.log(`[${now()}] attempts exhausted — no m3u8 captured`);
  await browser.close();
  process.exit(1);

})();
