// netlify/functions/run-nano-banana.js
const API_KEY = "7714ece17d4416e99ee15eada5f91ac6";

// KIE endpoints (per their docs)
const CREATE_URL = "https://api.kie.ai/api/v1/jobs/createTask";
// We don't know which "get" route your account exposes, so try a few:
const RESULT_URLS = [
  (id) => `https://api.kie.ai/api/v1/jobs/getTask?taskId=${id}`,
  (id) => `https://api.kie.ai/api/v1/jobs/getTaskResult?taskId=${id}`,
  (id) => `https://api.kie.ai/api/v1/jobs/result?taskId=${id}`,
];

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { urls, prompt = "", format = "png", size = "auto" } = await req.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ error: "urls[] required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // *** FOLLOWING KIE EXAMPLE EXACTLY ***
    const payload = {
      model: "google/nano-banana-edit",
      input: {
        prompt,
        image_urls: urls,
        output_format: format,
        image_size: size,
      },
    };

    const create = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const createText = await create.text();
    let createJson;
    try { createJson = JSON.parse(createText); } catch { createJson = { raw: createText }; }

    // Be flexible about the field name that holds the task id
    const taskId =
      createJson.taskId ||
      createJson.id ||
      createJson.data?.taskId ||
      createJson.data?.id ||
      createJson.result?.taskId ||
      createJson.result?.id;

    if (!taskId) {
      // Echo back what we got so you can see the exact shape from KIE
      return new Response(
        JSON.stringify({ error: "No taskId from KIE", createJson }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Poll for result (max ~2 min)
    const deadline = Date.now() + 120000;
    let last;
    while (Date.now() < deadline) {
      for (const makeUrl of RESULT_URLS) {
        const res = await fetch(makeUrl(taskId), {
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
        last = json;

        const status =
          json.status || json.data?.status || json.result?.status || json.state;
        const s = String(status || "").toLowerCase();

        if (["success", "succeeded", "completed", "done"].includes(s)) {
          return new Response(
            JSON.stringify({ taskId, ...json }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (["failed", "error"].includes(s)) {
          return new Response(
            JSON.stringify({ taskId, ...json }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    return new Response(
      JSON.stringify({ taskId, timeout: true, last }),
      { status: 504, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
