// netlify/functions/run-kling-3.js
// Submit a Kling 3.0 text/image → video task via KIE for Telegram Mini App.
// This endpoint is called by kling30_tg_fixed.html at "/.netlify/functions/run-kling-3".
//
// Notes:
// - NEVER expose KIE API key in frontend. Keep it in Netlify env vars.
// - We validate multi-shot total duration <= 15s (and each shot 3–12s) to match the UI.

const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY  = process.env.KIE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

// Make.com / n8n callback for Telegram delivery + credit reconciliation
const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

// UI rate table (must match kling30_tg_fixed.html)
const RATE = {
  std: { nosound: 2.0, sound: 2.5 },
  pro: { nosound: 2.5, sound: 3.5 }
};

function jsonResponse(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function clampInt(n, lo, hi){
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function normalizeUrl(u){
  try {
    const url = new URL(String(u || ""));
    return url.href;
  } catch {
    return "";
  }
}

function getRate(mode, sound){
  const m = (mode === "pro" || mode === "std") ? mode : "std";
  const key = sound ? "sound" : "nosound";
  return (RATE[m] && RATE[m][key]) ? RATE[m][key] : 2.0;
}

function calcExpectedCost(totalSeconds, mode, sound){
  const rate = getRate(mode, sound);
  const raw = totalSeconds * rate;
  // UI rounds to nearest 0.5
  return Math.round(raw * 2) / 2;
}

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
        model: "Kling 3.0 Video",
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
    return jsonResponse(405, { ok:false, submitted:false, error: "method_not_allowed" });
  }

  if (!KIE_KEY) {
    return jsonResponse(500, { ok:false, submitted:false, error: "missing_kie_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { ok:false, submitted:false, error: "bad_json", details: String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString().trim();
  const prompt = (body.prompt || "").toString().trim();

  const startImageUrl = normalizeUrl(body.startImageUrl || body.start_image_url || body.imageUrl || body.image_url || "");
  const endImageUrl   = normalizeUrl(body.endImageUrl   || body.end_image_url   || body.lastFrameUrl || body.last_frame_url || "");

  const aspectRatio = (body.aspectRatio || body.aspect_ratio || "").toString().trim(); // optional if using image_urls per docs
  const klingMode = (body.kling_mode || body.klingMode || body.mode_quality || "std").toString().trim().toLowerCase();
  const sound = !!(body.sound);

  const multiShots = !!(body.multi_shots);
  const multiPrompt = Array.isArray(body.multi_prompt) ? body.multi_prompt : [];
  const klingElements = Array.isArray(body.kling_elements) ? body.kling_elements : [];

  const creditsBefore = Number(body.credits_before || 0);
  const costFromUI = Number(body.cost || 0);

  // mode / leng passthrough (Telegram UI)
  const query = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || "";
  let mode = (body.mode || body.modul || query.mode || query.modul || "").toString();
  let leng = (body.leng || body.lang || query.leng || query.lang || "").toString();
  if (!mode && referer) {
    try { mode = (new URL(referer).searchParams.get("mode") || new URL(referer).searchParams.get("modul") || mode || "").toString(); } catch (_) {}
  }
  if (!leng && referer) {
    try { leng = (new URL(referer).searchParams.get("leng") || new URL(referer).searchParams.get("lang") || leng || "").toString(); } catch (_) {}
  }

  if (!telegramId) return jsonResponse(400, { ok:false, submitted:false, error: "missing_telegram_id" });
  if (!prompt) return jsonResponse(400, { ok:false, submitted:false, error: "missing_prompt" });

  // Build durations
  let totalSeconds = 0;

  if (multiShots) {
    if (!startImageUrl) {
      return jsonResponse(400, { ok:false, submitted:false, error: "missing_start_image_for_multi_shots" });
    }
    if (endImageUrl) {
      // Docs: multi-shot supports only first frame image.
      return jsonResponse(400, { ok:false, submitted:false, error: "end_image_not_supported_in_multi_shots" });
    }
    if (!multiPrompt.length) {
      return jsonResponse(400, { ok:false, submitted:false, error: "missing_multi_prompt" });
    }

    // Validate each shot: 3–12 seconds (UI constraint) and sum <= 15.
    const normalizedShots = [];
    for (const item of multiPrompt) {
      const p = (item && item.prompt != null) ? String(item.prompt).trim() : "";
      const d = clampInt(item && item.duration, 3, 12);
      if (!p) return jsonResponse(400, { ok:false, submitted:false, error: "multi_prompt_item_missing_prompt" });
      normalizedShots.push({ prompt: p, duration: d });
      totalSeconds += d;
      if (totalSeconds > 15) {
        return jsonResponse(400, { ok:false, submitted:false, error: "multi_shots_total_exceeds_15s" });
      }
    }

    // Replace with normalized versions
    body._normalizedShots = normalizedShots;
  } else {
    // Single-shot: duration must be 3–15.
    // The HTML currently does not send duration explicitly; infer from cost if needed.
    const explicitDuration = body.duration != null ? clampInt(body.duration, 3, 15) : 0;
    if (explicitDuration) {
      totalSeconds = explicitDuration;
    } else {
      // Infer duration from UI cost and known rate (UI uses integer seconds).
      const rate = getRate(klingMode, sound);
      const inferred = Number.isFinite(costFromUI) && rate > 0 ? Math.round(costFromUI / rate) : 5;
      totalSeconds = clampInt(inferred, 3, 15);
    }
  }

  // Server-side cost verification (basic anti-tamper)
  const expectedCost = calcExpectedCost(totalSeconds, klingMode, sound);
  const cost = Number.isFinite(costFromUI) && costFromUI > 0 ? costFromUI : expectedCost;
  if (Number.isFinite(costFromUI) && costFromUI > 0) {
    // allow tiny float error
    if (Math.abs(costFromUI - expectedCost) > 0.001) {
      return jsonResponse(400, { ok:false, submitted:false, error: "cost_mismatch", expected_cost: expectedCost });
    }
  }

  const newCredits = Number.isFinite(creditsBefore) ? Math.max(0, creditsBefore - cost) : 0;

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

  // Build KIE input per Kling 3.0 docs
  // Docs show model as "kling-3.0/video" for createTask.
  const image_urls = [];
  if (startImageUrl) image_urls.push(startImageUrl);
  if (!multiShots && endImageUrl) image_urls.push(endImageUrl);

  const input = {
    prompt,
    sound,
    duration: String(totalSeconds),
    mode: (klingMode === "pro" || klingMode === "std") ? klingMode : "std",
    multi_shots: multiShots
  };

  // aspect_ratio is optional if image_urls provided, but keep if provided by UI
  if (aspectRatio) input.aspect_ratio = aspectRatio;

  if (image_urls.length) input.image_urls = image_urls;

  if (multiShots) {
    input.multi_prompt = body._normalizedShots;
    if (klingElements.length) input.kling_elements = klingElements;
  } else {
    if (klingElements.length) input.kling_elements = klingElements; // allow elements in single-shot too
  }

  const payload = {
    model: "kling-3.0/video",
    input,
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
        error: (data && (data.error || data.msg || data.message)) || "kie_create_failed",
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
    return jsonResponse(500, {
      ok:false,
      submitted:false,
      error: e && e.message ? e.message : "server_error"
    });
  }
};
