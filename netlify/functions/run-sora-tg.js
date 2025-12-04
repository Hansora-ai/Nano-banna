// netlify/functions/run-sora-tg.js
// Submit a Sora 2 text/image → video task via KIE for Telegram Mini App.
// Credits and balance are handled on the Telegram side; we forward them to Make.com
// and also log into Supabase telegram_generations with telegram_id, model, credits, prompt.

const KIE_URL = "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

// Supabase (service role for telegram_generations insert)
const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL  = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com scenario callback – same as MJ / Runway / Kling video flow
const MAKE_HOOK = "https://hook.eu2.make.com/l25fsaf15od9oywtqtm45zb0i7r7ff2o";

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// Insert a row into telegram_generations for this Telegram Sora run.
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
        model: "Sora 2 Video",
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

// Flexible task id extractor (same idea as run-sora2.js)
function extractTaskId(data){
  if (!data || typeof data !== "object") return "";
  if (data?.data?.taskId) return String(data.data.taskId);
  if (data?.taskId)       return String(data.taskId);
  if (data?.id)           return String(data.id);
  // deep scan
  const seen = new WeakSet();
  function scan(x){
    if (!x || typeof x !== "object" || seen.has(x)) return "";
    seen.add(x);
    for (const [k,v] of Object.entries(x)){
      if (/^(task[_-]?id|request[_-]?id)$/i.test(k) && (typeof v === "string" || typeof v === "number")) {
        const s = String(v); if (s.length > 3) return s;
      }
      const inner = scan(v);
      if (inner) return inner;
    }
    return "";
  }
  return scan(data) || "";
}

// Map "16:9" / "9:16" to Sora aspect tokens (same logic as run-sora2.js)
function mapAspect(v){
  const s = String(v || "").trim();
  if (s === "16:9" || /^landscape$/i.test(s)) return "landscape";
  if (s === "9:16"  || /^portrait$/i.test(s))  return "portrait";
  return s || "landscape";
}

// Normalize a single image URL; returns "" if invalid
function normalizeUrl(u){
  try {
    const url = new URL(String(u || ""));
    return url.href;
  } catch {
    return "";
  }
}

exports.handler = async function(event){
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok:false, error: "method_not_allowed" });
  }

  if (!API_KEY) {
    return jsonResponse(500, { ok:false, error: "missing_kie_api_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, error: "bad_json", details: String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt     = (body.prompt || "").toString();
  const imageUrlRaw = (body.imageUrl || body.image_url || "").toString();

  // Duration: 10s or 15s (seconds). Default 10.
  const durationSeconds = (body && (body.duration === 15 || String(body.duration) === "15")) ? 15 : 10;

  // Cost: 3 credits for 10s, 4 credits for 15s
  const cost = durationSeconds === 15 ? 4 : 3;

  // Aspect ratio from UI: "16:9" or "9:16"; map to landscape/portrait
  const aspectRaw   = (body.aspectRatio || body.aspect_ratio || "16:9").toString();
  const aspect_ratio = mapAspect(aspectRaw);

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits    = Number(body.new_credits || 0);

  // mode / leng from body, query, referer
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
  if (!prompt && !imageUrlRaw) {
    // For Sora mini app: allow text-only OR image+prompt, but require at least one.
    return jsonResponse(400, { ok:false, error: "missing_prompt_or_image" });
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

  // Prepare KIE payload based on run-sora2.js behavior
  const image_url = normalizeUrl(imageUrlRaw);

  // We use standard tier here (non-pro). You can adjust later if you add a tier switch.
  const tier = String(body.tier || body.model_tier || "").toLowerCase();
  const hasImage = !!image_url;
  const model = hasImage
    ? (tier === "pro" ? "sora-2-pro-image-to-video" : "sora-2-image-to-video")
    : (tier === "pro" ? "sora-2-pro-text-to-video"  : "sora-2-text-to-video");

  const n_frames = durationSeconds === 15 ? 15 : 10;

  const kiePayload = {
    model,
    callBackUrl: callbackUrl,
    input: {
      prompt,
      aspect_ratio,
      // Sora docs: size (standard|high); n_frames ('10'|'15')
      n_frames: String(n_frames),
      size: body.size || "standard"
    }
  };

  if (hasImage) {
    // Sora web uses image_urls array; we follow that.
    kiePayload.input.image_urls = [image_url];
  }

  // Optional passthroughs similar to run-sora2.js
  if (body.quality && !kiePayload.input.size) {
    kiePayload.input.size = /^(hd|high)$/i.test(String(body.quality)) ? "high" : "standard";
  }
  if (body.seed !== undefined) {
    kiePayload.input.seed = body.seed;
  }

  try {
    const resp = await fetch(KIE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(kiePayload)
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
        submitted:false,
        error: (data && (data.error || data.message)) || "kie_sora_error",
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
