// extract-and-send.js
// Debug-heavy extractor: logs request initiators & response bodies for suspicious requests
// Usage (env): TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET
// Run in GitHub Actions / VPS. Paste logs here if it doesn't auto-find token.

const { chromium } = require("playwright");
const fetchImport = (...args) => import('node-fetch').then(m => m.default(...args));

const TARGET = process.env.TARGET_URL;
const WORKER_BASE = process.env.WORKER_UPDATE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!TARGET || !WORKER_BASE || !WORKER_SECRET) {
  console.error("Missing envs: TARGET_URL, WORKER_UPDATE_URL, WORKER_SECRET");
  process.exit(1);
}

(async () => {
  console.log("=== extractor: eval + CDP deep capture ===");
  console.log("TARGET:", TARGET);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "referer": TARGET
    }
  });

  const page = await context.newPage();

  // prepare CDP
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  const requests = new Map(); // requestId -> {url, method, initiator, timestamp}
  const responses = new Map(); // requestId -> {status, headers}
  const captured = [];

  cdp.on('Network.requestWillBeSent', (params) => {
    try {
      const r = params.request;
      const id = params.requestId;
      requests.set(id, {
        url: r.url,
        method: r.method,
        headers: r.headers,
        initiator: params.initiator || params.initiatorStack || null,
        timestamp: params.timestamp
      });
      // quick log for suspicious urls
      if (/\.m3u8/i.test(r.url) || /\.ts(\?|$)/i.test(r.url) || /token=|signature=|sig=|expires=|exp=/.test(r.url)) {
        console.log("CAPTURED REQUEST (willBeSent):", r.url);
      }
    } catch (e) {}
  });

  cdp.on('Network.responseReceived', async (params) => {
    try {
      const id = params.requestId;
      const r = params.response;
      responses.set(id, { status: r.status, headers: r.headers, mimeType: r.mimeType, url: r.url });
      // if suspicious url, fetch body
      const suspicious = /\.m3u8/i.test(r.url) || /\.ts(\?|$)/i.test(r.url) || /token=|signature=|sig=|expires=|exp=/.test(r.url) || /mpegurl|application\/vnd\.apple\.mpegurl/i.test(r.mimeType || "");
      if (suspicious) {
        let body = null;
        try {
          const respBody = await cdp.send('Network.getResponseBody', { requestId: id });
          body = respBody && respBody.body ? respBody.body : null;
        } catch (e) {
          // getResponseBody may fail for some cross-origin / security reasons
          body = null;
        }
        const info = {
          requestId: id,
          url: r.url,
          status: r.status,
          headers: r.headers,
          mimeType: r.mimeType,
          initiator: requests.get(id) && requests.get(id).initiator,
          snippet: body ? (body.length>2000 ? body.slice(0,2000) : body) : null
        };
        captured.push(info);
        console.log("CAPTURED RESPONSE:", JSON.stringify({
          url: info.url,
          status: info.status,
          mimeType: info.mimeType,
          hasSnippet: !!info.snippet
        }));
        if (info.snippet) {
          console.log("RESPONSE_BODY_SNIPPET (first 2000 chars):");
          console.log(info.snippet.slice(0,2000));
        }
      }
    } catch (e) {
      // ignore
    }
  });

  // Also add page-level listeners as fallback
  page.on('request', req => {
    try {
      const u = req.url();
      if (/\.m3u8/i.test(u) || /\.ts(\?|$)/i.test(u) || /token=/.test(u)) {
        console.log("PAGE.REQUEST:", u);
      }
    } catch (e) {}
  });

  page.on('response', async resp => {
    try {
      const u = resp.url();
      if (/\.m3u8/i.test(u) || /\.ts(\?|$)/i.test(u) || /token=/.test(u)) {
        console.log("PAGE.RESPONSE:", u, "status", resp.status());
        // try minimal body read for debugging
        try {
          const txt = await resp.text().catch(()=>null);
          if (txt && txt.includes('#EXTM3U')) {
            console.log("PAGE.RESPONSE BODY contains #EXTM3U for", u);
            console.log(txt.split('\n').slice(0,10).join('\n'));
          }
        } catch(e){}
      }
    } catch(e){}
  });

  // inject fetch/XHR monkeypatch to capture dynamic fetches
  await context.addInitScript(() => {
    window.__capturedRequests = window.__capturedRequests || [];
    (function(){
      const origFetch = window.fetch;
      window.fetch = function(...args){
        try{
          const u = args[0];
          if(typeof u === 'string') window.__capturedRequests.push(u);
          else if (u && u.url) window.__capturedRequests.push(String(u.url));
        }catch(e){}
        return origFetch.apply(this, args);
      };
      const X = window.XMLHttpRequest;
      const open = X.prototype.open;
      X.prototype.open = function(method, url) {
        try { window.__capturedRequests.push(String(url)); } catch(e){}
        return open.apply(this, arguments);
      };
    })();
  });

  // navigate and interact
  try {
    console.log("Navigating to target...");
    await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90000 }).catch(e => { console.log("goto error:", e.message); });
    // give extra time
    await page.waitForTimeout(6000);
    // attempt to click play-like elements
    const clickSelectors = ['button.play','.play-button','#play','[data-play]','.vjs-play-control','.jw-icon-play','button[title="Play"]'];
    for (const s of clickSelectors) {
      try {
        const el = await page.$(s);
        if (el) {
          console.log("Clicking", s);
          await el.click({ force: true }).catch(()=>{});
          await page.waitForTimeout(2000);
        }
      } catch(e){}
    }
    // wait for background requests
    await page.waitForTimeout(8000);
    // also grab window.__capturedRequests
    const winreqs = await page.evaluate(() => window.__capturedRequests || []);
    if (Array.isArray(winreqs) && winreqs.length) {
      console.log("window.__capturedRequests (sample):", winreqs.slice(0,10));
      winreqs.forEach(u => {
        if (u && (u.includes('.m3u8') || u.includes('token=') || u.match(/\.ts(\?|$)/i))) {
          console.log("CAPTURED from page context:", u);
        }
      });
    } else {
      console.log("No window.__capturedRequests captured.");
    }
  } catch (e) {
    console.log("navigation/interact error:", e && e.message);
  }

  // Summary of captured items
  console.log("=== CAPTURE SUMMARY ===");
  if (captured.length === 0) {
    console.log("No suspicious responses captured by CDP. This means the token might be generated client-side in a way we did not intercept (e.g. encrypted in-memory, WebSocket, or server verifies origin).");
  } else {
    console.log("Number of captured suspicious responses:", captured.length);
    captured.forEach((c, idx) => {
      console.log(`--- #${idx+1} ---`);
      console.log("URL:", c.url);
      console.log("Status:", c.status, "MIME:", c.mimeType);
      if (c.initiator) {
        console.log("Initiator (snippet):", JSON.stringify(c.initiator).slice(0,1000));
      }
      if (c.snippet) {
        console.log("RESPONSE_BODY first 1000 chars:\n", c.snippet.slice(0,1000));
      }
    });
  }

  // Also try to directly test candidate urls (requests map)
  // Check all seen requests in requests map for token=
  const directCandidates = [];
  for (const [id, info] of requests.entries()) {
    if (info.url && (info.url.includes('token=') || info.url.match(/\.m3u8/i) || info.url.match(/\.ts(\?|$)/i))) {
      directCandidates.push(info.url);
    }
  }
  if (directCandidates.length) {
    console.log("Direct candidate sample (first 20):", directCandidates.slice(0,20));
  }

  // If we have any m3u8-like candidate, attempt to validate and send first valid one
  // prefer ones with token param
  const allCandidates = [...new Set([...directCandidates, ...captured.map(c=>c.url)])].filter(Boolean);
  const prefer = allCandidates.find(u => /\.m3u8/i.test(u) && /token=|signature=|sig=|expires=|exp=/.test(u));
  const fallback = allCandidates.find(u => /\.m3u8/i.test(u));
  const pick = prefer || fallback || allCandidates[0];

  if (pick) {
    console.log("Validating candidate:", pick);
    try {
      const res = await fetchImport(pick, { method: 'HEAD', headers: { 'User-Agent': context._options.userAgent || 'Mozilla/5.0' }, timeout: 15000 });
      console.log("HEAD response status:", res.status, "content-type:", res.headers && res.headers.get('content-type'));
      // if HEAD okay or 200 GET
      if (res.ok || res.status===200) {
        // send to worker
        const workerUrl = WORKER_BASE.replace(/\/+$/, "") + "/update";
        const post = await fetchImport(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
          body: JSON.stringify({ playlistUrl: pick })
        });
        console.log("Worker POST status:", post.status, "body:", await post.text().catch(()=>"<no body>"));
        await browser.close();
        process.exit(post.ok ? 0 : 1);
      } else {
        console.log("HEAD check failed or not 200/ok; may require different headers/referrer; see captured items above.");
      }
    } catch (e) {
      console.log("Candidate validation error:", e && e.message);
    }
  } else {
    console.log("No candidates to validate.");
  }

  await browser.close();
  process.exit(1);
})();
