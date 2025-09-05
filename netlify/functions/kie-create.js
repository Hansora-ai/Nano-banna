// Uploads files to KIE's uploader, then creates a Nano Banana task
// and tells KIE to POST the final result to your Make.com webhook.
// Env vars required:
//   KIE_API_KEY        = <raw key>          (no "Bearer")
//   KIE_API_URL        = https://api.kie.ai/api/v1/jobs/createTask
//   MAKE_WEBHOOK_URL   = https://hook.make.com/xxxxxxxxxxxxxxxx (your Make custom webhook)

const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_URL = process.env.KIE_API_URL;
    const KIE_API_KEY = process.env.KIE_API_KEY;
    const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
    const miss = [];
    if (!KIE_API_URL) miss.push('KIE_API_URL');
    if (!KIE_API_KEY) miss.push('KIE_API_KEY');
    if (!MAKE_WEBHOOK_URL) miss.push('MAKE_WEBHOOK_URL');
    if (miss.length)
      return { statusCode: 500, headers: cors(), body: `Missing: ${miss.join(', ')}` };

    let bodyIn = {};
    try { bodyIn = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: cors(), body: 'Bad JSON' }; }

    const { prompt, format = 'png', files = [], imageUrls = [] } = bodyIn;
    if (!prompt)        return { statusCode: 400, headers: cors(), body: 'Missing "prompt"' };

    // Optional: add context for Make (so you can trace which request this was)
    const clientContext = { prompt, format, submittedAt: new Date().toISOString() };
    const callbackUrl = `${MAKE_WEBHOOK_URL}?ctx=${encodeURIComponent(JSON.stringify(clientContext))}`;

    // Build image_urls either from URLs (preferred) or by uploading base64 (your original flow)
    let image_urls = [];
    if (Array.isArray(imageUrls) && imageUrls.length) {
      image_urls = imageUrls;
    } else {
      if (!files.length)  return { statusCode: 400, headers: cors(), body: 'Provide at least one file or imageUrls' };
      if (files.length>4) return { statusCode: 400, headers: cors(), body: 'Up to 4 files allowed' };

      for (const f of files) {
        const dataUrl = `data:${f.contentType || 'application/octet-stream'};base64,${f.data}`;
        const up = await fetch(UPLOAD_BASE64_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            base64Data: dataUrl,
            uploadPath: 'images/user-uploads',
            fileName: f.name || 'image.png'
          })
        });
        const uj = await up.json().catch(()=> ({}));
        if (!up.ok || !uj?.data?.downloadUrl) {
          return { statusCode: 502, headers: cors(), body: `Upload failed: ${up.status} ${JSON.stringify(uj)}` };
        }
        image_urls.push(uj.data.downloadUrl);
      }
    }

    // 2) Create the task (KIE will POST the final result to Make)
    const payload = {
      model: "google/nano-banana-edit",
      callBackUrl: callbackUrl,
      input: {
        prompt,
        image_urls,
        output_format: String(format).toLowerCase(), // png | jpeg
        image_size: "auto"
      }
    };

    const resp = await fetch(KIE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
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
