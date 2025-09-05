// netlify/functions/kie-create.js
// Node 18+ has global fetch. No other deps needed.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'method_not_allowed' })
      };
    }

    // Parse request
    let payloadIn = {};
    try {
      payloadIn = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'bad_json', detail: String(e) })
      };
    }

    const { prompt, format = 'png', files = [] } = payloadIn;

    // Env guards
    const KIE_API_URL = process.env.KIE_API_URL;   // e.g. https://api.kie.ai/api/v1/jobs/createTask
    const KIE_API_KEY = process.env.KIE_API_KEY;   // raw key, no "Bearer"
    const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || ''; // optional

    if (!KIE_API_URL || !KIE_API_KEY) {
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'missing_env', need: ['KIE_API_URL','KIE_API_KEY'] })
      };
    }

    if (!prompt || !Array.isArray(files) || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'missing_params', need: ['prompt','files[]'] })
      };
    }

    // Upload each file to transfer.sh to obtain public URLs for KIE
    const image_urls = [];
    for (const f of files) {
      try {
        const buf = Buffer.from(f.data || '', 'base64');
        const name = encodeURIComponent(f.name || 'image');
        const up = await fetch(`https://transfer.sh/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': f.contentType || 'application/octet-stream' },
          body: buf
        });
        const txt = (await up.text()).trim();
        if (!up.ok || !/^https?:\/\//i.test(txt)) {
          return {
            statusCode: 502,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: 'upload_failed', status: up.status, body: txt })
          };
        }
        image_urls.push(txt);
      } catch (e) {
        return {
          statusCode: 502,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'upload_exception', detail: String(e) })
        };
      }
    }

    // Build KIE payload
    const createTaskPayload = {
      model: 'google/nano-banana-edit',
      callBackUrl: MAKE_WEBHOOK_URL || undefined, // keep short; optional
      input: {
        prompt,
        image_urls,
        output_format: String(format).toLowerCase(),
        image_size: 'auto',
        _client_context: { prompt, format, submittedAt: new Date().toISOString() } // for your webhook debugging
      }
    };

    // Call KIE
    const kieRes = await fetch(KIE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${KIE_API_KEY}`
      },
      body: JSON.stringify(createTaskPayload)
    });

    const kieText = await kieRes.text();
    let kieJson = null;
    try { kieJson = JSON.parse(kieText); } catch { /* keep text */ }

    if (!kieRes.ok) {
      // Return the real upstream error (JSON if available, otherwise raw text)
      return {
        statusCode: kieRes.status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'kie_error', status: kieRes.status, response: kieJson ?? { text: kieText } })
      };
    }

    // Success
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kieJson ?? { text: kieText })
    };
  } catch (err) {
    // Last-ditch catch so Netlify never returns text/plain
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'internal_exception', detail: String(err) })
    };
  }
};
