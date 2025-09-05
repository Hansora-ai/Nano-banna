// netlify/functions/kie-create.js

const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST')
      return json(405, { error: 'method_not_allowed' });

    const KIE_API_URL = process.env.KIE_API_URL;
    const KIE_API_KEY = process.env.KIE_API_KEY;
    const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
    const miss = [];
    if (!KIE_API_URL) miss.push('KIE_API_URL');
    if (!KIE_API_KEY) miss.push('KIE_API_KEY');
    if (!MAKE_WEBHOOK_URL) miss.push('MAKE_WEBHOOK_URL');
    if (miss.length) return json(500, { error: 'missing_env', need: miss });

    let bodyIn = {};
    try { bodyIn = JSON.parse(event.body || '{}'); }
    catch (e) { return json(400, { error: 'bad_json', detail: String(e) }); }

    const { prompt, format = 'png', files = [], imageUrls = [] } = bodyIn;
    if (!prompt) return json(400, { error: 'missing_param', need: ['prompt'] });

    // If the browser already uploaded and gave us URLs, use them.
    let image_urls = [];
    if (Array.isArray(imageUrls) && imageUrls.length) {
      image_urls = imageUrls;
    } else {
      if (!files.length) return json(400, { error: 'missing_param', need: ['files[] | imageUrls[]'] });
      if (files.length > 4) return json(400, { error: 'too_many_files', max: 4 });

      for (const f of files) {
        const dataUrl = `data:${f.contentType || 'application/octet-stream'};base64,${f.data}`;
        const up = await fetch(UPLOAD_BASE64_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json', 'Accept':'application/json' },
          body: JSON.stringify({ base64Data: dataUrl, uploadPath: 'images/user-uploads', fileName: f.name || 'image.png' })
        });
        const uj = await up.json().catch(()=> ({}));
        if (!up.ok || !uj?.data?.downloadUrl) {
          return json(502, { error: 'upload_failed', status: up.status, body: uj });
        }
        image_urls.push(uj.data.downloadUrl);
      }
    }

    const clientContext = { prompt, format, submittedAt: new Date().toISOString() };
    const payload = {
      model: "google/nano-banana-edit",
      callBackUrl: MAKE_WEBHOOK_URL, // short; context goes inside input
      input: {
        prompt,
        image_urls,
        output_format: String(format).toLowerCase(),
        image_size: "auto",
        _client_context: clientContext
      }
    };

    const resp = await fetch(KIE_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json', 'Accept':'application/json' },
      body: JSON.stringify(payload)
    });

    const ct = resp.headers.get('content-type') || 'application/json';
    const body = await resp.text();
    return { statusCode: resp.status, headers: { ...cors(), 'Content-Type': ct }, body };
  } catch (e) {
    return json(502, { error: 'server_exception', detail: String(e) });
  }
};

function cors(){ return {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};}
function json(status, obj) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
