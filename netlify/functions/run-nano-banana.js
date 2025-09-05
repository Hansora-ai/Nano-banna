// netlify/functions/run-nano-banana.js
const API_KEY = "7714ece17d4416e99ee15eada5f91ac6";
// Use the product endpoint, not the website:
const API_URL = "https://api.kie.ai/api/v1/nano-banana-edit/generate";

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const { image_urls = [], output_format = "png", image_size = "auto", prompt = "" } =
      await request.json();

    if (!Array.isArray(image_urls) || !image_urls.length) {
      return new Response(JSON.stringify({ error: "No image_urls" }), { status: 400 });
    }

    // Payload per KIE docs (model is implied by the endpoint path)
    const payload = {
      prompt,
      image_urls,
      output_format,   // "png" | "jpeg"
      image_size       // "auto" | "1:1" | "3:4" | "9:16" | "4:3" | "16:9"
    };

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: "KIE error", status: resp.status, raw: text }), {
        status: resp.status,
        headers: { "Content-Type": "application/json" }
      });
    }

    // KIE usually returns direct links (sometimes without .png extension).
    // Collect any plausible output URLs from common fields or raw text.
    const urls = collectUrls(data) || collectUrls(text) || [];
    return new Response(JSON.stringify({ urls, api: data ?? text }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

function collectUrls(x) {
  // JSON shapes
  const push = (arr, v) => { if (typeof v === "string") arr.push(v); };
  if (x && typeof x === "object") {
    const out = [];
    const paths = [
      ["output", "image_urls"],
      ["output", "images"],
      ["results"],
      ["result"],
      ["images"],
      ["image_urls"],
      ["data", "results"],
      ["data", "image_urls"]
    ];
    for (const p of paths) {
      let v = x;
      for (const k of p) v = v?.[k];
      if (Array.isArray(v)) v.forEach((u) => push(out, u));
      else if (typeof v === "string") push(out, v);
    }
    if (out.length) return dedupe(out);
  }
  // Raw text fallback (handles extension-less links like tempfile.aiquickdraw.com/…)
  if (typeof x === "string") {
    const out = [];
    const re = /(https?:\/\/[^\s"'<>)\]}]+)/g;
    let m;
    while ((m = re.exec(x))) out.push(m[1]);
    if (out.length) return dedupe(out);
  }
  return null;
}

function dedupe(a) {
  // drop obvious input hosts so outputs are prioritised
  const blacklist = ["catbox.moe", "transfer.sh"];
  return Array.from(new Set(a)).filter((u) => !blacklist.some((b) => u.includes(b)));
}
