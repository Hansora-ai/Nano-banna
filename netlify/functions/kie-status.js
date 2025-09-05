// Queries KIE for job status/result using taskId or recordId.
// We try both record-info spellings to be safe.

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 204, headers: cors(), body: '' };

    if (event.httpMethod !== 'GET')
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY)
      return { statusCode: 500, headers: cors(), body: 'Missing: KIE_API_KEY' };

    const q = event.queryStringParameters || {};
    const taskId   = q.taskId || '';
    const recordId = q.recordId || '';
    if (!taskId && !recordId)
      return { statusCode: 400, headers: cors(), body: 'Provide taskId or recordId' };

    const bases = [
      'https://api.kie.ai/api/v1/jobs/record-info',
      'https://api.kie.ai/api/v1/jobs/recordInfo'
    ];

    let last = null;
    for (const base of bases) {
      const url = new URL(base);
      if (taskId)   url.searchParams.set('taskId', taskId);
      if (recordId) url.searchParams.set('recordId', recordId);

      const r = await fetch(url, { headers: { Authorization: `Bearer ${KIE_API_KEY}` } });
      const txt = await r.text();
      last = { status: r.status, body: txt, url: url.toString() };

      // KIE often returns 200 with an internal "code". Pass through whatever it returns.
      try {
        const json = JSON.parse(txt);
        return {
          statusCode: 200,
          headers: { ...cors(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: url.toString(), response: json })
        };
      } catch {
        // not JSON; try next base
      }
    }

    return {
      statusCode: 502,
      headers: cors(),
      body: `No status endpoint produced JSON. Last=${JSON.stringify(last)}`
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
