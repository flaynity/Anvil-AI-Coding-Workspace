'use strict';

/* ============================================================
   Kodo Universal AI Proxy — v2
   Zero-dependency, zero-config CORS proxy for OpenAI-compatible APIs.
   NO API keys are stored here. Keys pass through per request.
   ============================================================ */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '300000', 10);   // idle timeout
const RATE_PER_MIN = parseInt(process.env.RATE_LIMIT || '60', 10);     // per-IP limit

/* ---- Provider directory: /<slug>/... -> upstream base ---- */
const PROVIDERS = {
  openai:     'https://api.openai.com/v1',
  groq:       'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek:   'https://api.deepseek.com/v1',
  together:   'https://api.together.xyz/v1',
  mistral:    'https://api.mistral.ai/v1',
  fireworks:  'https://api.fireworks.ai/inference/v1',
  cerebras:   'https://api.cerebras.ai/v1',
  xai:        'https://api.x.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  gemini:     'https://generativelanguage.googleapis.com/v1beta/openai',
  hf:         'https://router.huggingface.co/v1'
};

/* Only AI endpoint suffixes are relayed (prevents open-relay abuse) */
const ALLOWED = /\/(chat\/completions|completions|models|embeddings|responses)\/?$/;

const escHTML = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const STRIP_REQ = new Set(['host','connection','keep-alive','transfer-encoding','upgrade','te','trailer',
  'proxy-authorization','accept-encoding','content-length','origin','referer','cookie']);
const STRIP_RES = new Set(['connection','keep-alive','transfer-encoding','content-encoding','set-cookie']);
const AGENTS = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
                 'http:' : new http.Agent({ keepAlive: true, maxSockets: 64 }) };

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-Request-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function sendErr(res, status, message) {
  if (res.headersSent) { try { res.destroy(); } catch (_) {} return; }
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'proxy_error', code: status } }));
}

/* /groq/v1/chat/completions        -> https://api.groq.com/openai/v1/chat/completions
   /host/api.anyhost.com/v1/...     -> https://api.anyhost.com/v1/...          */
