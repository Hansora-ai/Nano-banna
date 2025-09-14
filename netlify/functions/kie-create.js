// netlify/functions/kie-create.js
const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

// NEW: tiny helper to validate that a URL is actually an image
async function isImageUrl(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Use GET (some CDNs block HEAD); ask for images; add cache-buster
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(), {
      method: 'GET',
      headers: { 'Accept': 'image/*' },
      cache: 'no-store',
      signal: ctrl.signal
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    return res.ok && ct.startsWith('image/');
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
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

    // ⬇️ ADDED earlier: run_id (kept)
    const { prompt, format = 'png', files = [], imageUrls = [], uid = '', run_id = '' } = bodyIn;
    if (!prompt) return { statusCode: 400, headers: cors(), body: 'Missing "prompt"' };

    // Build image_urls from URLs (preferred) or from base64 (legacy)
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

    // NEW: validate each URL is actually image/*; drop any bad ones
    if (image_urls.length) {
      const checks = await Promise.all(
        image_urls.map(async (u) => (await isImageUrl(u)) ? u : null)
      );
      image_urls = checks.filter(Boolean);
    }

    // NEW: fail closed if we don't have at least one usable image URL
    if (!image_urls.length) {
      return { statusCode: 400, headers: cors(), body: 'No usable image URLs (make sure images are JPEG/PNG/WebP and publicly fetchable).' };
    }

    // ⬇️ fixed cost (unchanged)
    const COST = 1.5;

    // Client context for debugging (kept)
    const clientContext = {
      prompt,
      format,
      submittedAt: new Date().toISOString(),
      run_id,
      uid
    };

    // ADDED earlier: include run_id + uid in the callback URL (kept)
    const callbackUrl =
      `${MAKE_WEBHOOK_URL}?ctx=${encodeURIComponent(JSON.stringify(clientContext))}` +
      `&uid=${encodeURIComponent(uid)}` +
      `&run_id=${encodeURIComponent(run_id)}` +
      `&cost=${encodeURIComponent(COST)}`;

    // NEW: be generous with field names inside `input`
    // Some Kie adapters read snake_case, others camelCase, others `images`/`reference_images`
    const input = {
      prompt,
      // primary fields
      image_urls,
      output_format: String(format).toLowerCase(), // png | jpeg
      image_size: 'auto',

      // compatibility duplicates (harmless if unused)
      imageUrls: image_urls,
      images: image_urls,
      reference_images: image_urls,
      image_url: image_urls[0],
      imageUrl: image_urls[0]
    };

    const payload = {
      model: 'google/nano-banana-edit',
      callBackUrl: callbackUrl, // unchanged
      input
      // metadata: { uid, run_id } // leave commented to avoid breaking strict schemas
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
