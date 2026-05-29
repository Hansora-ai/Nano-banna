// netlify/functions/sign-upload.js
// v7: Faster and more reliable signing.
// Removes the normal bucket probe, adds timeout + one retry for Supabase signing.
// Accept Supabase upload signed path with or without `/storage/v1` prefix.
// Treat returned `signedUrl` as the PUT URL.

const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const HANDLER_VERSION = 'sign-upload@v8-batch-timeout-retry-no-probe';
const FETCH_TIMEOUT_MS = 12000;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, POST',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function resp(code, body, headers) {
  return { statusCode: code, headers: { ...cors(), ...(headers || {}) }, body };
}
function json(code, obj, headers) {
  return resp(code, JSON.stringify(obj), { 'Content-Type': 'application/json', ...(headers || {}) });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tinyFetch(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    }

    try {
      const url = new URL(rawUrl);
      const method = (opts.method || 'GET').toUpperCase();
      const headers = opts.headers || {};
      const body = opts.body || null;
      const timeoutMs = Number(opts.timeoutMs || FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS;

      const req = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          finish(resolve, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => text,
            json: async () => { try { return JSON.parse(text); } catch { return {}; } },
          });
        });
      });

      timer = setTimeout(() => {
        req.destroy(new Error(`tinyFetch timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on('error', (err) => finish(reject, err));
      if (body) {
        if (Buffer.isBuffer(body)) req.write(body);
        else if (typeof body === 'string') req.write(body, 'utf8');
        else return finish(reject, new Error('Unsupported body type'));
      }
      req.end();
    } catch (e) { finish(reject, e); }
  });
}

async function tinyFetchWithRetry(rawUrl, opts = {}, retries = 1) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await tinyFetch(rawUrl, opts);
      if (res.ok || attempt >= retries || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt >= retries) throw e;
    }

    await sleep(350 * (attempt + 1));
  }

  throw lastError || new Error('tinyFetchWithRetry failed');
}

function sanitize(name) {
  return String(name || 'file')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function extForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg' || m === 'image/pjpeg') return 'jpg';
  if (m === 'image/png' || m === 'image/x-png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/quicktime') return 'mov';
  if (m === 'video/webm') return 'webm';
  if (m === 'image/gif') return 'gif';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav';
  if (m === 'audio/mp4' || m === 'audio/m4a') return 'm4a';
  return 'bin';
}
function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function cfg() {
  const rawUrl = (process.env.SUPABASE_URL || '').trim();
  const rawBucket = (process.env.SUPABASE_BUCKET || '').trim();
  const rawKey = ((process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) || ((process.env.SUPABASE_SERVICE_KEY || '').trim());
  if (!rawUrl) throw new Error('Missing SUPABASE_URL');
  if (!rawBucket) throw new Error('Missing SUPABASE_BUCKET');
  if (!rawKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)');
  const exp = parseInt(String(process.env.SIGN_EXP || '3600'), 10) || 3600;
  return {
    url: rawUrl.replace(/\/+$/, ''),
    bucket: rawBucket,
    key: rawKey,
    exp,
  };
}

async function signUpload(urlBase, key, bucket, objectPath, mime, exp) {
  // Request a signed PUT URL
  const u = `${urlBase}/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  const body = { contentType: mime || 'application/octet-stream', upsert: true, expiresIn: exp };
  const res = await tinyFetchWithRetry(u, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: FETCH_TIMEOUT_MS,
  }, 1);
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch {}
  return { ok: res.ok, status: res.status, data, raw: txt };
}

async function probeBucket(urlBase, key, bucket) {
  return tinyFetch(`${urlBase}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${key}` },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

function objectPathFor(filename, mime) {
  const base = String(filename || 'file').replace(/\.[^.]+$/, '');
  const ext = extForMime(mime);
  const safe = `${sanitize(base)}.${ext}`;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomBytes(8).toString('hex');
  return `images/user-uploads/${y}/${m}/${d}/${rand}-${safe}`;
}

async function createSignedUpload({ url, bucket, key, exp, filename, mime }) {
  const objectPath = objectPathFor(filename, mime);
  const signed = await signUpload(url, key, bucket, objectPath, mime, exp);
  if (!signed.ok) {
    const error = new Error('sign_failed');
    error.status = signed.status;
    error.detail = signed.raw || signed.data;
    throw error;
  }

  const signedUrl = signed.data && (signed.data.signedUrl || signed.data.signedURL || signed.data.url);
  if (!signedUrl) {
    const error = new Error('sign_missing_url');
    error.status = 500;
    error.detail = signed.data || signed.raw;
    throw error;
  }

  const uploadUrl = absolutize(url, signedUrl);
  const publicUrl = `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeURIComponent(objectPath).replace(/%2F/g,'/')}`;
  return { uploadUrl, publicUrl, bucket, objectPath };
}

function absolutize(base, pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  // Ensure we include /storage/v1 if missing
  const needsPrefix = !/^\/storage\/v1\//.test(pathOrUrl);
  const p = needsPrefix ? `/storage/v1${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}` : pathOrUrl;
  return `${base}${p}`;
}

exports.handler = async (event) => {
  const headers = { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-handler-version': HANDLER_VERSION };
  try {
    if (event.httpMethod === 'OPTIONS') return resp(204, '', headers);
    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' }, headers);

    const { url, bucket, key, exp } = cfg();

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }, headers); }
    if (Array.isArray(payload.files) && payload.files.length) {
      const files = payload.files.slice(0, 20).map((file) => ({
        filename: (file && file.filename ? file.filename : '').toString(),
        mime: (file && file.mime ? file.mime : '').toString().toLowerCase()
      }));

      try {
        const signedFiles = await Promise.all(files.map((file) => createSignedUpload({ url, bucket, key, exp, ...file })));
        return json(200, { files: signedFiles, bucket },
          { ...headers, 'x-project-host': new URL(url).host, 'x-bucket': bucket, 'x-batch-count': String(signedFiles.length) });
      } catch (batchError) {
        return json(batchError.status || 502, { error: batchError.message || 'sign_failed', detail: batchError.detail || String(batchError) },
          { ...headers, 'x-project-host': new URL(url).host, 'x-bucket': bucket });
      }
    }

    const filename = (payload.filename || '').toString();
    const mime = (payload.mime || '').toString().toLowerCase();

    let signedUpload;
    try {
      signedUpload = await createSignedUpload({ url, bucket, key, exp, filename, mime });
    } catch (signError) {
      if (signError.status === 404) {
        try {
          const probe = await probeBucket(url, key, bucket);
          if (probe.status === 404) {
            return json(500, { error: 'bucket_not_found', detail: `Bucket '${bucket}' does not exist on ${new URL(url).host}` },
              { ...headers, 'x-project-host': new URL(url).host, 'x-bucket': bucket });
          }
        } catch (probeError) {
          console.error('bucket probe after sign failure failed', probeError && probeError.message ? probeError.message : probeError);
        }
      }

      return json(signError.status || 502, { error: signError.message || 'sign_failed', detail: signError.detail },
        { ...headers, 'x-project-host': new URL(url).host, 'x-bucket': bucket });
    }

    return json(200, signedUpload,
      { ...headers, 'x-project-host': new URL(url).host, 'x-bucket': bucket, 'x-object': signedUpload.objectPath });
  } catch (e) {
    return json(500, { error: 'server_error', detail: String(e && e.message ? e.message : e) }, headers);
  }
};
