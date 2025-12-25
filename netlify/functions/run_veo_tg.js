// netlify/functions/run-veo31-tg.js
// Submit a Veo 3.1 job via KIE for Telegram Mini App.
// Credits and balance are handled on the Telegram side; we forward them to Make.com
// and also log into Supabase telegram_generations with telegram_id, model, credits, prompt.

const KIE_URL = "https://api.kie.ai/api/v1/veo/generate";
const KIE_KEY = process.env.KIE_API_KEY || "";

// Supabase (service role, same as other Telegram flows)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com scenario callback – same as other Telegram video flows
const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// Insert a row into telegram_generations for this Telegram Veo 3.1 run.
async function writeTelegramGeneration({ telegramId, cost, prompt, provider }) {
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
        model: provider,
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

function normalizeModel(m){
  const raw = String(m||"");
  const s = raw.toLowerCase().replace(/\s+/g,"").replace(/-/g,"");
  if (s === "veo3" || s === "veo3standard") return "veo3";
  if (s === "veo3fast" || s === "veo3_fast") return "veo3_fast";
  // default to fast
  return "veo3_fast";
}
function normalizeAspect(a){
  a = String(a || "").trim();
  return /^(16:9|9:16)$/.test(a) ? a : "16:9";
}
function normalizeUrl(u){
  try {
    const url = new URL(String(u || ""));
    return url.href;
  } catch {
    return "";
  }
}

// Searches the JSON object for common taskId / requestId locations.
function extractTaskId(data){
  if (!data || typeof data !== "object") return "";
  if (data?.data?.taskId)    return String(data.data.taskId);
  if (data?.taskId)          return String(data.taskId);
  if (data?.result?.taskId)  return String(data.result.taskId);
  if (data?.data?.task_id)   return String(data.data.task_id);
  if (data?.task_id)         return String(data.task_id);
  if (data?.result?.task_id) return String(data.result.task_id);
  if (data?.data?.requestId)    return String(data.data.requestId);
  if (data?.requestId)          return String(data.requestId);
  if (data?.result?.requestId)  return String(data.result.requestId);
  if (data?.data?.request_id)   return String(data.data.request_id);
  if (data?.request_id)         return String(data.request_id);
  if (data?.result?.request_id) return String(data.result.request_id);
  if (data?.id && String(data.id).length > 8) return String(data.id);
  const seen = new Set();
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
  const aspectRatio = normalizeAspect(body.aspect_ratio || body.aspectRatio || "16:9");
  const model = normalizeModel(body.model || "veo3_fast");

  const firstFrameUrl = normalizeUrl(body.firstFrameUrl || body.first_frame_url || "");
  const lastFrameUrl  = normalizeUrl(body.lastFrameUrl  || body.last_frame_url  || "");

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);

  // Cost: 8⚡ for veo3_fast, 20⚡ for veo3
  const cost = model === "veo3" ? 20 : 8;

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
    return jsonResponse(400, { ok:false, error: "missing_prompt" });
  }
  if (lastFrameUrl && !firstFrameUrl) {
    return jsonResponse(400, { ok:false, error: "missing_start_frame" });
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

  // Build KIE payload (based on run-veo31.js spec)
  const kiePayload = {
    prompt,
    model,
    aspectRatio,
    callBackUrl: callbackUrl
  };

  if (firstFrameUrl && lastFrameUrl){
    kiePayload.generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
    kiePayload.firstFrameUrl = firstFrameUrl;
    kiePayload.lastFrameUrl  = lastFrameUrl;
    kiePayload.imageUrls = [firstFrameUrl, lastFrameUrl];
  } else {
    kiePayload.generationType = "TEXT_2_VIDEO";
    if (firstFrameUrl){
      kiePayload.imageUrls = [firstFrameUrl];
    }
  }

  try {
    const resp = await fetch(KIE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KIE_KEY}`,
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
        submitted: false,
        error: (data && (data.error || data.message)) || "kie_generate_failed",
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
    const providerLabel = model === "veo3" ? "Veo 3.1 Video" : "Veo 3.1 Fast Video";
    await writeTelegramGeneration({ telegramId, cost, prompt, provider: providerLabel });

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
