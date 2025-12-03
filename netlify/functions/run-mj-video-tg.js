// netlify/functions/run-mj-video-tg.js
// Submit a Midjourney image→video task via KIE for Telegram Mini App.
// No Supabase writes here; credits are managed by the bot/backend.
// We only forward telegram_id and new_credits to the Make.com webhook callback.

const API_KEY = process.env.KIE_API_KEY;
const KIE_URL = "https://api.kie.ai/api/v1/mj/generate";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

async function writeTelegramGeneration({ telegramId, cost, prompt }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TG_TABLE_URL) {
    console.error("telegram_generations insert skipped: missing Supabase env");
    return;
  }

  try {
    const resp = await fetch(TG_TABLE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify([{
        telegram_id: telegramId,
        model: "MJ Video",
        credits: cost,
        prompt
      }])
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("telegram_generations insert failed", resp.status, text);
    }
  } catch (e) {
    console.error("telegram_generations insert error", e && e.message ? e.message : e);
  }
}



// Make.com scenario callback – provided by user
const MAKE_HOOK = "https://hook.eu2.make.com/l25fsaf15od9oywtqtm45zb0i7r7ff2o";

/**
 * Basic JSON response helper
 */
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/**
 * Extract a taskId / requestId from KIE response in a tolerant way
 */
function extractTaskId(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.taskId === "string") return data.taskId;
  if (typeof data.id === "string") return data.id;
  if (typeof data.requestId === "string") return data.requestId;

  const seen = new Set();
  function scan(x) {
    if (!x || typeof x !== "object" || seen.has(x)) return "";
    seen.add(x);
    for (const [k, v] of Object.entries(x)) {
      if (/^(task[_-]?id|request[_-]?id)$/i.test(k) && (typeof v === "string" || typeof v === "number")) {
        const s = String(v);
        if (s.length > 3) return s;
      }
      const inner = scan(v);
      if (inner) return inner;
    }
    return "";
  }
  return scan(data) || "";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (!API_KEY) {
    return jsonResponse(500, { error: "Missing KIE_API_KEY" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString();
  const imageUrl = (body.imageUrl || "").toString();
  const aspectRatio = (body.aspectRatio || "1:1").toString();
  const cost = Number(body.cost || 2);
  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);

  // Try to capture mode / leng from body, query string, or Referer URL
  const query = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || "";
  let mode = (body.mode || body.modul || query.mode || query.modul || "").toString();
  let leng = (body.leng || body.lang || query.leng || query.lang || "").toString();

  if (!mode && referer) {
    try {
      const u = new URL(referer);
      mode = (u.searchParams.get("mode") || u.searchParams.get("modul") || mode || "").toString();
    } catch (_) {}
  }

  if (!leng && referer) {
    try {
      const u2 = new URL(referer);
      leng = (u2.searchParams.get("leng") || u2.searchParams.get("lang") || leng || "").toString();
    } catch (_) {}
  }

  if (!telegramId) {
    return jsonResponse(400, { error: "Missing telegram_id" });
  }
  if (!prompt) {
    return jsonResponse(400, { error: "Missing prompt" });
  }
  if (!imageUrl) {
    return jsonResponse(400, { error: "Missing imageUrl" });
  }

  const runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const callbackUrl =
    MAKE_HOOK +
    "?telegram_id=" + encodeURIComponent(telegramId) +
    "&run_id=" + encodeURIComponent(runId) +
    "&new_credits=" + encodeURIComponent(newCredits) +
    "&credits_before=" + encodeURIComponent(creditsBefore) +
    "&cost=" + encodeURIComponent(cost) +
    "&mode=" + encodeURIComponent(mode) +
    "&leng=" + encodeURIComponent(leng);

  const kiePayload = {
    taskType: "mj_video",
    version: 7,
    prompt,
    fileUrl: imageUrl,
    aspectRatio,
    speed: "fast",
    motion: "high",
    stylization: 100,
    enableTranslation: false,
    videoBatchSize: 1,
    callBackUrl: callbackUrl
  };

  try {
    const resp = await fetch(KIE_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(kiePayload)
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }

    if (!resp.ok) {
      return jsonResponse(resp.status, {
        submitted: false,
        error: data && (data.error || data.message) || "KIE request failed",
        data
      });
    }

    const taskId = extractTaskId(data);
    await writeTelegramGeneration({ telegramId, cost, prompt });



    return jsonResponse(200, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId: taskId || null,
      new_credits: newCredits
    });
  } catch (err) {
    return jsonResponse(500, {
      submitted: false,
      error: err && err.message ? err.message : "Unexpected error"
    });
  }
};
