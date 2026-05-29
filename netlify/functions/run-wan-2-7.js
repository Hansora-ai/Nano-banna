// netlify/functions/run-wan-2-7-image-tg.js
// Wan 2.7 Image launcher for Telegram Mini App.
// Normal: 0.5 credit, Pro: 1 credit.
// n8n updates telegram_generations later by run_id.

const CREATE_URL = process.env.KIE_CREATE_URL || "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

const VERSION_TAG = "wan_2_7_image_tg_v1";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-USER-ID, x-user-id"
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...cors(), "Content-Type": "application/json", "X-NB-Version": VERSION_TAG },
    body: JSON.stringify(body)
  };
}

function normalizeAspectRatio(v) {
  if (!v) return "1:1";
  const s = String(v).trim().toLowerCase();
  const direct = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"]);
  if (direct.has(s)) return s;
  const coerced = s.replace(/(\d)[_\-:](\d)/g, "$1:$2");
  if (direct.has(coerced)) return coerced;
  return "1:1";
}

function normalizeTier(v) {
  const s = String(v || "normal").trim().toLowerCase();
  return s === "pro" ? "pro" : "normal";
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

async function writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId, modelLabel }) {
  if (!SUPABASE_URL || !SERVICE_KEY || !TG_TABLE_URL) {
    console.error("telegram_generations insert skipped: missing Supabase env");
    return;
  }

  try {
    const resp = await fetch(TG_TABLE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify([{
        telegram_id: telegramId,
        model: modelLabel || "Wan 2.7 Image",
        credits: cost,
        prompt,
        run_id: runId,
        task_id: taskId || null,
        status: "submitted",
        kind: "image",
        result_url: null
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

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, submitted: false, error: "method_not_allowed", version: VERSION_TAG });
  }

  if (!API_KEY) {
    return jsonResponse(500, { ok: false, submitted: false, error: "missing_kie_api_key", version: VERSION_TAG });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok: false, submitted: false, error: "bad_json", details: String(e && e.message || e), version: VERSION_TAG });
  }

  const telegramId = String(body.telegram_id || body.user_id || body.uid || "");
  const prompt = String(body.prompt || "").trim();

  if (!telegramId) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_telegram_id", version: VERSION_TAG });
  }

  if (!prompt) {
    return jsonResponse(400, { ok: false, submitted: false, error: "prompt_required", version: VERSION_TAG });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls
    : (Array.isArray(body.input_urls) ? body.input_urls : []);
  const inputUrls = urls.map((u) => String(u || "").trim()).filter(Boolean);
  const isImageToImage = inputUrls.length > 0;

  const aspectRatio = normalizeAspectRatio(body.aspect_ratio || body.aspectRatio || body.size);
  const tier = normalizeTier(body.tier || body.quality);
  const model = tier === "pro" ? "wan/2-7-image-pro" : "wan/2-7-image";
  const modelLabel = tier === "pro" ? "Wan 2.7 Image Pro" : "Wan 2.7 Image";
  const cost = tier === "pro" ? 1 : 0.5;

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Math.max(0, Math.round((creditsBefore - cost) * 100) / 100);

  const query = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || "";
  let mode = String(body.mode || body.modul || query.mode || query.modul || "");
  let leng = String(body.leng || body.lang || query.leng || query.lang || "");

  if (!mode && referer) {
    try {
      const u = new URL(referer);
      mode = String(u.searchParams.get("mode") || u.searchParams.get("modul") || mode || "");
    } catch (_) {}
  }

  if (!leng && referer) {
    try {
      const u = new URL(referer);
      leng = String(u.searchParams.get("leng") || u.searchParams.get("lang") || leng || "");
    } catch (_) {}
  }

  leng = normalizeLeng(leng);

  const runId = String(body.run_id || body.runId || `wan27-${telegramId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const loadingMessageId = await sendLoadingMessage({
    telegramId,
    runId,
    leng,
    mode,
    cost,
    creditsBefore,
    newCredits
  });

  const callbackUrl =
    MAKE_HOOK +
    "?telegram_id=" + encodeURIComponent(telegramId) +
    "&run_id=" + encodeURIComponent(runId) +
    "&new_credits=" + encodeURIComponent(newCredits) +
    "&credits_before=" + encodeURIComponent(creditsBefore) +
    "&cost=" + encodeURIComponent(cost) +
    "&mode=" + encodeURIComponent(mode) +
    "&leng=" + encodeURIComponent(leng) +
    "&loading_message_id=" + encodeURIComponent(loadingMessageId || "");

  const input = {
    prompt,
    aspect_ratio: aspectRatio,
    resolution: "1K",
    output_format: "png",
    n: 1,
    watermark: false,
    thinking_mode: false,
    enable_sequential: true
  };

  if (isImageToImage) {
    input.input_urls = inputUrls.map((u) => encodeURI(String(u)));
  }

  const payload = {
    model,
    input,
    webhook_url: callbackUrl,
    webhookUrl: callbackUrl,
    callbackUrl,
    callBackUrl: callbackUrl,
    notify_url: callbackUrl,
    meta: {
      telegram_id: telegramId,
      run_id: runId,
      cost,
      loading_message_id: loadingMessageId,
      tier,
      mode: isImageToImage ? "image-to-image" : "text-to-image",
      version: VERSION_TAG
    },
    metadata: {
      telegram_id: telegramId,
      run_id: runId,
      cost,
      loading_message_id: loadingMessageId,
      tier,
      mode: isImageToImage ? "image-to-image" : "text-to-image",
      version: VERSION_TAG
    }
  };

  try {
    const resp = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const taskId = data?.data?.taskId || data?.taskId || data?.data?.id || data?.id || null;

    if (!resp.ok || !taskId) {
      return jsonResponse(resp.status || 502, {
        ok: false,
        submitted: false,
        error: (data && (data.error || data.message || data.msg)) || "wan_2_7_image_error",
        data,
        version: VERSION_TAG
      });
    }

    await writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId, modelLabel });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId,
      loading_message_id: loadingMessageId,
      new_credits: newCredits,
      cost,
      tier,
      mode_used: isImageToImage ? "image_to_image" : "text_to_image",
      version: VERSION_TAG
    });
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      submitted: false,
      error: e && e.message ? e.message : "server_error",
      version: VERSION_TAG
    });
  }
};
