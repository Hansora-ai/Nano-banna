// netlify/functions/kie-create.js
const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

// Fetch remote image and return { base64Data, contentType, fileName }
async function fetchUrlAsBase64(url, defaultName = 'image') {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const ab = await res.arrayBuffer();
  const b64 = Buffer.from(ab).toString('base64');
  const ext =
    ct.includes('png')  ? 'png' :
    (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpg' :
    ct.includes('webp') ? 'webp' : 'bin';
  return {
    base64Data: `data:${ct};base64,${b64}`,
    contentType: ct,
    fileName: `${defaultName}.${ext}`
  };
}

// Upload base64 to KIE to get a permanent, KIE-hosted URL
async function uploadBase64ToKie({ base64Data, fileName }, KIE_API_KEY) {
  const up = await fetch(UPLOAD_BASE64_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      base64Data,
      uploadPath: 'images/user-uploads',
      fileName
    })
  });
  const uj = await up.json().catch(()=> ({}));
  if (!up.ok || !uj?.data?.downloadUrl) {
    throw new Error(`rehost failed: ${up.status} ${JSON.stringify(uj)}`);
  }
  return uj.data.downloadUrl;
}

// Self-heal a URL: if not image/* or fails, rehost to KIE and return KIE URL
async function ensureKieFetchable(url, index, KIE_API_KEY) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'image/*' }, cache: 'no-store' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && ct.startsWith('image/')) return url; // good as-is
  } catch (_) {
    // fall through to rehost
  }
  const base64Payload = await fetchUrlAsBase64(url, `img-${(index || 0) + 1}`);
  const hosted = await uploadBase64ToKie(base64Payload, KIE_API_KEY);
  return hosted;
}

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
    catch { return { statusCode: 400, headers: cors(), body: 'Bad JSON' }; }

    const { prompt, format = 'png', files = [], imageUrls = [], uid = '', run_id = '' } = bodyIn;
    if (!prompt) return { statusCode: 400, headers: cors(), body: 'Missing "prompt"' };

    let image_urls = [];

    if (Array.isArray(imageUrls) && imageUrls.length) {
      const out = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const hostedOrSame = await ensureKieFetchable(imageUrls[i], i, KIE_API_KEY);
        out.push(hostedOrSame);
      }
      image_urls = out;
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

    if (!image_urls.length) {
      return { statusCode: 400, headers: cors(), body: 'No usable image URLs after rehost.' };
    }

    const COST = 1.5;
    const clientContext = {
      prompt,
      format,
      submittedAt: new Date().toISOString(),
      run_id,
      uid
    };

    const callbackUrl =
      `${MAKE_WEBHOOK_URL}?ctx=${encodeURIComponent(JSON.stringify(clientContext))}` +
      `&uid=${encodeURIComponent(uid)}` +
      `&run_id=${encodeURIComponent(run_id)}` +
      `&cost=${encodeURIComponent(COST)}`;

    const input = {
      prompt,
      image_urls,
      output_format: String(format).toLowerCase(), // png | jpeg
      image_size: 'auto',
      imageUrls: image_urls,
      images: image_urls,
      reference_images: image_urls,
      image_url: image_urls[0],
      imageUrl: image_urls[0]
    };

    const payload = {
      model: 'google/nano-banana-edit',
      // ⬇️ Minimal fix: include both key variants so KIE picks it up
      callbackUrl: callbackUrl,
      callBackUrl: callbackUrl,
      input
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
    return {
      statusCode: resp.status,
      headers: { ...cors(), 'Content-Type': ct, 'Cache-Control': 'no-store' },
      body
    };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: `Server error: ${e.message || e}` };
  }
};

function cors(){ return {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};}
