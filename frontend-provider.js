/*
 * Minimal Anvil frontend network-layer replacement.
 *
 * IMPORTANT:
 * Keep the existing Anvil UI, state, provider form, provider storage,
 * streaming renderer, error cards and all other functionality unchanged.
 *
 * Only replace the direct provider fetches inside:
 *   requestCompletion(...)
 *   testProvider(...)
 *
 * The rest of index.html should remain unchanged.
 */

const ANVIL_PROXY_URL =
  window.ANVIL_PROXY_URL ||
  (window.location.origin + '/api/chat');

function proxyBodyFromProvider(p, messages, stream) {
  const b = {
    baseURL: p.baseURL,
    apiKey: p.apiKey || '',
    model: p.model || 'default',
    messages,
    stream
  };
  const t = parseFloat(p.temperature);
  if (!isNaN(t)) b.temperature = Math.max(0, Math.min(2, t));
  if (p.maxTokens && parseInt(p.maxTokens) > 0) {
    b.max_tokens = parseInt(p.maxTokens);
  }
  if (p.reasoningEffort && p.reasoningEffort !== 'default') {
    b.reasoning_effort = p.reasoningEffort;
  }
  return b;
}

/*
 * In requestCompletion(), replace ONLY the direct provider URL/fetch block
 * with this request target:
 *
 *   const url = ANVIL_PROXY_URL;
 *   const headers = {'Content-Type':'application/json'};
 *   const res = await fetch(url,{
 *     method:'POST',
 *     signal:ctl.signal,
 *     headers,
 *     body:JSON.stringify(proxyBodyFromProvider(p,messages,true))
 *   });
 *
 * The existing consumeStream()/consumeJson() logic remains unchanged.
 *
 * For the existing non-stream fallback, use:
 *
 *   res = await fetch(ANVIL_PROXY_URL,{
 *     method:'POST',
 *     signal:ctl.signal,
 *     headers:{'Content-Type':'application/json'},
 *     body:JSON.stringify(proxyBodyFromProvider(p,messages,false))
 *   });
 *
 * For testProvider(), replace its direct provider URL/fetch with:
 *
 *   const res = await fetch(ANVIL_PROXY_URL,{
 *     method:'POST',
 *     signal:ctl.signal,
 *     headers:{'Content-Type':'application/json'},
 *     body:JSON.stringify(proxyBodyFromProvider(
 *       p,
 *       [{role:'user',content:'ping'}],
 *       false
 *     ))
 *   });
 *
 * The existing response/error validation can remain unchanged.
 */
