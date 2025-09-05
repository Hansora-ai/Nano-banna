// netlify/functions/run-nano-banana.js
const API_URL = "https://kie.ai/nano-banana?model=google%2Fnano-banana-edit";
const API_KEY = "7714ece17d4416e99ee15eada5f91ac6";

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const { image_urls, output_format = "png", prompt = "" } = await request.json();
    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return new Response(JSON.stringify({ error: "No image_urls" }), { status: 400 });
    }

    const payload = {
      "input.image_urls": image_urls,
      "input.output_format": output_format,
      prompt
    };

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let api = null;
    try { api = JSON.parse(text); } catch {}

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: "KIE error", status: resp.status, body: text }), {
        status: resp.status, headers: { "Content-Type": "application/json" }
      });
    }

    // Only return real output image URLs (no regex over the whole JSON)
    const urls = collectOutputUrls(api);
    return new Response(JSON.stringify({ urls, api }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};

function collectOutputUrls(api) {
  const out = new Set();
  const push = v => { if (typeof v === "string" && /\.(png|jpe?g|webp)(\?|$)/i.test(v)) out.add(v); };

  // Common shapes returned by KIE
  if (api?.output?.image_urls) (Array.isArray(api.output.image_urls) ? api.output.image_urls : [api.output.image_urls]).forEach(push);
  if (api?.output?.images)     (Array.isArray(api.output.images)     ? api.output.images     : [api.output.images]).forEach(push);
  if (!out.size && api?.image_urls) (Array.isArray(api.image_urls) ? api.image_urls : [api.image_urls]).forEach(push);
  if (!out.size && api?.images)     (Array.isArray(api.images)     ? api.images     : [api.images]).forEach(push);
  if (!out.size && api?.data?.image_urls) (Array.isArray(api.data.image_urls) ? api.data.image_urls : [api.data.image_urls]).forEach(push);
  if (!out.size && api?.data?.images)     (Array.isArray(api.data.images)     ? api.data.images     : [api.data.images]).forEach(push);

  return [...out];
}
