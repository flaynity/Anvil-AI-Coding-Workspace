export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/search") {
      return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      return new Response(JSON.stringify({ ok: false, error: "Missing q" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    if (!env.JINA_API_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "JINA_API_KEY is not configured" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    const searchUrl = "https://s.jina.ai/?q=" + encodeURIComponent(q);
    const upstream = await fetch(searchUrl, {
      headers: {
        "Accept": "text/plain",
        "Authorization": "Bearer " + env.JINA_API_KEY
      }
    });

    const body = await upstream.text();
    return new Response(JSON.stringify({
      ok: upstream.ok,
      status: upstream.status,
      content: body
    }), {
      status: upstream.ok ? 200 : upstream.status,
      headers: { ...cors, "Content-Type": "application/json" }
    });
  }
};
