// netlify/functions/kie-create.js
const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

// Fetch remote image bytes and return { base64Data, contentType, fileName }.
// We sniff the real MIME and only allow JPEG/PNG/WEBP. Others are rejected
// with a clear error to avoid "prompt-only" fallbacks.
async function fetchUrlAsBase64(url, defaultName = 'image') {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Accept': 'image/*', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);

  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);

  function sniff(b) {
    // JPEG: FF D8 FF
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ct: 'image/jpeg', ext: 'jpg' };
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b.length > 8 &&
        b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
        b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return { ct: 'image/png', ext: 'png' };
    // WEBP: "RIFF"...."WEBP"
    if (b.length > 12 &&
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ct: 'image/webp', ext: 'webp' };
    // Unknown (HEIC/AVIF/etc.) -> reject here so we don't get prompt-only runs
    return { ct: '', ext: '' };
  }

  let { ct, ext } = sniff(bytes);
  // If server sent a good image content-type that matches our sniff, keep it.
  if (!ct) {
    // Try trusting the header only if it's an image we support
    const hdr = (res.headers.get('content-type') || '').toLowerCase();
    if (hdr.startsWith('image/')) {
      if (hdr.includes('jpeg') || hdr.includes('jpg')) { ct = 'image/jpeg'; ext = 'jpg'; }
      else if (hdr.includes('png')) { ct = 'image/png'; ext = 'png'; }
      else if (hdr.includes('webp')) { ct = 'image/webp'; ext = 'webp'; }
    }
  }
  if (!ct) {
    // Hard stop; tell the user to use JPEG/PNG/WebP (prevents silent prompt-only)
    throw new Error('unsupported image type (use JPEG/PNG/WebP)');
  }

  const b64 = Buffer.from(ab).toString('base64');
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
      // *** ALWAYS rehost incoming URLs (forces stable, correct mime) ***
      const out = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const src = imageUrls[i];
        const base64Payload = await fetchUrlAsBase64(src, `img-${i + 1}`);
        const hosted = await uploadBase64ToKie(base64Payload, KIE_API_KEY);
        out.push(hosted);
      }
      image_urls = out;
    } else {
      // Legacy base64 "files" path (unchanged)
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

    // Input block with common aliases and single-image keys
    const input = {
      prompt,
      image_urls,
      output_format: String(format).toLowerCase(), // png | jpeg
      image_size: 'auto',
      imageUrls: image_urls,
      images: image_urls,
      reference_images: image_urls,
      image_url: image_urls[0],
      imageUrl: image_urls[0],
      init_image: image_urls[0],
      init_image_url: image_urls[0]
    };

    const payload = {
      model: 'google/nano-banana-edit',
      // Both variants to ensure webhook fires
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
