// netlify/functions/run-runway-tg.js
// Submit a Runway text/image → video task via KIE for Telegram Mini App.
// Credits and balance are handled by the bot/backend; we forward them to Make.com
// and also log into Supabase telegram_generations with telegram_id, model, leng, credits, new_credits, prompt.

const API_KEY = process.env.KIE_API_KEY;
const KIE_URL = "https://api.kie.ai/api/v1/runway/generate";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com scenario callback – same as MJ video flow
const MAKE_HOOK = "https://hansoraai.app.n8n.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

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
 * Insert a row into telegram_generations for this Telegram run.
 * We include telegram_id, model, leng, credits (cost), new_credits, prompt.
 */
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
        model: "Runway Video",
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
  const imageUrlRaw = (body.imageUrl || "").toString();
  const aspectRatio = (body.aspectRatio || "9:16").toString();
  const cost = Number(body.cost || 4);
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
    // For Runway we allow text-only; prompt is always required, imageUrl is optional.
    return jsonResponse(400, { error: "Missing prompt" });
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

  // Mirror the working run-runway.js KIE payload style as closely as possible,
  // so KIE sees exactly the same structure it already works with.
  // Normalize imageUrl similarly.
  const imageUrl = normalizeUrl(imageUrlRaw);

  const kiePayload = {
    ...body,
    prompt,
    aspectRatio,
    callBackUrl: callbackUrl
  };

  // Ensure defaults like in run-runway.js
  if (kiePayload.duration === undefined) kiePayload.duration = 5;
  if (kiePayload.quality === undefined)  kiePayload.quality  = "1080p";

  // Image handling: send imageUrl only when set; otherwise strip image/file fields.
  if (imageUrl) {
    kiePayload.imageUrl = imageUrl;
    delete kiePayload.fileUrl;
    delete kiePayload.image_url;
    delete kiePayload.frameImage;
  } else {
    delete kiePayload.imageUrl;
    delete kiePayload.fileUrl;
    delete kiePayload.image_url;
    delete kiePayload.frameImage;
  }

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
        error: (data && (data.error || data.message)) || "KIE Runway request failed",
        data
      });
    }

    const taskId = extractTaskId(data);

    // Log into telegram_generations (non-blocking for KIE success)
    await writeTelegramGeneration({ telegramId, cost, prompt, leng, newCredits });

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

// Small helper copied from run-runway.js style
function normalizeUrl(u) {
  try {
    const url = new URL(String(u || ""));
    return url.href;
  } catch {
    return "";
  }
}
