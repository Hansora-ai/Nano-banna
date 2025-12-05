// netlify/functions/run-seedream-45-tg.js
// Telegram Mini App — Seedream 4.5
// EXACT logic duplicated from run-nano-banana-pro-tg.js
// KIE model structure taken from run-seedream-4-5.js
// Cost = 1 (handled by Telegram UI + callback)

const CREATE_URL = process.env.KIE_CREATE_URL || "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL  = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// SAME CALLBACK as Nano Banana Pro TG
const MAKE_HOOK = "https://hook.eu2.make.com/l25fsaf15od9oywtqtm45zb0i7r7ff2o";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // Telegram fields — EXACT SAME NAMES AS nano-banana-pro
    const telegramId     = body.telegram_id || "";
    const prompt         = body.prompt || "";
    const mode           = body.mode || "";
    const leng           = body.leng || "";
    const creditsBefore  = body.credits_before || 0;
    const newCredits     = body.new_credits || 0;
    const cost           = 1; // fixed

    // Images (0–6)
    const rawUrls = Array.isArray(body.urls) ? body.urls : [];
    const imageUrls = rawUrls.map(u => encodeURI(String(u)));

    // KIE aspect ratio field (Seedream uses aspect_ratio)
    const aspectRatio = body.size || "1:1";

    // Create run_id
    const runId = `sd45-${telegramId}-${Date.now()}`;

    // Build KIE input object — EXACT from run-seedream-4-5.js
    const input = {
      prompt,
      aspect_ratio: aspectRatio,
      quality: "basic",
      output_format: "png"
    };

    const hasImages = imageUrls.length > 0;
    if (hasImages) {
      input.image_urls = imageUrls;
    }

    // Choose correct KIE model
    const modelName = hasImages
      ? "seedream/4.5-edit"
      : "seedream/4.5-text-to-image";

    // Build callback URL EXACTLY like nano-pro TG
    const callbackUrl = `${MAKE_HOOK}?telegram_id=${encodeURIComponent(
      telegramId
    )}&run_id=${encodeURIComponent(runId)}&new_credits=${encodeURIComponent(
      newCredits
    )}&credits_before=${encodeURIComponent(
      creditsBefore
    )}&cost=${encodeURIComponent(cost)}&mode=${encodeURIComponent(
      mode
    )}&leng=${encodeURIComponent(leng)}`;

    // Build KIE payload (EXACT structure, but for Seedream)
    const payload = {
      model: modelName,
      input,

      webhook_url:  callbackUrl,
      webhookUrl:   callbackUrl,
      callbackUrl:  callbackUrl,
      callBackUrl:  callbackUrl,
      notify_url:   callbackUrl,

      meta:      { telegram_id: telegramId, run_id: runId },
      metadata:  { telegram_id: telegramId, run_id: runId }
    };

    // Create job in KIE
    const create = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type":  "application/json",
        "Accept":         "application/json"
      },
      body: JSON.stringify(payload)
    });

    const raw = await create.text();
    let job;
    try { job = JSON.parse(raw); } catch { job = { raw }; }

    const taskId =
      job.taskId ||
      job.id ||
      job.data?.taskId ||
      job.data?.id ||
      null;

    // Insert into telegram_generations EXACTLY like MJ Video
    if (TG_TABLE_URL && SERVICE_KEY) {
      try {
        await fetch(TG_TABLE_URL, {
          method: "POST",
          headers: {
            "apikey": SERVICE_KEY,
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify([
            {
              telegram_id: telegramId,
              model: "Seedream 4.5",
              credits: cost,
              prompt
            }
          ])
        });
      } catch (e) {
        console.error("telegram_generations insert failed", e);
      }
    }

    return jsonResponse(200, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId,
      new_credits: newCredits
    });

  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      submitted: false,
      error: err?.message || "server_error"
    });
  }
};
