# Anvil AI Universal Provider Proxy

Browser requests now use:

Browser → Cloudflare Worker /api/proxy → Provider API

This solves browser CORS restrictions for compatible providers. It does not bypass provider authentication, rate limits, billing, model availability, or API-format requirements.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

The Worker uses `workers_dev = true`, so Cloudflare provides a workers.dev URL.

If the Worker is on another origin, define this before the main application script:

```html
<script>
window.ANVIL_PROXY_URL = "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/proxy";
</script>
```

If the Worker is served at the same origin as the app under `/api/proxy`, the app automatically uses that path.

## Production CORS

Development is configured with `ALLOWED_ORIGINS = "*"`.

For production, set it to the exact website origin, for example:

```toml
[vars]
ALLOWED_ORIGINS = "https://your-app.example"
```

## Provider compatibility

The existing app sends OpenAI-compatible Chat Completions requests. The proxy forwards them unchanged to the provider. A provider must support that API format.

## Security

The Worker does not store API keys. It forwards the browser's Authorization header to the selected provider. It rejects non-HTTPS, localhost, private-host, and private-IP targets.

## Provider errors

401/403 = authentication; 404 = endpoint/model; 422 = request format; 429 = rate limit; 5xx = provider/server/network issue.
