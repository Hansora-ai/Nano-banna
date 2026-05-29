// netlify/functions/run-kling-motion-control-tg.js
// Kling Motion Control launcher for Telegram Mini App.
// Backend owns pricing. n8n updates telegram_generations later by run_id.

const KIE_URL = "https://api.kie.ai/api/v1/jobs/createTask";
const KIE_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

const VERSION_TAG = "kling_motion_control_tg_v1";

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

function normalizeAspect(value) {
  const raw = String(value || "").trim();
  return /^(16:9|9:16|4:3|3:4|1:1|21:9)$/.test(raw) ? raw : "16:9";
}

function normalizeMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "1080p" || raw === "1080" ? "1080p" : "720p";
}

function normalizeMotionModel(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "kling30" || raw === "3.0" || raw === "kling-3.0" ? "kling30" : "kling26";
}

function billedSecondsFromDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(30, Math.max(1, Math.ceil(seconds)));
}

function computeCost(motionModel, mode, billedSeconds) {
  const m = normalizeMode(mode);
  const model = normalizeMotionModel(motionModel);
  const rate = model === "kling30"
    ? (m === "1080p" ? 1.8 : 1.5)
    : (m === "1080p" ? 1.5 : 1);
  return Number((Number(billedSeconds) * rate).toFixed(1));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.href;
  } catch (_) {
    return "";
  }
}

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage() {
  return "Your video generation has started. Please wait.";
}

function extractTaskId(data) {
  if (!data || typeof data !== "object") return "";
  const direct = [
    data?.data?.taskId,
    data?.taskId,
    data?.result?.taskId,
    data?.data?.task_id,
    data?.task_id,
    data?.result?.task_id,
    data?.data?.requestId,
    data?.requestId,
    data?.result?.requestId,
    data?.data?.request_id,
    data?.request_id,
    data?.result?.request_id,
    data?.id
  ].map((v) => (v == null ? "" : String(v))).find((v) => v.length > 3);
  if (direct) return direct;

  const seen = new Set();
  const scan = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      if (/^(task[_-]?id|request[_-]?id|id)$/i.test(key) && (typeof inner === "string" || typeof inner === "number")) {
        const out = String(inner);
        if (out.length > 3) return out;
      }
      const nested = scan(inner);
      if (nested) return nested;
    }
    return "";
  };
  return scan(data);
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
        model: modelLabel || "Kling Motion Control",
        credits: cost,
        prompt,
        run_id: runId,
        task_id: taskId || null,
        status: "submitted",
        kind: "video",
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

  if (!KIE_KEY) {
    return jsonResponse(500, { ok: false, submitted: false, error: "missing_kie_api_key", version: VERSION_TAG });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok: false, submitted: false, error: "bad_json", details: String(e && e.message || e), version: VERSION_TAG });
  }

  const telegramId = String(body.telegram_id || body.user_id || body.uid || "");
  const prompt = String(body.prompt || "").trim() || "Kling Motion Control";
  const videoUrl = normalizeUrl(body.videoUrl || body.video_url || "");
  const imageUrl = normalizeUrl(body.imageUrl || body.referenceImageUrl || body.image_url || body.reference_image_url || body.fileUrl || "");

  if (!telegramId) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_telegram_id", version: VERSION_TAG });
  }

  if (!videoUrl) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_videoUrl", version: VERSION_TAG });
  }

  if (!imageUrl) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_reference_image", version: VERSION_TAG });
  }

  const aspectRatio = normalizeAspect(body.aspectRatio || body.aspect_ratio || "16:9");
  const mode = normalizeMode(body.mode || body.resolution || "720p");
  const motionModel = normalizeMotionModel(body.motionModel || body.motion_model || "kling26");
  const billedSeconds = billedSecondsFromDuration(body.duration_seconds || body.duration || body.seconds);

  if (!billedSeconds) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_or_invalid_duration", version: VERSION_TAG });
  }

  if (billedSeconds > 30) {
    return jsonResponse(400, { ok: false, submitted: false, error: "video_too_long", version: VERSION_TAG });
  }

  const cost = computeCost(motionModel, mode, billedSeconds);
  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Math.max(0, Math.round((creditsBefore - cost) * 100) / 100);

  const query = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || "";
  let urlMode = String(body.modul || query.mode || query.modul || "");
  let leng = String(body.leng || body.lang || query.leng || query.lang || "");

  if (!urlMode && referer) {
    try {
      const u = new URL(referer);
      urlMode = String(u.searchParams.get("mode") || u.searchParams.get("modul") || urlMode || "");
    } catch (_) {}
  }

  if (!leng && referer) {
    try {
      const u = new URL(referer);
      leng = String(u.searchParams.get("leng") || u.searchParams.get("lang") || leng || "");
    } catch (_) {}
  }

  leng = normalizeLeng(leng);

  const runId = String(body.run_id || body.runId || `klingmotion-${telegramId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const loadingMessageId = await sendLoadingMessage({
    telegramId,
    runId,
    leng,
    mode: urlMode,
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
    "&mode=" + encodeURIComponent(urlMode) +
    "&leng=" + encodeURIComponent(leng) +
    "&loading_message_id=" + encodeURIComponent(loadingMessageId || "");

  const model = motionModel === "kling30" ? "kling-3.0/motion-control" : "kling-2.6/motion-control";
  const modelLabel = motionModel === "kling30" ? "Kling 3.0 Motion Control" : "Kling 2.6 Motion Control";
  const payload = {
    model,
    callBackUrl: callbackUrl,
    webhook_url: callbackUrl,
    webhookUrl: callbackUrl,
    callbackUrl,
    notify_url: callbackUrl,
    input: {
      prompt,
      aspect_ratio: aspectRatio,
      mode,
      character_orientation: "image",
      video_urls: [videoUrl],
      input_urls: [imageUrl]
    },
    meta: {
      telegram_id: telegramId,
      run_id: runId,
      cost,
      loading_message_id: loadingMessageId,
      version: VERSION_TAG
    },
    metadata: {
      telegram_id: telegramId,
      run_id: runId,
      cost,
      loading_message_id: loadingMessageId,
      version: VERSION_TAG
    }
  };

  try {
    const resp = await fetch(KIE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KIE_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || (data && data.code && Number(data.code) !== 200)) {
      return jsonResponse(resp.status || 422, {
        ok: false,
        submitted: false,
        error: "kie_create_failed",
        details: data,
        version: VERSION_TAG
      });
    }

    const taskId = extractTaskId(data);
    if (!taskId) {
      return jsonResponse(502, { ok: false, submitted: false, error: "missing_task_id", details: data, version: VERSION_TAG });
    }

    await writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId, modelLabel });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      taskId,
      id: taskId,
      run_id: runId,
      loading_message_id: loadingMessageId,
      new_credits: newCredits,
      cost,
      kind: "video",
      billed_seconds: billedSeconds,
      motion_model: motionModel,
      version: VERSION_TAG
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      submitted: false,
      error: "server_error",
      details: String(error && error.message || error),
      version: VERSION_TAG
    });
  }
};
