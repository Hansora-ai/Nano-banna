// netlify/functions/run-grok-video.js
// Submit a Grok Video text/image → video task via KIE for Telegram Mini App.
// Credits and balance are handled on the Telegram side; we forward them to Make.com
// and also log into Supabase telegram_generations with telegram_id, model, credits, prompt.

const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY  = process.env.KIE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com scenario callback – same as MJ / Runway video flow
const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

// n8n webhook that sends the temporary Telegram video loading/process message.
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/83b19830-f204-4e40-bef7-cfab15abf797";

const COST_PER_SECOND = 0.3;
const MIN_DURATION = 6;
const MAX_DURATION = 30;
const DEFAULT_DURATION = 6;
const MAX_IMAGES = 3;

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === "ru"
    ? "⏳ Ваша генерация принята.\n\nПожалуйста, подождите — это может занять 5–10 минут в зависимости от видеомодели.\n\nПока ваш запрос обрабатывается, вы можете создавать другие материалы."
    : "⏳ Your generation has been accepted.\n\nPlease wait — this can take 5–10 minutes depending on the video model.\n\nWhile this is being processed, you can generate other things as well.";
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

// Insert a row into telegram_generations for this Telegram Grok Video run.
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
        model: "Grok Video",
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

// Extract a taskId from various KIE response shapes
function extractTaskId(data){
  if (!data || typeof data !== 'object') return '';
  const cands = [
    data?.data?.taskId, data?.taskId, data?.result?.taskId,
    data?.data?.task_id, data?.task_id, data?.result?.task_id,
    data?.id
  ].map(v => (v==null?'':String(v))).filter(s => s && s.length>3);
  if (cands.length) return cands[0];
  const seen = new Set();
  const scan = (x)=>{
    if (!x || typeof x!=='object' || seen.has(x)) return '';
    seen.add(x);
    for (const [k,v] of Object.entries(x)){
      if (/^(task[_-]?id|request[_-]?id|id)$/i.test(k) && (typeof v==='string'||typeof v==='number')) {
        const s = String(v); if (s.length>3) return s;
      }
      const inner = scan(v); if (inner) return inner;
    }
    return '';
  };
  return scan(data) || '';
}

exports.handler = async function(event){
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok:false, error: "method_not_allowed" });
  }

  if (!KIE_KEY) {
    return jsonResponse(500, { ok:false, error: "missing_kie_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, error: "bad_json", details: String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString();
  const imageUrlRaw = (body.imageUrl || body.image_url || "").toString();
  const imageUrlsRaw = Array.isArray(body.imageUrls) ? body.imageUrls : (Array.isArray(body.image_urls) ? body.image_urls : []);

  const parsedDuration = Math.round(Number(body.duration || DEFAULT_DURATION));
  const duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Number.isFinite(parsedDuration) ? parsedDuration : DEFAULT_DURATION));

  const allowedRatios = new Set(["9:16", "16:9", "1:1", "4:3", "3:4", "3:2", "2:3"]);
  const requestedRatio = (body.aspectRatio || body.aspect_ratio || "9:16").toString();
  const aspectRatio = allowedRatios.has(requestedRatio) ? requestedRatio : "9:16";

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);

  const cost = Number((duration * COST_PER_SECOND).toFixed(2));

  // mode / leng collection from body, query, referer
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
    return jsonResponse(400, { ok:false, error: "missing_telegram_id" });
  }
  if (!prompt) {
    // For Grok Video mini app, prompt is always required; images are optional (text-only or text+images).
    return jsonResponse(400, { ok:false, error: "missing_prompt" });
  }

  const imageUrls = imageUrlsRaw
    .map(normalizeUrl)
    .filter(Boolean)
    .slice(0, MAX_IMAGES);

  const fallbackImageUrl = normalizeUrl(imageUrlRaw);
  if (!imageUrls.length && fallbackImageUrl) {
    imageUrls.push(fallbackImageUrl);
  }

  const runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

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

  // Choose Grok Video model depending on presence of images
  const model = imageUrls.length
    ? "grok-imagine/image-to-video"
    : "grok-imagine/text-to-video";

  // Build KIE payload according to Grok Imagine docs
  const payload = {
    model,
    input: imageUrls.length ? {
      image_urls: imageUrls,
      prompt,
      mode: "normal",
      duration: String(duration),
      resolution: "720p",
      aspect_ratio: aspectRatio
    } : {
      prompt,
      aspect_ratio: aspectRatio,
      mode: "normal",
      duration: String(duration),
      resolution: "720p"
    },
    callBackUrl: callbackUrl,
    meta: { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId },
    metadata: { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId }
  };

  try {
    const resp = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KIE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok:false,
        submitted: false,
        error: (data && (data.error || data.message)) || "kie_create_failed",
        data
      });
    }

    const taskId = extractTaskId(data);
    if (!taskId) {
      return jsonResponse(502, {
        ok:false,
        submitted:false,
        error:"missing_task_id",
        data
      });
    }

    // Log into telegram_generations (non-blocking)
    await writeTelegramGeneration({ telegramId, cost, prompt });

    return jsonResponse(201, {
      ok:true,
      submitted:true,
      run_id: runId,
      taskId,
      loading_message_id: loadingMessageId,
      new_credits: newCredits
    });
  } catch (e) {
    return jsonResponse(500, {
      ok:false,
      submitted:false,
      error: e && e.message ? e.message : "server_error"
    });
  }
};

function normalizeUrl(u){
  try {
    const url = new URL(String(u || ""));
    return url.href;
  } catch {
    return "";
  }
}
