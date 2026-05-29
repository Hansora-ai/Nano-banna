// netlify/functions/run-seedream-tg.js
// Telegram Mini App — Seedream 4.5
// EXACT logic duplicated from run-nano-banana-pro-tg.js
// KIE model structure taken from run-seedream-4-5.js
// Cost = 0.5 (handled here so the browser cannot send the wrong price)

const CREATE_URL = process.env.KIE_CREATE_URL || "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL  = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// SAME CALLBACK as Nano Banana Pro TG
const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

// n8n webhook that sends the temporary Telegram loading message.
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

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

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === "ru"
    ? "⏳ Ваша генерация принята.\n\nПожалуйста, подождите — это может занять 1–5 минут.\n\nПока ваш запрос обрабатывается, вы можете создавать другие материалы."
    : "⏳ Your generation has been accepted.\n\nPlease wait — it may take 1–5 minutes.\n\nWhile this is being processed, you can generate other things as well.";
}

async function sendLoadingMessage({ telegramId, runId, leng, mode, cost, creditsBefore, newCredits }) {
  if (!LOADING_HOOK) return null;

  try {
    const resp = await fetch(LOADING_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        telegram_id: telegramId,
        chat_id: telegramId,
        run_id: runId,
        leng: normalizeLeng(leng),
        lang: normalizeLeng(leng),
        mode,
        cost,
        credits_before: creditsBefore,
        new_credits: newCredits,
        message: getLoadingMessage(leng)
      })
    });

    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text || "{}"); } catch { data = { raw: text }; }

    if (!resp.ok) {
      console.error("loading message hook failed", resp.status, data);
      return null;
    }

    return data.message_id || data.messageId || data.result?.message_id || null;
  } catch (e) {
    console.error("loading message hook error", e && e.message ? e.message : e);
    return null;
  }
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
    let leng             = body.leng || "";
    const creditsBefore  = Number(body.credits_before || 0);
    const cost           = 0.5;
    const newCredits     = Math.max(0, Math.round((creditsBefore - cost) * 100) / 100);

    // Images (0–6)
    const rawUrls = Array.isArray(body.urls) ? body.urls : [];
    const imageUrls = rawUrls.map(u => encodeURI(String(u)));

    // KIE aspect ratio field (Seedream uses aspect_ratio)
    const aspectRatio = body.size || "1:1";

    // Create run_id
    const runId = `sd45-${telegramId}-${Date.now()}`;

    leng = normalizeLeng(leng);

    const loadingMessageId = await sendLoadingMessage({
      telegramId,
      runId,
      leng,
      mode,
      cost,
      creditsBefore,
      newCredits
    });

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
    )}&leng=${encodeURIComponent(leng)}&loading_message_id=${encodeURIComponent(loadingMessageId || "")}`;

    // Build KIE payload (EXACT structure, but for Seedream)
    const payload = {
      model: modelName,
      input,

      webhook_url:  callbackUrl,
      webhookUrl:   callbackUrl,
      callbackUrl:  callbackUrl,
      callBackUrl:  callbackUrl,
      notify_url:   callbackUrl,

      meta:      { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId },
      metadata:  { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId }
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

    if (!create.ok) {
      return jsonResponse(create.status || 502, {
        ok: false,
        submitted: false,
        error: (job && (job.error || job.message)) || "seedream_error",
        data: job
      });
    }

    const taskId =
      job.taskId ||
      job.id ||
      job.data?.taskId ||
      job.data?.id ||
      null;

    // Insert the first row. n8n updates this same row later by run_id.
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
              prompt,
              run_id: runId,
              task_id: taskId || null,
              status: "submitted",
              kind: "image",
              result_url: null
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
      loading_message_id: loadingMessageId,
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
