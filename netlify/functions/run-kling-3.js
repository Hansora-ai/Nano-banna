// netlify/functions/run-kling-30-tg.js
// Kling 3.0 video launcher for Telegram Mini App.
// Backend owns pricing. n8n updates telegram_generations later by run_id.

const KIE_BASE = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");
const KIE_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

const VERSION_TAG = "kling_30_tg_v1";

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

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage() {
  return "Your video generation has started. Please wait.";
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

function costFor(body) {
  const duration = Math.max(1, Number(body.duration || 5));
  const resolution = String(body.resolution || "720p");
  const sound = !!body.sound;
  let rate = 1;
  if (resolution === "4K") rate = 4;
  else if (resolution === "1080p") rate = sound ? 2 : 1.5;
  else rate = sound ? 1.5 : 1;
  return Number((duration * rate).toFixed(1));
}

function sanitizeElementName(name) {
  let s = String(name || "").trim().replace(/[^a-zA-Z0-9_]/g, "_");
  if (!s) return "";
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.slice(0, 32);
}

function appendElementReference(prompt, elementName) {
  const base = String(prompt || "").trim();
  const cleanName = sanitizeElementName(elementName);
  if (!cleanName) return base;
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refRegex = new RegExp("(^|\\s)@" + escaped + "(?=\\s|$)", "i");
  if (refRegex.test(base)) return base;
  return (base ? base + " " : "") + "@" + cleanName;
}

function normalizeElementDescription(description) {
  const raw = String(description || "").trim();
  if (!raw) return "";
  return /\belement\b/i.test(raw) ? raw : `element: ${raw}`;
}

function normalizeAndValidateKlingElements(rawElements) {
  const elements = Array.isArray(rawElements) ? rawElements : [];
  if (elements.length > 3) {
    return { ok: false, error: "too_many_kling_elements", details: "Kling 3.0 supports up to 3 element references per request." };
  }

  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < elements.length; i += 1) {
    const item = elements[i] || {};
    const name = sanitizeElementName(item.name);
    const description = normalizeElementDescription(item.description);
    const imageUrls = Array.isArray(item.element_input_urls) ? item.element_input_urls.map(String).filter(Boolean) : [];
    const videoUrls = Array.isArray(item.element_input_video_urls)
      ? item.element_input_video_urls.map(String).filter(Boolean)
      : (item.element_input_video_url ? [String(item.element_input_video_url)].filter(Boolean) : []);

    if (!name) return { ok: false, error: "invalid_kling_element", details: `Element ${i + 1}: name is required.` };
    if (!description) return { ok: false, error: "invalid_kling_element", details: `Element ${i + 1}: description is required.` };
    if (seen.has(name)) return { ok: false, error: "duplicate_kling_element_name", details: `Duplicate element name: ${name}` };
    seen.add(name);

    if (imageUrls.length && videoUrls.length) {
      return { ok: false, error: "invalid_kling_element", details: `Element ${name}: use image URLs or video URLs, not both.` };
    }
    if (videoUrls.length) {
      if (videoUrls.length !== 1) return { ok: false, error: "invalid_kling_element", details: `Element ${name}: video element requires exactly 1 video URL.` };
      normalized.push({ name, description, element_input_video_urls: videoUrls });
      continue;
    }
    if (imageUrls.length < 2 || imageUrls.length > 4) {
      return { ok: false, error: "invalid_kling_element", details: `Element ${name}: image element requires 2-4 image URLs.` };
    }
    normalized.push({ name, description, element_input_urls: imageUrls });
  }

  return { ok: true, elements: normalized };
}

function normalizeMultiPrompt(rawMultiPrompt, elements) {
  const multiPrompt = Array.isArray(rawMultiPrompt) ? rawMultiPrompt.slice(0, 5) : [];
  return multiPrompt.map((shot, index) => {
    const duration = Math.max(1, Math.min(12, Number(shot?.duration || 3)));
    let prompt = String(shot?.prompt || "").trim();
    const element = elements[index] || null;
    if (element && element.name) prompt = appendElementReference(prompt, element.name);
    return { prompt, duration };
  });
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
        model: "Kling 3.0 Video",
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

  if (!prompt && !Array.isArray(body.kling_elements)) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_prompt", version: VERSION_TAG });
  }

  const cost = costFor(body);
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

  const runId = String(body.run_id || body.runId || `kling30-${telegramId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

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

  const resolution = String(body.resolution || "720p");
  const elementsResult = normalizeAndValidateKlingElements(body.kling_elements);
  if (!elementsResult.ok) {
    return jsonResponse(400, { ok: false, submitted: false, error: elementsResult.error, details: elementsResult.details, version: VERSION_TAG });
  }

  const klingElements = elementsResult.elements || [];
  const multiPrompt = normalizeMultiPrompt(body.multi_prompt, klingElements);
  const totalShotSeconds = multiPrompt.reduce((sum, shot) => sum + Math.max(1, Number(shot?.duration || 1)), 0);

  if (body.multi_shots) {
    if (!multiPrompt.length) {
      return jsonResponse(400, { ok: false, submitted: false, error: "missing_multi_prompt", version: VERSION_TAG });
    }
    if (totalShotSeconds > 15) {
      return jsonResponse(400, { ok: false, submitted: false, error: "multi_shots_too_long", details: "Kling 3.0 multi-shot total duration must be 15 seconds or less.", version: VERSION_TAG });
    }
    const badShot = multiPrompt.find((shot) => !shot.prompt || Number(shot.duration) < 1 || Number(shot.duration) > 12);
    if (badShot) {
      return jsonResponse(400, { ok: false, submitted: false, error: "invalid_multi_prompt", details: "Each multi-shot prompt must include prompt text and duration from 1-12 seconds.", version: VERSION_TAG });
    }
  }

  const imageUrlsRaw = Array.isArray(body.image_urls)
    ? body.image_urls
    : (Array.isArray(body.urls) ? body.urls : []);
  const imageUrls = imageUrlsRaw.map(String).filter(Boolean);
  const safeImageUrls = body.multi_shots ? imageUrls.slice(0, 1) : imageUrls.slice(0, 2);

  const firstFrameUrl = body.first_frame_url || body.firstFrameUrl || body.startImageUrl || "";
  const lastFrameUrl = body.last_frame_url || body.lastFrameUrl || body.endImageUrl || "";

  const promptForKie = klingElements.length && !body.multi_shots
    ? klingElements.reduce((out, element) => appendElementReference(out, element.name), prompt)
    : prompt;

  const input = {
    prompt: promptForKie,
    aspect_ratio: String(body.aspect_ratio || body.aspectRatio || "16:9"),
    duration: Math.max(1, Number(body.duration || 5)),
    mode: body.kling_mode || body.mode || (resolution === "4K" ? "4K" : (resolution === "1080p" ? "pro" : "std")),
    sound: !!body.sound,
    multi_shots: !!body.multi_shots,
    ...(firstFrameUrl ? { first_frame_url: String(firstFrameUrl) } : {}),
    ...(!body.multi_shots && lastFrameUrl ? { last_frame_url: String(lastFrameUrl) } : {}),
    ...(safeImageUrls.length ? { image_urls: safeImageUrls } : {}),
    ...(klingElements.length ? { kling_elements: klingElements } : {}),
    ...(multiPrompt.length ? { multi_prompt: multiPrompt } : {})
  };

  const model = process.env.KLING_30_MODEL || "kling-3.0/video";
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

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
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
