// netlify/functions/run-gemini-omni-video-tg.js
// Gemini Omni Video launcher for Telegram Mini App.
// Backend owns pricing. n8n updates telegram_generations later by run_id.

const KIE_BASE = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");
const KIE_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

const VERSION_TAG = "gemini_omni_video_tg_v1";

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
    data?.data?.taskId,
    data?.taskId,
    data?.result?.taskId,
    data?.data?.task_id,
    data?.task_id,
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

function normalizeDuration(value) {
  const duration = Number(value || 4);
  return [4, 6, 8, 10].includes(duration) ? duration : 4;
}

function normalizeResolution(value) {
  const key = String(value || "1080p").toLowerCase();
  return key === "4k" ? "4k" : "1080p";
}

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage() {
  return "Your video generation has started. Please wait.";
}

function getUrlList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

const GEMINI_VOICE_PRESETS = {
  achernar: { label: "Achernar", description: "female, soft, high pitch", sample: "Hello, I am achernar." },
  achird: { label: "Achird", description: "male, friendly, mid pitch", sample: "Hello, I am achird." },
  algenib: { label: "Algenib", description: "male, raspy, low pitch", sample: "Hello, I am algenib." },
  algieba: { label: "Algieba", description: "male, easygoing, mid-low pitch", sample: "Hello, I am algieba." },
  alnilam: { label: "Alnilam", description: "male, steady, mid-low pitch", sample: "Hello, I am alnilam." },
  aoede: { label: "Aoede", description: "female, brisk, mid pitch", sample: "Hello, I am aoede." },
  autonoe: { label: "Autonoe", description: "female, bright, mid pitch", sample: "Hello, I am autonoe." },
  callirrhoe: { label: "Callirrhoe", description: "female, easygoing, mid pitch", sample: "Hello, I am callirrhoe." },
  charon: { label: "Charon", description: "male, intellectual, low pitch", sample: "Hello, I am charon." },
  despina: { label: "Despina", description: "female, smooth, mid pitch", sample: "Hello, I am despina." },
  enceladus: { label: "Enceladus", description: "male, breathy, low pitch", sample: "Hello, I am enceladus." },
  erinome: { label: "Erinome", description: "female, clear, mid pitch", sample: "Hello, I am erinome." },
  fenrir: { label: "Fenrir", description: "male, lively, younger pitch", sample: "Hello, I am fenrir." },
  gacrux: { label: "Gacrux", description: "female, mature, mid pitch", sample: "Hello, I am gacrux." },
  iapetus: { label: "Iapetus", description: "male, clear, mid-low pitch", sample: "Hello, I am iapetus." },
  kore: { label: "Kore", description: "female, capable, mid pitch", sample: "Hello, I am kore." },
  laomedeia: { label: "Laomedeia", description: "female, cheerful, mid-high pitch", sample: "Hello, I am laomedeia." },
  leda: { label: "Leda", description: "female, young, mid-high pitch", sample: "Hello, I am leda." },
  orus: { label: "Orus", description: "male, steady, mid-low pitch", sample: "Hello, I am orus." },
  puck: { label: "Puck", description: "male, cheerful, mid pitch", sample: "Hello, I am puck." },
  pulcherrima: { label: "Pulcherrima", description: "genderless, forward, mid-high pitch", sample: "Hello, I am pulcherrima." },
  rasalgethi: { label: "Rasalgethi", description: "male, intellectual, mid pitch", sample: "Hello, I am rasalgethi." },
  sadachbia: { label: "Sadachbia", description: "male, vivid, low pitch", sample: "Hello, I am sadachbia." },
  sadaltager: { label: "Sadaltager", description: "male, knowledgeable, mid pitch", sample: "Hello, I am sadaltager." },
  schedar: { label: "Schedar", description: "male, smooth, mid-low pitch", sample: "Hello, I am schedar." },
  sulafat: { label: "Sulafat", description: "female, warm, mid pitch", sample: "Hello, I am sulafat." },
  umbriel: { label: "Umbriel", description: "male, smooth, low pitch", sample: "Hello, I am umbriel." },
  vindemiatrix: { label: "Vindemiatrix", description: "female, gentle, mid pitch", sample: "Hello, I am vindemiatrix." },
  zephyr: { label: "Zephyr", description: "female, bright, mid-high pitch", sample: "Hello, I am zephyr." },
  zubenelgenubi: { label: "Zubenelgenubi", description: "male, casual, mid-low pitch", sample: "Hello, I am zubenelgenubi." }
};

