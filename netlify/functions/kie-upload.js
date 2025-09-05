// netlify/functions/kie-upload.js
const UPLOAD_BASE64_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) {
      return { statusCode: 500, headers: cors(), body: 'Missing: KIE_API_KEY' };
    }

    let bodyIn = {};
    try { bodyIn = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors(), body: 'Bad JSON' }; }

    const { name='image.png', contentType='application/octet-stream', data } = bodyIn;
    if (!data) return { statusCode: 400, headers: cors(), body: 'Missing "data"' };

    const dataUrl = `data:${contentType};base64,${data}`;
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
        fileName: name
      })
    });

    const uj = await up.json().catch(()=> ({}));
    if (!up.ok || !uj?.data?.downloadUrl) {
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'upload_failed', detail: uj }) };
    }

    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl: uj.data.downloadUrl })
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
