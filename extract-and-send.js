// extract-and-send.js
// Combined aggressive + permissive capture: will capture tokened OR tokenless .m3u8 manifests.
// Usage: env TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
// Recommended: run in environment with playwright installed and browsers present.

const { chromium } = require("playwright");
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const MAX_ATTEMPTS = parseInt(process.env.ATTEMPTS || "4", 10); // 3-4 attempts
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "45000", 10); // 45s navigation timeout
const WAIT_AFTER_LOAD = parseInt(process.env.WAIT_AFTER_LOAD || "15000", 10); // 15s wait after load per attempt
const RESPONSE_WAIT = parseInt(process.env.RESPONSE_WAIT || "20000", 10); // waitForResponse up to 20s per attempt
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

  console.log(`[${now()}] extractor start — target: ${TARGET}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    javaScriptEnabled: true,
    extraHTTPHeaders: { "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8" }
  });

  // stealth-ish small tweaks + in-page patches to catch dynamic creation
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
    try { window.chrome = window.chrome || { runtime: {} }; } catch(e){}
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
        try { if (url) window.__capturedRequests.push(String(url)); } catch(e){}
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
      new MutationObserver(mutations => {
        try {
          for (const m of mutations) {
            (m.addedNodes||[]).forEach(n => {
              try {
                if (n && n.querySelectorAll) {
                  n.querySelectorAll("video,source,script").forEach(el=>{
                    const s = el.src || el.getAttribute('data-src') || el.getAttribute('data-href');
                    if (s) window.__capturedRequests.push(s);
                  });
                }
              } catch(e){}
            });
          }
        } catch(e){}
      }).observe(document.documentElement||document, { childList: true, subtree: true });
    } catch(e){}

    // perf entry scanner
    try {
      setInterval(()=> {
        try {
          const entries = performance.getEntriesByType("resource") || [];
          entries.forEach(e => { if (e && e.name && e.name.includes(".m3u8")) window.__capturedRequests.push(e.name); });
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
    cdp.on('Network.requestWillBeSent', e => {
      try {
        const u = e.request && e.request.url;
        if (!u) return;
        if (u.match(/\.m3u8(\?|$)/i) || u.match(/\.ts(\?|$)/i) || /token=|signature=|sig=/.test(u)) {
          console.log(`[CDP REQ] ${u}`);
        }
      } catch(e){}
    });
    cdp.on('Network.responseReceived', async e => {
      try {
        const url = e.response && e.response.url;
        const mime = (e.response && e.response.mimeType) || "";
        if (!url) return;
        if (url.match(/\.m3u8(\?|$)/i) || mime.includes('mpegurl') || mime.includes('vnd.apple.mpegurl')) {
          console.log(`[CDP RES] ${url} mime:${mime} status:${e.response.status}`);
        }
        // Try to read body for manifest if suspicious
        if (url.match(/\.m3u8(\?|$)/i) || mime.includes('mpegurl') || url.includes('token=')) {
          try {
            const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
            if (body && body.body && body.body.includes('#EXTM3U')) {
              console.log("[CDP RES BODY] contains #EXTM3U for", url);
            }
            // also extract any URLs inside body
            if (body && body.body) {
              const m = body.body.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
              if (m) m.forEach(x => console.log("[CDP RES BODY found m3u8] ", x));
            }
          } catch(err){}
        }
      } catch(e){}
    });
    // capture WS frames if token sent by WS
    try {
      await cdp.send('Network.enable'); // already enabled but safe
      cdp.on('Network.webSocketFrameReceived', ev => {
        try {
          const payload = ev.response && ev.response.payloadData;
          if (payload && (payload.includes('.m3u8') || payload.includes('token='))) {
            console.log("[CDP WS FRAME] snippet:", (payload||"").slice(0,400));
          }
        } catch(e){}
      });
    } catch(e){}
  } catch(e){
    console.log("[warn] CDP session not available:", e.message || e);
  }

  // page listeners: request/response + capture bodies opportunistically
  const candidates = new Set();
  page.on('request', req => {
    try {
      const u = req.url();
      if (!u) return;
      if (u.match(/\.m3u8(\?|$)/i) || u.match(/\.ts(\?|$)/i) || /token=|signature=|sig=/.test(u)) {
        console.log("[REQ] " + u);
        candidates.add(u);
      }
    } catch(e){}
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (!u) return;
      const ct = (resp.headers()['content-type'] || "").toLowerCase();
      if (u.match(/\.m3u8(\?|$)/i) || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')) {
        console.log("[RES] " + u + " ct:" + ct + " status:" + resp.status());
        candidates.add(u);
        // try read text for embedded links or manifest
        try {
          const txt = await resp.text();
          if (txt && txt.includes('#EXTM3U')) {
            console.log("[RES BODY] manifest body detected for", u);
            candidates.add(u);
          }
          const found = txt && txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
          if (found) found.forEach(x => candidates.add(x));
        } catch(e){}
      } else {
        // also scan non-m3u8 text/json responses for embedded m3u8 links
        if (ct.includes('text') || ct.includes('json')) {
          try {
            const txt = await resp.text();
            if (txt) {
              const found = txt.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
              if (found) {
                found.forEach(x => {
                  console.log("[RES BODY found m3u8]", x);
                  candidates.add(x);
                });
              }
            }
          } catch(e){}
        }
      }
    } catch(e){}
  });

  // attempt loop with reloads — but short per attempt
  for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
    console.log(`\n[${now()}] attempt ${attempt}/${MAX_ATTEMPTS} — navigating`);
    try {
      await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch(e){
      console.log("[warn] goto(domcontentloaded) failed:", e.message || e);
      try { await page.goto(TARGET, { waitUntil: 'load', timeout: NAV_TIMEOUT }); } catch(e2){ console.log("[warn] load also failed:", e2.message||e2); }
    }

    // Wait a little and also actively wait for any m3u8 response (no token requirement)
    console.log(`[${now()}] waiting ${WAIT_AFTER_LOAD}ms then up to ${RESPONSE_WAIT}ms for any .m3u8 response`);
    await page.waitForTimeout(WAIT_AFTER_LOAD);

    try {
      const resp = await page.waitForResponse(r => {
        const u = r.url();
        if (!u) return false;
        // accept any .m3u8 or text response that looks like manifest
        if (u.match(/\.m3u8(\?|$)/i)) return true;
        const ct = (r.headers()['content-type'] || "").toLowerCase();
        if (ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')) return true;
        return false;
      }, { timeout: RESPONSE_WAIT });
      if (resp) {
        const foundUrl = resp.url();
        console.log("[waitForResponse] matched .m3u8:", foundUrl);
        candidates.add(foundUrl);
      }
    } catch(e){
      console.log("[waitForResponse] none matched in this attempt");
    }

    // collect any in-page captured arrays (fetch/XHR/perf)
    try {
      const win = await page.evaluate(() => ({ reqs: window.__capturedRequests || [], blobs: window.__createdBlobs || [] }));
      if (Array.isArray(win.reqs) && win.reqs.length) {
        win.reqs.forEach(u => { if(u) candidates.add(u); });
        console.log("[win capturedRequests sample]", win.reqs.slice(0,8));
      }
      if (Array.isArray(win.blobs) && win.blobs.length) {
        console.log("[win blobs sample]", win.blobs.slice(0,6));
      }
    } catch(e){}

    // DOM scan: video/source srcs & text nodes
    try {
      const domCandidates = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('video,source').forEach(v=>{
          try { if (v.currentSrc) out.push(v.currentSrc); if (v.src) out.push(v.src); } catch(e){}
        });
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        while (walker.nextNode()) {
          const s = walker.currentNode.nodeValue;
          if (s && s.includes('.m3u8')) {
            const found = s.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/ig);
            if (found) found.forEach(f => out.push(f));
          }
        }
        return Array.from(new Set(out));
      });
      if (domCandidates && domCandidates.length) {
        domCandidates.forEach(u => candidates.add(u));
        console.log("[dom-scan] found:", domCandidates);
      }
    } catch(e){ console.log("[dom-scan] failed:", e.message || e); }

    // if we have any candidate, pick best
    const all = Array.from(candidates).filter(Boolean);
    if (all.length) {
      console.log(`[${now()}] candidates total: ${all.length}`, all.slice(0,12));
      // prefer tokened .m3u8, else any .m3u8, else fallback conversions
      const tokened = all.find(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
      const plain = all.find(u => /\.m3u8/i.test(u));
      const tsToken = all.find(u => /\.ts(\?|$)/i.test(u) && /token=|signature=|sig=/.test(u));
      let pick = tokened || plain || (tsToken ? tsToken.replace(/\/[^\/]*\.ts(\?.*)?$/, "/index.m3u8") : null);

      if (pick) {
        console.log("[pick] selected:", pick);
        // quick HEAD validation (copy cookies + referer)
        let ok = false;
        try {
          const cookies = await context.cookies();
          const cookieHeader = cookies.map(c=>`${c.name}=${c.value}`).join('; ');
          const headers = { 'User-Agent': context._options.userAgent || 'Mozilla/5.0', 'Referer': TARGET };
          if (cookieHeader) headers['Cookie'] = cookieHeader;
          const hres = await fetch(pick, { method: 'HEAD', headers, timeout: 15000 });
          console.log("[HEAD] status", hres.status, "ct:", hres.headers && hres.headers.get('content-type'));
          if (hres.ok || hres.status === 200) ok = true;
        } catch(e){ console.log("[HEAD] error:", e.message || e); }

        // Accept plain m3u8 as fallback even if HEAD fails
        if (!ok && /\.m3u8/i.test(pick) && !pick.includes("token=")) {
          console.log("[fallback] accepting plain m3u8 despite HEAD failure");
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
            else console.log("[worker] returned not ok, will continue attempts");
          } catch(e){ console.log("[worker] send error:", e.message || e); }
        } // if ok
      } // if pick
    } else {
      console.log(`[${now()}] no candidates this attempt`);
    }

    // reload and small backoff
    try {
      console.log(`[${now()}] reloading & backing off before next attempt`);
      await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT }).catch(()=>{});
      await page.waitForTimeout(3000 * attempt);
    } catch(e){}
  } // attempts

  console.log(`[${now()}] attempts exhausted — no m3u8 captured`);
  await browser.close();
  process.exit(1);

})();
