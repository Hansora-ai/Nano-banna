// Robust status proxy for KIE. Tries several endpoints and never throws on 404.
// Returns {endpoint, httpStatus, response} so the client can decide what to do.

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };
    if (event.httpMethod !== 'GET')
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY)
      return { statusCode: 500, headers: cors(), body: 'Missing: KIE_API_KEY' };

    const { taskId = '', recordId = '' } = event.queryStringParameters || {};
    if (!taskId && !recordId)
      return { statusCode: 400, headers: cors(), body: 'Provide taskId or recordId' };

    const urls = [];
    if (recordId) {
      urls.push(`https://api.kie.ai/api/v1/jobs/record-info?recordId=${encodeURIComponent(recordId)}`);
      urls.push(`https://api.kie.ai/api/v1/jobs/recordInfo?recordId=${encodeURIComponent(recordId)}`);
      urls.push(`https://api.kie.ai/api/v1/jobs/record-info/${encodeURIComponent(recordId)}`);
    }
    if (taskId) {
      urls.push(`https://api.kie.ai/api/v1/jobs/record-info?taskId=${encodeURIComponent(taskId)}`);
      urls.push(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
      urls.push(`https://api.kie.ai/api/v1/jobs/task-info?taskId=${encodeURIComponent(taskId)}`);
    }

    let last = null;
    for (const u of urls) {
      const r = await fetch(u, { headers: { Authorization: `Bearer ${KIE_API_KEY}` } });
      const txt = await r.text();
      let json = null; try { json = JSON.parse(txt); } catch {}
      // Always return a useful JSON envelope
      if (json) {
        return {
          statusCode: 200,
          headers: { ...cors(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: u, httpStatus: r.status, response: json })
        };
      }
      last = { endpoint: u, httpStatus: r.status, text: txt.slice(0, 4000) };
    }

    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending: true, last })
    };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: `Status error: ${e.message || e}` };
  }
};

function cors(){ return {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type, Authorization'
};}
