// /.netlify/functions/run-nano-banana
const DEFAULT_URL = process.env.KIE_RUN_URL || "https://kie.ai/nano-banana?model=google%2Fnano-banana-edit";
const API_KEY = "7714ece17d4416e99ee15eada5f91ac6";

export default async (request, context) => {
  try {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405 });
    }
    const { image_urls, output_format, prompt } = await request.json();
    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return new Response(JSON.stringify({ error: 'image_urls required' }), { status: 400 });
    }

    const payload = { "input.image_urls": image_urls };
    if (output_format) payload["input.output_format"] = output_format;
    if (prompt) payload["prompt"] = prompt;

    const resp = await fetch(DEFAULT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    const contentType = resp.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? JSON.parse(text) : { raw: text };
    return new Response(JSON.stringify(body), { status: resp.status, headers: {'Content-Type':'application/json'} });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
