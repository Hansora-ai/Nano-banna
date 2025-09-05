// /.netlify/functions/upload
export default async (request, context) => {
  try {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405 });
    }

    const { files } = await request.json();
    if (!Array.isArray(files) || files.length === 0) {
      return new Response(JSON.stringify({ error: 'No files' }), { status: 400 });
    }
    if (files.length > 4) {
      return new Response(JSON.stringify({ error: 'Max 4 files' }), { status: 400 });
    }

    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    const urls = [];

    for (const f of files) {
      if (!f?.data || !f?.type) {
        return new Response(JSON.stringify({ error: 'Bad file payload' }), { status: 400 });
      }
      if (!allowed.has(f.type)) {
        return new Response(JSON.stringify({ error: `Unsupported type ${f.type}` }), { status: 400 });
      }

      const buf = Buffer.from(f.data, 'base64');
      if (buf.length > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File > 10MB' }), { status: 400 });
      }

      // Upload to PixelDrain
      const resp = await fetch('https://pixeldrain.com/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf
      });

      const text = await resp.text();          // read ONCE
      let data = null;
      try { data = JSON.parse(text); } catch {}

      if (!resp.ok || !data?.id) {
        return new Response(
          JSON.stringify({ error: 'Upload host failed', status: resp.status, body: text }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }

      urls.push(`https://pixeldrain.com/api/file/${data.id}`);
    }

    return new Response(JSON.stringify({ urls }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
