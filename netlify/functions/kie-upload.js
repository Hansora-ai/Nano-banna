// netlify/functions/kie-upload.js
import Busboy from 'busboy';

const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: cors(), body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
    }

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) {
      return { statusCode: 500, headers: cors(), body: 'Missing: KIE_API_KEY' };
    }

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return { statusCode: 400, headers: cors(), body: 'Expected multipart/form-data' };
    }

    // Parse multipart body
    const { file, filename, mimeType, run_id } = await parseMultipart(event, contentType);
    if (!file) {
      return { statusCode: 400, headers: cors(), body: 'No file provided' };
    }

    // Use the incoming filename (front-end prefixes it with run_id-index-…)
    const safeName = filename || (run_id ? `${run_id}-image` : 'image');

    // Convert to base64 server-side (so upstream API stays the same)
    const base64 = Buffer.from(file).toString('base64');
    const dataUrl = `data:${mimeType || 'application/octet-stream'};base64,${base64}`;

    // Forward to your existing Redpanda upload endpoint
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
    if (!up.ok || !uj?.data?.downloadUrl) {
      return {
        statusCode: 502,
        headers: { ...cors(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'upload_failed', detail: uj })
      };
    }

    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ downloadUrl: uj.data.downloadUrl })
    };
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

/** Parse multipart/form-data into { file: Buffer, filename, mimeType, run_id } */
function parseMultipart(event, contentType) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: { 'content-type': contentType } });
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '');

    const files = [];
    const fields = {};

    bb.on('file', (fieldname, stream, info) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => {
        files.push({
          fieldname,
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType
        });
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('error', reject);
    bb.on('finish', () => {
      const f = files[0] || {};
      resolve({
        file: f.buffer,
        filename: f.filename,
        mimeType: f.mimeType,
        ...fields
      });
    });

    bb.end(body);
  });
}
