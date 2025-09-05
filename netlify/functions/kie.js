// Creates a KIE task for google/nano-banana-edit using the official createTask route.
// Expects JSON from the browser: { prompt, format, files:[{name, contentType, data(base64)}] }
// We upload files to transfer.sh to obtain public URLs, then pass them to KIE.

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: cors(), body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
    }

    const KIE_API_URL = process.env.KIE_API_URL; // MUST be https://api.kie.ai/api/v1/jobs/createTask
    const KIE_API_KEY = process.env.KIE_API_KEY; // raw key, no "Bearer "
    const miss = [];
    if (!KIE_API_URL) miss.push('KIE_API_URL');
    if (!KIE_API_KEY) miss.push('KIE_API_KEY');
    if (miss.length) {
      return { statusCode: 500, headers: cors(), body: `Missing: ${miss.join(', ')}` };
    }

    const { prompt, format = 'png', files = [] } = JSON.parse(event.body || '{}');
    if (!prompt) {
      return { statusCode: 400, headers: cors(), body: 'Missing "prompt"' };
    }
    if (!Array.isArray(files) || files.length < 1) {
      return { statusCode: 400, headers: cors(), body: 'Provide at least one file' };
    }
    if (files.length > 4) {
      return { statusCode: 400, headers: cors(), body: 'Up to 4 files allowed' };
    }

    // 1) Upload each file to get a public URL (using transfer.sh for simplicity)
    const urls = [];
    for (const f of files) {
      const url = await uploadToTransferSh(f.name || 'image.png', f.contentType || 'application/octet-stream', f.data);
      urls.push(url);
    }

    // 2) Call KIE createTask exactly like their example
    const payload = {
      model: "google/nano-banana-edit",
      // callBackUrl: "https://your-domain.com/api/callback", // optional
      input: {
        prompt,
        image_urls: urls,
        output_format: String(format || 'png').toLowerCase(),
        image_size: "auto"
      }
    };

    const resp = await fetch(KIE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const ct = resp.headers.get('content-type') || 'application/json';
    const body = await resp.text();
    return { statusCode: resp.status, headers: { ...cors(), 'Content-Type': ct }, body };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: `Server error: ${e.message || e}` };
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

async function uploadToTransferSh(name, contentType, base64Data) {
  if (!base64Data) throw new Error('Missing base64 data for upload');
  const buf = Buffer.from(base64Data, 'base64');
  const res = await fetch(`https://transfer.sh/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buf
  });
  if (!res.ok) throw new Error(`transfer.sh upload failed (${res.status})`);
  // Response is a plain-text URL
  return (await res.text()).trim();
}
