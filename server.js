import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.disable('x-powered-by');
app.use(express.json({ limit: process.env.JSON_LIMIT || '8mb' }));

/*
  Universal browser -> server -> OpenAI-compatible provider proxy.

  Frontend calls:
    POST /api/chat

  Body:
    {
      "baseURL": "https://provider.example/v1",
      "apiKey": "optional-user-provider-key",
      "model": "model-name",
      "messages": [...],
      "stream": true,
      "temperature": 0.7,
      "max_tokens": 123,
      "reasoning_effort": "low"
    }

  The server calls:
    <baseURL>/chat/completions

  Security:
  - Provider URL is validated as http/https.
  - localhost/private IP targets are blocked by default to reduce SSRF risk.
  - Only the provider API key supplied for the current request is forwarded.
  - No provider key is logged.
*/

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS origin not allowed.'));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));


app.use(express.static(process.cwd(), { index: 'index.html' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'anvil-universal-proxy' });
});

function isPrivateIPv4(hostname) {
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a,b,c,d] = m.slice(1).map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function validateBaseURL(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Base URL is required.');
  }

  const u = new URL(raw.trim());
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Base URL must use http or https.');
  }

  if (u.username || u.password) {
    throw new Error('Base URL must not contain embedded credentials.');
  }

  if (process.env.ALLOW_PRIVATE_TARGETS !== 'true' &&
      (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') ||
       u.hostname === '::1' || isPrivateIPv4(u.hostname))) {
    throw new Error('Private/local provider targets are blocked by the proxy.');
  }

  // The Anvil frontend already treats Base URL as the directory before
  // /chat/completions. Remove a mistakenly supplied endpoint suffix too.
  u.pathname = u.pathname.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
  return u.toString().replace(/\/+$/, '');
}

function providerURL(baseURL) {
  return validateBaseURL(baseURL) + '/chat/completions';
}

function cleanHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function providerError(status, detail) {
  const map = {
    400: 'Bad request — the provider rejected the payload.',
    401: 'Invalid or missing API key.',
    403: 'Access denied — the key has no permission for this model.',
    404: 'Endpoint or model not found — check the Base URL and model name.',
    408: 'Request timeout — the provider took too long.',
    409: 'Provider conflict.',
    422: 'The provider rejected the request parameters.',
    429: 'Rate limit reached — slow down or check your plan.',
    500: 'Provider server error.',
    502: 'Provider server error.',
    503: 'Provider temporarily unavailable.',
    504: 'Provider timeout.'
  };
  return `${map[status] || `Provider error (${status}).`}${detail ? ` — ${detail}` : ''}`;
}

async function readErrorText(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const j = JSON.parse(text);
      return j?.error?.message || j?.message || text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return '';
  }
}

app.post('/api/chat', async (req, res) => {
  const {
    baseURL,
    apiKey,
    model,
    messages,
    stream = true,
    temperature,
    max_tokens,
    reasoning_effort
  } = req.body || {};

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'messages must be an array.' } });
  }

  let target;
  try {
    target = providerURL(baseURL);
  } catch (err) {
    return res.status(400).json({ error: { message: err.message } });
  }

  const body = {
    model: model || 'default',
    messages,
    stream: Boolean(stream)
  };

  if (Number.isFinite(Number(temperature))) {
    body.temperature = Math.max(0, Math.min(2, Number(temperature)));
  }
  if (Number.isFinite(Number(max_tokens)) && Number(max_tokens) > 0) {
    body.max_tokens = Math.floor(Number(max_tokens));
  }
  if (reasoning_effort && reasoning_effort !== 'default') {
    body.reasoning_effort = reasoning_effort;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.PROVIDER_TIMEOUT_MS || 120000)
  );

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: cleanHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const detail = await readErrorText(upstream);
      return res.status(upstream.status).json({
        error: { message: providerError(upstream.status, detail) }
      });
    }

    res.status(upstream.status);

    // Stream SSE transparently so Anvil's existing stream parser continues
    // to work without any UI/protocol changes.
    if (body.stream && upstream.body) {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
      return;
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    const data = await upstream.arrayBuffer();
    res.end(Buffer.from(data));
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: { message: 'Provider request timed out.' } });
    }
    return res.status(502).json({
      error: { message: `Unable to reach provider: ${err?.message || 'network error'}` }
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: { message: err.message || 'Request failed.' } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Anvil Universal Proxy listening on http://localhost:${PORT}`);
});
