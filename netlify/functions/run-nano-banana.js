const API_KEY = "7714ece17d4416e99ee15eada5f91ac6";
const CREATE_URL = "https://api.kie.ai/api/v1/jobs/createTask";

// Try both styles in case the API exposes either route for fetching a task
async function fetchTask(taskId) {
  const h = { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" };

  // 1) /jobs/getTask?taskId=...
  let r = await fetch(`https://api.kie.ai/api/v1/jobs/getTask?taskId=${encodeURIComponent(taskId)}`, { headers: h });
  if (r.ok) return r.json().catch(() => ({}));

  // 2) /jobs/tasks/{id}
  r = await fetch(`https://api.kie.ai/api/v1/jobs/tasks/${encodeURIComponent(taskId)}`, { headers: h });
  if (r.ok) return r.json().catch(() => ({}));

  // last fallback: return body text for debugging
  const txt = await r.text();
  return { _raw: txt, _status: r.status };
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function collectUrls(objOrText) {
  // Prefer structured fields
  if (objOrText && typeof objOrText === "object") {
    const out = new Set();
    const push = v => { if (typeof v === "string") out.add(v); };
    const arr = v => Array.isArray(v) ? v : v ? [v] : [];

    const paths = [
      ["result"], ["results"], ["output", "images"], ["output", "image_urls"],
      ["data", "results"], ["data", "image_urls"], ["images"], ["image_urls"]
    ];
    for (const p of paths) {
      let v = objOrText;
      for (const k of p) v = v?.[k];
      if (Array.isArray(v)) v.forEach(push);
      else if (typeof v === "string") push(v);
    }
    if (out.size) return [...out];
  }
  // Fallback: scrape any http(s) URL from text/JSON (covers extension-less links)
  const s = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText || {});
  const urls = new Set();
  const re = /(https?:\/\/[^\s"'<>)\]}]+)/g;
  let m; while ((m = re.exec(s))) urls.add(m[1]);
  return [...urls];
}

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const { image_urls = [], output_format = "png", image_size = "auto", prompt = "" } =
      await request.json();

    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return new Response(JSON.stringify({ error: "No image_urls" }), { status: 400 });
    }

    // 1) Create task
    const createBody = {
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
      body: JSON.stringify(createBody)
    });

    const createText = await createResp.text();
    let createJson = null; try { createJson = JSON.parse(createText); } catch {}

    if (!createResp.ok) {
      return new Response(
        JSON.stringify({ error: "KIE error (createTask)", status: createResp.status, raw: createText }),
        { status: createResp.status, headers: { "Content-Type": "application/json" } }
      );
    }

    // Pull task id from common fields
    const taskId =
      createJson?.taskId || createJson?.task_id || createJson?.id ||
      // loose fallback from text
      (createText.match(/[a-f0-9]{16,}/i) || [null])[0];

    if (!taskId) {
      return new Response(JSON.stringify({ error: "No taskId in createTask response", raw: createText }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    // 2) Poll until success/failed or timeout (max ~70s)
    let last = null;
    for (let i = 0; i < 35; i++) {         // 35 × 2s ≈ 70s
      await sleep(2000);
      last = await fetchTask(taskId);

      const status =
        last?.status || last?.task?.status || last?.data?.status ||
        last?.state || last?.task_state;

      if (String(status).toLowerCase() === "success") {
        const urls = collectUrls(last);
        return new Response(JSON.stringify({ urls, task: last }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      if (String(status).toLowerCase() === "failed" || String(status).toLowerCase() === "error") {
        return new Response(JSON.stringify({ error: "Task failed", task: last }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
      // otherwise: queued/running → keep polling
    }

    // Timed out
    return new Response(JSON.stringify({ error: "Timeout waiting for result", task: last }), {
      status: 504, headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};
