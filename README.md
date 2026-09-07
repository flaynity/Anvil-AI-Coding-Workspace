# Anvil Universal CORS/API Proxy

This proxy is designed specifically for the current Anvil frontend's
OpenAI-compatible `/chat/completions` provider flow.

## Structure

- `server.js` — proxy server
- `package.json` — Node dependencies/start script
- `.env.example` — configuration template
- `frontend-provider.js` — the minimal frontend network-layer replacement

## Install

Node.js 18+ is recommended.

```bash
npm install
cp .env.example .env
npm start
```

Health check:

```text
GET http://localhost:8787/api/health
```

## Production

Deploy this Node server on the same domain as Anvil when possible, for example:

```text
https://app.example.com/          -> Anvil frontend
https://app.example.com/api/chat -> proxy
```

If the proxy is on another origin, set `ALLOWED_ORIGINS` to the exact Anvil
origin, e.g.:

```text
ALLOWED_ORIGINS=https://app.example.com
```

Do not use `*` in production if you can avoid it.

## Provider configuration

Keep the existing Anvil Settings UI exactly as it is:

- Provider name
- Base URL
- API key
- Model
- Temperature
- Max tokens
- Reasoning effort

The only functional change is that requests go to `/api/chat` first.
The proxy then calls:

```text
<Base URL>/chat/completions
```

A Base URL accidentally ending in `/chat/completions` is normalized by the proxy.

## Important limitation

A proxy removes the browser-to-provider CORS restriction. It cannot make an
incompatible provider API compatible. The provider still needs to accept the
OpenAI Chat Completions request format and the supplied authentication/model.
