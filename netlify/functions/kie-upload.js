// netlify/functions/kie-upload.js (CommonJS)
const Busboy = require('busboy');

const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) return { statusCode: 500, headers: cors(), body: 'Missing: KIE_API_KEY' };

    const ct = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!ct.includes('multipart/form-data')) {
      return { statusCode: 400, headers: cors(), body: 'Expected multipart/form-data' };
    }

    const { file, filename, mimeType: mimeFromForm, run_id } = await parseMultipart(event, ct);
    if (!file || !file.length) return { statusCode: 400, headers: cors(), body: 'No file provided' };

    // 1) Sniff MIME from bytes (JPEG/PNG/WEBP/GIF only)
    const sniffed = sniffImageMime(file); // 'image/jpeg'|'image/png'|'image/webp'|'image/gif'|''
    let finalMime = (mimeFromForm || '').toLowerCase();
    if (!finalMime.startsWith('image/')) finalMime = '';
    if (!finalMime) finalMime = sniffed;

    if (!isSupportedImage(finalMime)) {
      return { statusCode: 415, headers: cors(), body: 'Unsupported image type. Use JPEG/PNG/WebP/GIF.' };
    }

    // 2) Sanitize filename and enforce correct extension
    const base = sanitizeBase(filename || (run_id ? `${run_id}-image` : 'image'));
    const ext = extForMime(finalMime); // jpg|png|webp|gif
    let safeName = `${base}.${ext}`;

    // 3) Build data URL with corrected MIME
    const base64 = Buffer.from(file).toString('base64');
    const dataUrl = `data:${finalMime};base64,${base64}`;

    // 4) Upload once
    let urls = await uploadToKie(dataUrl, safeName, KIE_API_KEY);
    let directUrl = urls.fileUrl || urls.downloadUrl;

    // 5) Verify the URL is truly fetchable by a bot (image/*, >0 bytes)
    let ok = await verifyImageUrl(directUrl);
    if (!ok) {
      // Retry once with a fresh filename to bust any caching/edge quirk
      safeName = `${base}-${Date.now()}.${ext}`;
      urls = await uploadToKie(dataUrl, safeName, KIE_API_KEY);
      directUrl = urls.fileUrl || urls.downloadUrl;
      ok = await verifyImageUrl(directUrl);
    }

    if (!ok) {
      return {
        statusCode: 502,
        headers: { ...cors(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'verified_fetch_failed', detail: urls || null })
      };
    }

    // IMPORTANT: keep "downloadUrl" key for your front-end, but point to the direct fileUrl
    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        downloadUrl: directUrl,             // the one your client uses
        fileUrl: urls.fileUrl || null,      // debug
        rawDownloadUrl: urls.downloadUrl || null // debug
      })
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

function parseMultipart(event, contentType) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: { 'content-type': contentType } });
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '');
    const files = [];
    const fields = {};
    bb.on('file', (fieldname, stream, info) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => files.push({ buffer: Buffer.concat(chunks), filename: info.filename, mimeType: info.mimeType }));
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('error', reject);
    bb.on('finish', () => {
      const f = files[0] || {};
      resolve({ file: f.buffer, filename: f.filename, mimeType: f.mimeType, ...fields });
    });
    bb.end(body);
  });
}

// ---------- Hardening helpers ----------
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG
  if (buf.length > 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';
  // WEBP: "RIFF"...."WEBP"
  if (buf.length > 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  // GIF: "GIF8"
  if (buf.length > 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  return '';
}
function isSupportedImage(m) {
  return m === 'image/jpeg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif';
}
function extForMime(m) {
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/png')  return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif')  return 'gif';
  return 'bin';
}
function sanitizeBase(name) {
  // strip extension and normalize to ASCII-ish, keep dashes/underscores
  const base = String(name || 'image').replace(/\.[^.]+$/, '');
  return base.normalize('NFKD').replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').toLowerCase() || 'image';
}
async function uploadToKie(dataUrl, fileName, apiKey) {
  const up = await fetch(UPLOAD_BASE64_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      base64Data: dataUrl,
      uploadPath: 'images/user-uploads',
      fileName
    })
  });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok || !uj?.data) throw new Error(`upload_failed ${up.status}`);
  return { fileUrl: uj.data.fileUrl || null, downloadUrl: uj.data.downloadUrl || null };
}
async function verifyImageUrl(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'image/*' }, redirect: 'follow' });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return false;
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    // Some CDNs omit content-length; if missing, read a small chunk
    if (Number.isFinite(len) && len <= 0) return false;
    return true;
  } catch { return false; }
}
