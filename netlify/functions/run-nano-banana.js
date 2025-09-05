const API_KEY   = "7714ece17d4416e99ee15eada5f91ac6";
const CREATE_URL= "https://api.kie.ai/api/v1/jobs/createTask";
const GET_URL_1 = "https://api.kie.ai/api/v1/jobs/getTask?taskId=";      // ?taskId={id}
const GET_URL_2 = "https://api.kie.ai/api/v1/jobs/tasks/";               // /{id}

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405);
    }

    const { image_urls = [], output_format = "png", image_size = "auto", prompt = "" } =
      await request.json();

    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return json({ error: "No image_urls" }, 400);
    }

    // 1) create task
    const payload = {
      model: "google/nano-banana-edit",
      input: { prompt, image_urls, output_format, image_size }
    };

    const createResp = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const createText = await createResp.text();
    let createJson = null; try { createJson = JSON.parse(createText); } catch {}

    if (!createResp.ok) {
      return json({ error: "KIE error (createTask)", status: createResp.status, raw: createText }, createResp.status);
    }

    const taskId = findTaskId(createJson, createText);
    if (!taskId) {
      return json({ error: "No taskId in createTask response", raw: createText, json: createJson }, 502);
    }

    // 2) poll task
    const task = await pollTask(taskId, 35, 2000); // ~70s max
    const status = readStatus(task);

    if (status === "success") {
      const urls = collectUrls(task);
      return json({ urls, task });
    }
    if (status === "failed" || status === "error") {
      return json({ error: "Task failed", task }, 500);
    }
    return json({ error: "Timeout waiting for result", task }, 504);

  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

// ---------- helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function pollTask(taskId, maxTries, delayMs) {
  const headers = { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" };
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    // try both endpoints
    let r = await fetch(GET_URL_1 + encodeURIComponent(taskId), { headers });
    if (r.ok) { last = await safeJson(r); if (last) return last; }
    r = await fetch(GET_URL_2 + encodeURIComponent(taskId), { headers });
    if (r.ok) { last = await safeJson(r); if (last) return last; }
  }
  return last;
}

async function safeJson(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } }

function readStatus(obj) {
  const s = (
    obj?.status || obj?.task?.status || obj?.data?.status ||
    obj?.state || obj?.task_state || obj?.result?.status
  );
  return String(s || "").toLowerCase();
}

function findTaskId(json, text) {
  // look through common keys, deeply
  const ids = new Set();
  const want = /^(taskid|task_id|id)$/i;
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (want.test(k) && typeof v === "string" && v.length >= 12) ids.add(v);
      if (v && typeof v === "object") walk(v);
    }
  })(json || {});

  // regex fallback from raw text (taskId: "...", or a long hex/uuid)
  if (!ids.size && typeof text === "string") {
    const m1 = text.match(/"taskId"\s*:\s*"([^"]+)"/i);
    if (m1?.[1]) ids.add(m1[1]);
    const m2 = text.match(/"task_id"\s*:\s*"([^"]+)"/i);
    if (m2?.[1]) ids.add(m2[1]);
    const m3 = text.match(/\b[0-9a-f]{24,}\b/gi); // long hex
    if (m3) m3.forEach(x => ids.add(x));
    const m4 = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi); // uuid
    if (m4) m4.forEach(x => ids.add(x));
  }
  // pick the longest-looking id
  return [...ids].sort((a,b)=>b.length-a.length)[0] || null;
}

function collectUrls(objOrText) {
  if (objOrText && typeof objOrText === "object") {
    const out = new Set(), push = v => { if (typeof v === "string") out.add(v); };
    const paths = [
      ["result"], ["results"], ["output","images"], ["output","image_urls"],
      ["data","results"], ["data","image_urls"], ["images"], ["image_urls"]
    ];
    for (const p of paths) {
      let v = objOrText; for (const k of p) v = v?.[k];
      if (Array.isArray(v)) v.forEach(push);
      else if (typeof v === "string") push(v);
    }
    if (out.size) return [...out];
  }
  const s = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText || {});
  const urls = new Set(); const re = /(https?:\/\/[^\s"'<>)\]}]+)/g; let m;
  while ((m = re.exec(s))) urls.add(m[1]);
  return [...urls];
}