function resolveTarget(pathname) {
  let p = pathname.replace(/\/+$/, '');
  if (p.startsWith('/host/')) {
    const rest = p.slice(6);                      // api.x.ai/v1/chat/completions
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const host = rest.slice(0, slash).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
    if (/^(localhost|.*\.local|.*\.internal|10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    return 'https://' + host + '/' + rest.slice(slash + 1);
  }
  const seg = p.slice(1).split('/');
  const base = PROVIDERS[seg[0].toLowerCase()];
  if (!base) return null;
  let rest = seg.slice(1).join('/');              // e.g. v1/chat/completions
  if (rest.startsWith('v1/')) rest = rest.slice(3);
  else if (rest === 'v1') rest = '';
  return base.replace(/\/+$/, '') + '/' + rest;
}
/* collapse duplicated version segments: /v1beta/openai/v1/chat/completions -> /v1beta/openai/chat/completions */
function dedupeVersion(u) {
  return u.replace(/^(https:\/\/[^/]+\/.*\/v\d+\w*)\/v\d+\w*(\/(?:chat\/completions|completions|models|embeddings|responses)\/?)$/, '$1$2');
}

/* simple per-IP rate limiter */
const hits = new Map();
function limited(ip) {
  const now = Date.now(); let a = hits.get(ip);
  if (!a) { a = []; hits.set(ip, a); }
  while (a.length && now - a[0] > 60000) a.shift();
  if (a.length >= RATE_PER_MIN) return true;
  a.push(now); return false;
}
setInterval(() => { const t = Date.now() - 120000;
  for (const [k, v] of hits) if (!v.length || v[v.length - 1] < t) hits.delete(k); }, 300000).unref();

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kodo AI Proxy</title><style>
body{font-family:system-ui,sans-serif;background:#fff;color:#0a0a0a;margin:0;padding:40px 18px}
main{max-width:640px;margin:0 auto}
h1{font-size:20px;letter-spacing:-.02em}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#16a34a;margin-right:8px}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:13px}
td{padding:7px 0;border-top:1px solid #eee}code{font-family:ui-monospace,monospace;background:#f4f4f5;padding:2px 7px;border-radius:6px;font-size:12px;word-break:break-all}
p{font-size:13.5px;color:#52525b;line-height:1.6}</style></head><body><main>
<h1><span class="dot"></span>Kodo Universal AI Proxy</h1>
<p>No keys stored here — API keys pass through per request. Usage:</p>
<table>
 ${Object.entries(PROVIDERS).map(([s, b]) => `<tr><td><code>/${s}</code></td><td><code>${escHTML(b)}</code></td></tr>`).join('')}
<tr><td><code>/host/…</code></td><td>any provider: <code>/host/api.example.com/v1/chat/completions</code></td></tr>
</table>
<p>Example Base URL for the app: <code>https://THIS-HOST/groq</code> · Health: <code>/healthz</code></p>
</main></body></html>`;

http.createServer((req, res) => {
  try {
    setCORS(res);
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const u = new URL(req.url || '/', 'http://internal');
    const path = u.pathname;

    if (method === 'GET' && (path === '/' || path === '/healthz')) {
      res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
      res.end(path === '/' ? PAGE : JSON.stringify({ status: 'ok', providers: Object.keys(PROVIDERS).length }));
      return;
    }
    if (method === 'GET' && path === '/providers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers: PROVIDERS, custom: '/host/<host>/<path>' }));
      return;
    }
    if (method !== 'GET' && method !== 'POST') return sendErr(res, 405, 'Method not allowed.');
    if (limited(req.socket.remoteAddress || '?')) return sendErr(res, 429, 'Too many requests. Try again in a minute.');

    const target = dedupeVersion(resolveTarget(path) || '');
    if (!target) return sendErr(res, 404,
      'Unknown route. Use /<provider>/... (' + Object.keys(PROVIDERS).join(', ') + ') or /host/<host>/...');
    if (!ALLOWED.test(new URL(target).pathname)) return sendErr(res, 403, 'Only AI endpoints (chat/completions, models, etc.) are relayed.');

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP_REQ.has(k.toLowerCase())) headers[k] = v;
    headers['accept-encoding'] = 'identity';
    if (!headers['authorization']) return sendErr(res, 401, 'Missing API key: send an Authorization header (set in Set Up AI).');

    const tu = new URL(target);
    const upreq = (/^https:/.test(tu.protocol) ? https : http).request(tu, {
      method, headers: { ...headers, host: tu.host, 'accept-encoding': 'identity' }, agent: AGENTS[tu.protocol]
    }, upres => {
      const out = {};
      for (const [k, v] of Object.entries(upres.headers)) if (!STRIP_RES.has(k.toLowerCase())) out[k] = v;
      out['cache-control'] = out['cache-control'] || 'no-cache, no-transform';
      out['x-accel-buffering'] = 'no';
      out['x-proxy-stream'] = 'true';
      out['x-request-id'] = req.headers['x-request-id'] || '';
      res.writeHead(upres.statusCode || 502, out);
      if (res.flushHeaders) res.flushHeaders();          // keep SSE flowing immediately
      upres.pipe(res);
      upres.on('error', () => { try { res.destroy(); } catch (_) {} });
    });
    upreq.on('socket', s => { s.setNoDelay(true); });
    upreq.setTimeout(TIMEOUT_MS, () => upreq.destroy(new Error('Upstream idle timeout after ' + Math.round(TIMEOUT_MS / 1000) + 's.')));
    upreq.on('error', err => {
      const c = err.code || '';
      const msg = c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? 'Cannot resolve upstream host.'
        : c === 'ECONNREFUSED' ? 'Upstream refused the connection.'
        : c === 'ETIMEDOUT' || /timeout/i.test(err.message) ? 'Upstream timed out (long idle). Press Continue/Retry.'
        : 'Upstream request failed: ' + (err.message || 'unknown');
      sendErr(res, /timeout/i.test(msg) ? 504 : 502, msg);
    });
    res.on('close', () => {
      if (!res.writableFinished) { try { upreq.destroy(); } catch (_) {} }
    });   // Stop button / client disconnect passthrough
    req.pipe(upreq);                                                    // zero buffering = fast
  } catch (err) { sendErr(res, 500, 'Proxy error: ' + ((err && err.message) || 'unknown')); }
}).listen(PORT, () => console.log('Kodo Universal AI Proxy on :' + PORT));

process.on('uncaughtException', e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e));
