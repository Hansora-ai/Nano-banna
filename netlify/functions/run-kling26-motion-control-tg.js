// netlify/functions/run-kling26-motion-control-tg.js
// Submit a Kling Motion Control task via KIE for Telegram Mini App.
// UI page label is "Kling 2.5 Motion Control", but the KIE model must be "kling-2.6/motion-control".
// Credits are calculated client-side as 1 credit per second (ceil(video_duration_seconds)).

const KIE_BASE = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");
const KIE_KEY  = process.env.KIE_API_KEY || "";

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
        model: "Kling 2.5 Motion Control",
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

function extractTaskId(data){
  if (!data || typeof data !== "object") return "";
  const cands = [
    data?.data?.taskId, data?.taskId, data?.result?.taskId,
    data?.data?.task_id, data?.task_id, data?.result?.task_id,
    data?.id
  ].map(v => (v==null?"":String(v))).filter(s => s && s.length > 3);
  if (cands.length) return cands[0];

  const seen = new Set();
  const scan = (x)=>{
    if (!x || typeof x !== "object" || seen.has(x)) return "";
    seen.add(x);
    for (const [k,v] of Object.entries(x)){
      if (/^(task[_-]?id|request[_-]?id|id)$/i.test(k) && (typeof v === "string" || typeof v === "number")) {
        const s = String(v);
        if (s.length > 3) return s;
      }
      const inner = scan(v);
      if (inner) return inner;
    }
    return "";
  };
  return scan(data) || "";
}

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
    return jsonResponse(405, { ok:false, error:"method_not_allowed" });
  }

  if (!KIE_KEY) {
    return jsonResponse(500, { ok:false, error:"missing_kie_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, error:"bad_json", details:String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString();

  const imageRaw = (body.imageUrl || body.image_url || "").toString();
  const videoRaw = (body.videoUrl || body.video_url || "").toString();

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);

  // Cost is provided by client (1 credit per second). We validate it as a positive integer.
  const cost = Math.max(1, Math.floor(Number(body.cost || body.credits || 0) || 0));

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

  if (!telegramId) return jsonResponse(400, { ok:false, error:"missing_telegram_id" });
  if (!prompt) return jsonResponse(400, { ok:false, error:"missing_prompt" });

  const imageUrl = normalizeUrl(imageRaw);
  const videoUrl = normalizeUrl(videoRaw);
  if (!imageUrl) return jsonResponse(400, { ok:false, error:"missing_image" });
  if (!videoUrl) return jsonResponse(400, { ok:false, error:"missing_video" });
  if (!Number.isFinite(cost) || cost < 1) return jsonResponse(400, { ok:false, error:"bad_cost" });

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

  // KIE payload (matches the playground example shape in the screenshot)
  const payload = {
    model: "kling-2.6/motion-control",
    input: {
      prompt,
      input_urls: [imageUrl],
      video_urls: [videoUrl],
      character_orientation: "video",
      mode: "1080p"
    },
    callBackUrl: callbackUrl
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
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok:false,
        submitted:false,
        error:(data && (data.error || data.message)) || "kie_create_failed",
        data
      });
    }

    const taskId = extractTaskId(data);
    if (!taskId) {
      return jsonResponse(502, { ok:false, submitted:false, error:"missing_task_id", data });
    }

    await writeTelegramGeneration({ telegramId, cost, prompt });

    return jsonResponse(201, {
      ok:true,
      submitted:true,
      run_id: runId,
      taskId,
      new_credits: newCredits
    });
  } catch (e) {
    return jsonResponse(500, { ok:false, submitted:false, error:(e && e.message) ? e.message : "server_error" });
  }
};
