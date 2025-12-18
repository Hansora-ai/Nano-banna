// netlify/functions/run-midimage-tg.js
// Create a MidJourney text/image-to-image job for Telegram Mini App.
// Credits are handled on the Telegram side; this just calls KIE and forwards to Make.com.

const KIE_URL = "https://api.kie.ai/api/v1/mj/generate";
const API_KEY = process.env.KIE_API_KEY;

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL  = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://hansoraai.app.n8n.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const VERSION_TAG  = "midimage_tg_v1";

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function normalizeAspect(v) {
  if (!v) return "2:3";
  const s = String(v).trim().toLowerCase();
  const allowed = new Set(["2:3","3:2","1:1","3:4","4:3","9:16","16:9","5:6","6:5","4:5","5:4","7:4","4:7"]);
  if (allowed.has(s)) return s;
  const coerced = s.replace(/(\d)[_\-:](\d)/g, "$1:$2");
  return allowed.has(coerced) ? coerced : "2:3";
}

function mapSizeToAR(s){
  switch(String(s||'').toLowerCase()){
    case 'square': return '1:1';
    case 'portrait_3_4': return '3:4';
    case 'portrait_9_16': return '9:16';
    case 'landscape_4_3': return '4:3';
    case 'landscape_16_9': return '16:9';
    case 'auto': default: return '2:3'; // default per your note
  }
}

// Optional logging into telegram_generations
async function writeTelegramGeneration({ telegramId, cost, prompt }) {
  if (!SUPABASE_URL || !SERVICE_KEY || !TG_TABLE_URL) {
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
        model: "MidJourney Image",
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok:false, submitted:false, error:"method_not_allowed" });
  }

  if (!API_KEY) {
    console.warn("[run-midimage-tg] Missing KIE_API_KEY env!");
    return jsonResponse(500, { ok:false, submitted:false, error:"missing_kie_api_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, submitted:false, error:"bad_json", details:String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt    = (body.prompt || "").toString();
  const image_url = (body.image_url || "").toString().trim();
  const size      = body.size || body.aspectRatio || "auto";

  if (!telegramId) {
    return jsonResponse(400, { ok:false, submitted:false, error:"missing_telegram_id" });
  }
  if (!prompt) {
    return jsonResponse(400, { ok:false, submitted:false, error:"missing_prompt" });
  }

  const aspect = normalizeAspect(mapSizeToAR(size)); // default 2:3

  const speed       = "fast"; // per your existing midimage
  const version     = body.version ?? 7;
  const stylization = body.stylization ?? 100;
  const weirdness   = body.weirdness ?? 0;
  const watermark   = body.watermark ?? "";
  const paramJson   = body.paramJson || JSON.stringify({ numberOfImages: 1 });

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits    = Number(body.new_credits || 0);
  const cost          = Number(body.cost || 1) || 1;

  const query   = event.queryStringParameters || {};
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

  const run_id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const callbackUrl =
    MAKE_HOOK +
    "?telegram_id=" + encodeURIComponent(telegramId) +
    "&run_id=" + encodeURIComponent(run_id) +
    "&new_credits=" + encodeURIComponent(newCredits) +
    "&credits_before=" + encodeURIComponent(creditsBefore) +
    "&cost=" + encodeURIComponent(cost) +
    "&mode=" + encodeURIComponent(mode) +
    "&leng=" + encodeURIComponent(leng);

  const taskType = image_url ? "mj_img2img" : "mj_txt2img";

  const payload = {
    taskType,
    prompt,
    speed,
    fileUrl: image_url || "",
    aspectRatio: aspect,
    version,
    stylization,
    weirdness,
    waterMark: watermark,
    paramJson,
    callBackUrl: callbackUrl,
    meta: { telegram_id: telegramId, run_id, provider: "MidJourney", version: VERSION_TAG }
  };

  // aliases for safety (same style as other KIE calls)
  payload.callbackUrl = callbackUrl;
  payload.webhook_url = callbackUrl;
  payload.webhookUrl  = callbackUrl;
  payload.notify_url  = callbackUrl;
  payload.metadata    = { ...(payload.metadata||{}), telegram_id: telegramId, run_id, callbackUrl, version: VERSION_TAG };

  try {
    const create = await fetch(KIE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await create.text();
    let js; try { js = JSON.parse(text); } catch { js = { raw: text }; }

    const taskId = js.taskId || js.id || js.data?.taskId || js.data?.id || null;

    // Optional telegram_generations log (non-blocking)
    await writeTelegramGeneration({ telegramId, cost, prompt });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id,
      taskId,
      new_credits: newCredits,
      version: VERSION_TAG
    });
  } catch (e) {
    return jsonResponse(500, {
      ok:false,
      submitted:false,
      error: e && e.message ? e.message : "server_error"
    });
  }
};