function normalizeVoicePreset(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function extractKieAudioId(data) {
  const values = [
    data?.data?.kieAudioId,
    data?.data?.audioId,
    data?.data?.audio_id,
    data?.kieAudioId,
    data?.audioId,
    data?.audio_id
  ];
  return values.map((value) => (value == null ? "" : String(value).trim())).find(Boolean) || "";
}

async function createGeminiOmniAudioId(presetId) {
  const preset = GEMINI_VOICE_PRESETS[presetId];
  if (!preset) return presetId;

  const res = await fetch(`${KIE_BASE}/api/v1/omni/audio/create`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KIE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_id: presetId,
      name: `${preset.label} voice`,
      voice_description: preset.description,
      example_dialogue: preset.sample
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.code && Number(data.code) !== 0 && Number(data.code) !== 200)) {
    const message = data?.msg || data?.message || `audio_create_failed_${res.status}`;
    throw new Error(message);
  }

  const id = extractKieAudioId(data);
  if (!id) throw new Error("missing_kie_audio_id");
  return id;
}

async function resolveGeminiOmniAudioIds(values) {
  const ids = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const presetId = normalizeVoicePreset(raw);
    ids.push(await createGeminiOmniAudioId(presetId || raw));
  }
  return ids.slice(0, 1);
}

function costFor(body) {
  const resolution = normalizeResolution(body.resolution);
  const hasVideo = !!String(body.video_url || body.videoUrl || "").trim();
  if (hasVideo) return resolution === "4k" ? 25 : 17;
  const duration = normalizeDuration(body.duration);
  const table1080 = { 4: 6, 6: 8, 8: 10, 10: 12 };
  const table4k = { 4: 13, 6: 15, 8: 17, 10: 19 };
  return resolution === "4k" ? table4k[duration] : table1080[duration];
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

async function writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId }) {
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
        model: "Gemini Omni Video",
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
  const prompt = String(body.prompt || "").trim();

  if (!telegramId) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_telegram_id", version: VERSION_TAG });
  }

  if (!prompt) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_prompt", version: VERSION_TAG });
  }

  const imageUrls = getUrlList(body.image_urls || body.imageUrls || body.urls).slice(0, 7);
  const videoUrl = String(body.video_url || body.videoUrl || "").trim();
  const requestedAudioIds = Array.isArray(body.audio_ids)
    ? body.audio_ids.filter(Boolean).map(String)
    : String(body.audio_ids || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  const quotaUnits = imageUrls.length + (videoUrl ? 2 : 0);

  if (quotaUnits > 7) {
    return jsonResponse(400, {
      ok: false,
      submitted: false,
      error: "too_many_inputs",
      message: "Gemini Omni supports up to 7 input units. Each image is 1 unit and one video is 2 units.",
      version: VERSION_TAG
    });
  }

  const duration = normalizeDuration(body.duration);
  const resolution = normalizeResolution(body.resolution);
  const aspectRatio = ["16:9", "9:16"].includes(String(body.aspect_ratio || "16:9"))
    ? String(body.aspect_ratio || "16:9")
    : "16:9";
  const cost = costFor({ video_url: videoUrl, resolution, duration });
  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Math.max(0, Math.round((creditsBefore - cost) * 100) / 100);
  const model = String(process.env.GEMINI_OMNI_VIDEO_MODEL || "gemini-omni-video").trim();

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

  const runId = String(body.run_id || body.runId || `geminiomni-${telegramId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  let audioIds = [];
  try {
    audioIds = await resolveGeminiOmniAudioIds(requestedAudioIds);
  } catch (error) {
    return jsonResponse(422, {
      ok: false,
      submitted: false,
      error: "voice_setup_failed",
      details: String(error && error.message || error),
      version: VERSION_TAG
    });
  }

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

  const input = {
    prompt,
    duration: String(duration),
    aspect_ratio: aspectRatio,
    resolution,
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    ...(videoUrl ? { video_list: [{ url: videoUrl, start: 0, ends: duration }] } : {}),
    ...(audioIds.length ? { audio_ids: audioIds } : {})
  };

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
    const resp = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
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

    await writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId });

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
