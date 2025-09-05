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

    const allowed = new Set(['image/jpeg','image/png','image/webp']);
    const urls = [];

    for (const f of files) {
      if (!f?.data || !f?.type) {
        return new Response(JSON.stringify({ error: 'Bad file payload' }), { status: 400 });
      }
      if (!allowed.has(f.type)) {
        return new Response(JSON.stringify({ error: `Unsupported type ${f.type}` }), { status: 400 });
      }
      const ext = f.type === 'image/png' ? 'png' : (f.type === 'image/webp' ? 'webp' : 'jpg');
      const buf = Buffer.from(f.data, 'base64');
      if (buf.length > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File > 10MB' }), { status: 400 });
      }
      const safeName = `${Date.now()}-${(f.name || 'img')}.${ext}`.replace(/\s+/g,'_');
      const resp = await fetch(`https://transfer.sh/${encodeURIComponent(safeName)}`, {
        method: 'PUT',
        body: buf
      });
      const text = await resp.text();
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: 'transfer.sh failed', detail: text }), { status: 502 });
      }
      urls.push(text.trim());
    }

    return new Response(JSON.stringify({ urls }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
