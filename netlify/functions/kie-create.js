const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload'; // official
const JOBS_CREATE_URL_ENV = 'KIE_API_URL'; // should be https://api.kie.ai/api/v1/jobs/createTask

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_URL = process.env[JOBS_CREATE_URL_ENV];
    const KIE_API_KEY = process.env.KIE_API_KEY;
    const miss = [];
    if (!KIE_API_URL) miss.push('KIE_API_URL');
    if (!KIE_API_KEY) miss.push('KIE_API_KEY');
    if (miss.length) return { statusCode: 500, headers: cors(), body: `Missing: ${miss.join(', ')}` };

    const { prompt, format = 'png', files = [] } = JSON.parse(event.body || '{}');
    if (!prompt) return { statusCode: 400, headers: cors(), body: 'Missing "prompt"' };
    if (!files.length) return { statusCode: 400, headers: cors(), body: 'Provide at least one file' };
    if (files.length > 4) return { statusCode: 400, headers: cors(), body: 'Up to 4 files allowed' };

    // 1) Upload each file to KIE's temp storage and get downloadUrl
    const imageUrls = [];
    for (const f of files) {
      const dataUrl = `data:${f.contentType || 'application/octet-stream'};base64,${f.data}`;
      const r = await fetch(UPLOAD_BASE64_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data: dataUrl, uploadPath: 'images/user-uploads', fileName: f.name || 'image.png' })
      });
      const j = await r.json();
      if (!r.ok || !j?.data?.downloadUrl) {
        return { statusCode: 502, headers: cors(), body: `Upload failed: ${r.status} ${JSON.stringify(j)}` };
      }
      imageUrls.push(j.data.downloadUrl);
    }

    // 2) Create task (exactly like the Nano Banana docs)
    const payload = {
      model: "google/nano-banana-edit",
      input: {
        prompt,
        image_urls: imageUrls,
        output_format: String(format).toLowerCase(),   // png|jpeg
        image_size: "auto"                              // per docs
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

function cors(){ return {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};}
