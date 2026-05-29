// netlify/functions/run-seedance-cheap-tg.js
// Text-only Seedance 2.0 cheap route through BytePlus ModelArk for Telegram Mini App.
// Any request with uploaded media must stay on the standard Seedance Telegram route.

const ARK_BASE = (process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com").replace(/\/+$/, "");
const ARK_KEY = process.env.seedance_cheap || process.env.SEEDANCE_CHEAP || process.env.ARK_API_KEY || process.env.BYTEPLUS_ARK_API_KEY || "";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

const VERSION_TAG = "seedance_cheap_tg_v1";

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

function extractTaskId(data) {
  if (!data || typeof data !== "object") return "";
  const direct = [
    data?.data?.id,
    data?.data?.task_id,
    data?.data?.taskId,
    data?.id,
    data?.task_id,
    data?.taskId,
    data?.result?.id,
    data?.result?.task_id,
    data?.result?.taskId
  ].map((v) => (v == null ? "" : String(v))).find((v) => v.length > 3);
  if (direct) return direct;

  const seen = new Set();
  const scan = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      if (/^(id|task[_-]?id|request[_-]?id)$/i.test(key) && (typeof inner === "string" || typeof inner === "number")) {
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

function clampDuration(value) {
  const duration = Number(value || 5);
  if (!Number.isFinite(duration)) return 5;
  return Math.min(15, Math.max(4, Math.round(duration)));
}

function normalizeResolution(value, variant) {
  const raw = String(value || "720p").toLowerCase();
  if (variant === "fast") return raw === "480p" ? "480p" : "720p";
  if (raw === "480p" || raw === "720p" || raw === "1080p") return raw;
  return "720p";
}

function normalizeRatio(value) {
  const raw = String(value || "16:9").trim();
  return ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(raw) ? raw : "16:9";
}

function normalizeModel(value, variant) {
  const raw = String(value || "").trim();
  if (raw) return raw;
  if (variant === "fast") return process.env.SEEDANCE_CHEAP_FAST_MODEL || "dreamina-seedance-2-0-fast-260128";
  return process.env.SEEDANCE_CHEAP_MODEL || "dreamina-seedance-2-0-260128";
}

function costFor(body) {
  const duration = clampDuration(body.duration);
  const variant = String(body.variant || "").toLowerCase();
  const resolution = String(body.resolution || "720p");
  if (variant === "fast" || variant === "lite") return Number((duration * 2.5).toFixed(1));
  return Number((duration * (resolution === "1080p" ? 5.5 : 2.5)).toFixed(1));
}

function hasMedia(body) {
  const arrays = [
    body.reference_image_urls,
    body.reference_video_urls,
    body.reference_audio_urls,
    body.image_urls,
    body.video_urls,
    body.audio_urls,
    body.urls
  ];
  return !!(
    body.first_frame_url ||
    body.last_frame_url ||
    body.image_url ||
    body.video_url ||
    body.audio_url ||
    arrays.some((value) => Array.isArray(value) && value.filter(Boolean).length)
  );
}

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === "ru"
    ? "⏳ Ваша видео генерация запущена. Пожалуйста, подождите…"
    : "⏳ Your video generation has started. Please wait…";
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
        model: modelLabel || "Seedance 2.0 Cheap Video",
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

  if (!ARK_KEY) {
    return jsonResponse(500, { ok: false, submitted: false, error: "missing_ark_key", version: VERSION_TAG });
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
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_prompt", version: VERSION_TAG });
  }

  if (hasMedia(body)) {
    return jsonResponse(409, { ok: false, submitted: false, error: "media_requires_standard_seedance_route", version: VERSION_TAG });
  }

  const variant = ["fast", "lite"].includes(String(body.variant || "").toLowerCase()) ? "fast" : "standard";
  const duration = clampDuration(body.duration);
  const resolution = normalizeResolution(body.resolution, variant);
  const ratio = normalizeRatio(body.aspect_ratio || body.aspectRatio || body.ratio);
  const cost = costFor({ ...body, duration, resolution, variant });
  const model = normalizeModel(body.model, variant);
  const modelLabel = variant === "fast" ? "Seedance 2.0 Cheap Fast Video" : "Seedance 2.0 Cheap Video";

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

  const runId = String(body.run_id || body.runId || `seedancecheap-${telegramId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

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

  const arkPayload = {
    model,
    content: [{ type: "text", text: prompt }],
    ratio,
    resolution,
    duration,
    generate_audio: body.generate_audio !== false,
    return_last_frame: !!body.return_last_frame,
    watermark: false,
    callback_url: callbackUrl
  };

  try {
    const resp = await fetch(`${ARK_BASE}/api/v3/contents/generations/tasks`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ARK_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(arkPayload)
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok: false,
        submitted: false,
        error: "seedance_create_failed",
        details: data,
        version: VERSION_TAG
      });
    }

    const providerStatus = String(data?.data?.status || data?.status || "").toLowerCase();
    if (/(fail|failed|error|rejected|denied|blocked)/.test(providerStatus)) {
      return jsonResponse(422, { ok: false, submitted: false, error: "seedance_create_failed", details: data, version: VERSION_TAG });
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
      checker: "seedance-cheap",
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
