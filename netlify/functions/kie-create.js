// Uploads files to KIE's uploader, then creates a Nano Banana task
// Env vars: KIE_API_KEY (raw), KIE_API_URL (https://api.kie.ai/api/v1/jobs/createTask),
//           MAKE_WEBHOOK_URL (your Make webhook)

const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST')
      return json(405, { error: 'method_not_allowed' });

    // Env
    const KIE_API_URL = process.env.KIE_API_URL;
    const KIE_API_KEY = process.env.KIE_API_KEY;
    const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
    const miss = [];
    if (!KIE_API_URL) miss.push('KIE_API_URL');
    if (!KIE_API_KEY) miss.push('KIE_API_KEY');
    if (!MAKE_WEBHOOK_URL) miss.push('MAKE_WEBHOOK_URL');
    if (miss.length) return json(500, { error: 'missing_env', need: miss });

    // Body
    let bodyIn = {};
    try { bodyIn = JSON.parse(event.body || '{}'); }
    catch (e) { return json(400, { error: 'bad_json', detail: String(e) }); }

    const { prompt, format = 'png', files = [] } = bodyIn;
    if (!prompt)        return json(400, { error: 'missing_param', need: ['prompt'] });
    if (!files.length)  return json(400, { error: 'missing_param', need: ['files[]'] });
    if (files.length>4) return json(400, { error: 'too_many_files', max: 4 });

    // Keep the callback URL SHORT; send context inside input instead
    const clientContext = { prompt, format, submittedAt: new Date().toISOString() };
    const callbackUrl = MAKE_WEBHOOK_URL;

    // Upload each file (KIE uploader first, fallback to transfer.sh)
    async function uploadOne(f) {
      const mime = (f.contentType && /^image\//i.test(f.contentType))
        ? f.contentType.toLowerCase()
        : 'image/png';
      const ext  = mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : '.png';
      const safeName = ((f.name || 'image') + '')
        .replace(/[^\w.\-]+/g, '-')
        .slice(0, 100)
        .replace(/\.[^.]+$/, '') + ext;

      const dataUrl = `data:${mime};base64,${f.data}`;

      // KIE uploader
      try {
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
            fileName: safeName
          })
        });
        const uj = await up.json().catch(() => ({}));
        if (up.ok && uj?.data?.downloadUrl) return uj.data.downloadUrl;
      } catch (e) {
        // fall through to fallback
      }

      // Fallback: transfer.sh
      try {
        const buf = Buffer.from(f.data || '', 'base64');
        const up2 = await fetch(`https://transfer.sh/${encodeURIComponent(safeName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': mime },
          body: buf
        });
        const txt = (await up2.text()).trim();
        if (up2.ok && /^https?:\/\//i.test(txt)) return txt;
        throw new Error(`transfer.sh ${up2.status} ${txt}`);
      } catch (e) {
        throw new Error(`upload_failed: ${e.message}`);
      }
    }

    const image_urls = [];
    for (const f of files) {
      image_urls.push(await uploadOne(f));
    }

    // Create task
    const payload = {
      model: "google/nano-banana-edit",
      callBackUrl: callbackUrl,
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
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const txt = await resp.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    if (!resp.ok) return json(resp.status, { error: 'kie_error', status: resp.status, response: j ?? { text: txt } });

    return json(200, j ?? { text: txt });
  } catch (e) {
    return json(500, { error: 'internal_exception', detail: String(e) });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
function json(status, obj) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
