// netlify/functions/run-nano-banana-pro-tg.js
// Submit a Nano Banana Pro text/image-to-image job for Telegram Mini App.
// Credits are handled on the Telegram side; we forward to Make.com
// and optionally log into Supabase telegram_generations.

const CREATE_URL = process.env.KIE_CREATE_URL || "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL  = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com scenario callback – same as other Telegram flows
const MAKE_HOOK = "https://hansoraai.app.n8n.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// normalizeImageSize & normalizeResolution copied from run-nano-banana-pro.js (website)
function normalizeImageSize(v) {
  if (!v) return "auto";
  const s = String(v).trim().toLowerCase();

  // Pass through if already valid ratio or auto
  const direct = new Set([
    "auto",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9"
  ]);
  if (direct.has(s)) return s;

  // Map named tokens to ratio strings (KIE-accepted)
  if (s === "square") return "1:1";
  if (s === "portrait_3_4") return "3:4";
  if (s === "portrait_9_16") return "9:16";
  if (s === "landscape_4_3") return "4:3";
  if (s === "landscape_16_9") return "16:9";

  // Coerce variants like "16_9", "16-9", "2-3" → "2:3"
  const coerced = s.replace(/(\d)[_\-:](\d)/g, "$1:$2");
  if (direct.has(coerced)) return coerced;

  return "auto";
}

function normalizeResolution(v) {
  if (!v) return "1K";
  const s = String(v).trim().toLowerCase();
  if (s === "2k" || s === "2048") return "2K";
  if (s === "4k") return "4K";
  return "1K";
}

// Insert a row into telegram_generations (non-blocking)
async function writeTelegramGeneration({ telegramId, cost, prompt }) {
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
        model: "Nano Banana Pro",
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

exports.handler = async function(event){
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok:false, submitted:false, error:"method_not_allowed" });
  }

  if (!API_KEY) {
    return jsonResponse(500, { ok:false, submitted:false, error:"missing_kie_api_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, submitted:false, error:"bad_json", details:String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString();

  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const cleanUrls = rawUrls
    .map(u => String(u || "").trim())
    .filter(u => !!u);

  if (!telegramId) {
    return jsonResponse(400, { ok:false, submitted:false, error:"missing_telegram_id" });
  }

  // For Nano Banana Pro, images are optional. We allow prompt-only requests.
  if (!prompt) {
    return jsonResponse(400, { ok:false, submitted:false, error:"missing_prompt" });
  }

  const sizeRaw = body.size || body.image_size || body.imageSize || "auto";
  const image_size = normalizeImageSize(sizeRaw);
  const resolution = normalizeResolution(body.resolution);

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);
  const cost = Number(body.cost || 2.5) || 2.5; // Telegram flow uses fixed cost 2.5

  // mode / leng similar to other tg functions
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

  // Build KIE payload mirroring website's run-nano-banana-pro.js
  const image_input = cleanUrls.map(u => encodeURI(String(u)));
  const format = (body.format || "png").toLowerCase();

  const input = {
    prompt,
    aspect_ratio: image_size,
    resolution,
    output_format: format
  };
  if (image_input.length) {
    input.image_input = image_input;
  }

  const payload = {
    model: "nano-banana-pro",
    input,
    webhook_url: callbackUrl,
    webhookUrl:  callbackUrl,
    callbackUrl: callbackUrl,
    callBackUrl: callbackUrl,
    notify_url:  callbackUrl,
    meta:      { telegram_id: telegramId, run_id: runId, cost },
    metadata:  { telegram_id: telegramId, run_id: runId, cost }
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

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok:false,
        submitted:false,
        error:(data && (data.error || data.message)) || "nano_banana_pro_error",
        data
      });
    }

    const taskId =
      data.taskId || data.id || data.data?.taskId || data.data?.id || null;

    // Non-blocking log to telegram_generations
    await writeTelegramGeneration({ telegramId, cost, prompt });

    return jsonResponse(201, {
      ok:true,
      submitted:true,
      run_id: runId,
      taskId,
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
