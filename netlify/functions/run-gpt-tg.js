// netlify/functions/run-gpt-tg.js
// Creates a KIE GPT-Image task for Telegram Mini App.
// Credits are handled on the Telegram side; this creates the KIE task
// and uses the existing Make.com callback URL.

const KIE_BASE = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");
const KIE_API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL  = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// KEEP: existing Make.com webhook callback (DO NOT CHANGE)
const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";
const LOADING_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1";

function json(statusCode, body){
  return {
    statusCode,
    headers:{
      "Content-Type":"application/json"
    },
    body: JSON.stringify(body)
  };
}

function normalizeLeng(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "ru" ? "ru" : "en";
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === "ru"
    ? "⏳ Ваша генерация принята.\n\nПожалуйста, подождите — это может занять 1–5 минут.\n\nПока ваш запрос обрабатывается, вы можете создавать другие материалы."
    : "⏳ Your generation has been accepted.\n\nPlease wait — it may take 1–5 minutes.\n\nWhile this is being processed, you can generate other things as well.";
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

// Insert the first row. n8n updates this same row later by run_id.
async function writeTelegramGeneration({ telegramId, cost, prompt, runId, taskId }){
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try{
    const url = SUPABASE_URL + "/rest/v1/telegram_generations";
    const resp = await fetch(url, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "apikey": SERVICE_KEY,
        "Authorization":"Bearer " + SERVICE_KEY,
        "Prefer":"return=minimal"
      },
      body: JSON.stringify([{
        telegram_id: telegramId,
        model: "GPT-Image-1",
        credits: cost,
        prompt,
        run_id: runId,
        task_id: taskId || null,
        status: "submitted",
        kind: "image",
        result_url: null
      }])
    });
    if (!resp.ok){
      const t = await resp.text().catch(()=> "");
      console.error("telegram_generations insert failed", resp.status, t);
    }
  }catch(e){
    console.error("telegram_generations insert error", e && e.message ? e.message : e);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST"){
    return json(405, { ok:false, submitted:false, error:"method_not_allowed" });
  }

  if (!KIE_API_KEY){
    console.error("Missing KIE_API_KEY");
    return json(500, { ok:false, submitted:false, error:"missing_api_keys" });
  }

  let body;
  try{
    body = JSON.parse(event.body || "{}");
  }catch(e){
    return json(400, { ok:false, submitted:false, error:"bad_json", details:String(e && e.message || e) });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString().trim();
  const aspect_ratio = (body.aspect_ratio ? String(body.aspect_ratio) : "1:1").trim();

  if (!telegramId){
    return json(400, { ok:false, submitted:false, error:"missing_telegram_id" });
  }
  if (!prompt){
    return json(400, { ok:false, submitted:false, error:"missing_prompt" });
  }

  const image_url  = body.image_url ? String(body.image_url).trim() : null;
  const image_urls = Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean) : null;
  const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean) : null;

  // Choose images precedence same as website function
  let chosenImages = null;
  if (urls && urls.length) {
    chosenImages = urls.slice(0, 8);
  } else if (image_urls && image_urls.length){
    chosenImages = image_urls.slice(0, 8);
  } else if (image_url){
    chosenImages = [image_url];
  }

  const creditsBefore = Number(body.credits_before || 0);
  const cost          = 1.5;
  const newCredits    = Math.max(0, Math.round((creditsBefore - cost) * 100) / 100);

  const query   = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || "";
  let mode = (body.mode || body.modul || query.mode || query.modul || "").toString();
  let leng = (body.leng || body.lang || query.leng || query.lang || "").toString();

  if (!mode && referer){
    try{
      const u = new URL(referer);
      mode = (u.searchParams.get("mode") || u.searchParams.get("modul") || mode || "").toString();
    }catch{}
  }
  if (!leng && referer){
    try{
      const u2 = new URL(referer);
      leng = (u2.searchParams.get("leng") || u2.searchParams.get("lang") || leng || "").toString();
    }catch{}
  }

  leng = normalizeLeng(leng);

  const run_id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,10);

  const loadingMessageId = await sendLoadingMessage({
    telegramId,
    runId: run_id,
    leng,
    mode,
    cost,
    creditsBefore,
    newCredits
  });

  // KEEP: webhook goes directly to Make.com, carrying all needed info
  const callbackUrl =
    MAKE_HOOK +
    "?telegram_id=" + encodeURIComponent(telegramId) +
    "&run_id=" + encodeURIComponent(run_id) +
    "&new_credits=" + encodeURIComponent(newCredits) +
    "&credits_before=" + encodeURIComponent(creditsBefore) +
    "&cost=" + encodeURIComponent(cost) +
    "&mode=" + encodeURIComponent(mode) +
    "&leng=" + encodeURIComponent(leng) +
    "&loading_message_id=" + encodeURIComponent(loadingMessageId || "");

  // KIE createTask endpoint
  const endpoint = `${KIE_BASE}/api/v1/jobs/createTask`;

  // Choose model based on presence of input images
  const model = (chosenImages && chosenImages.length)
    ? "gpt-image/1.5-image-to-image"
    : "gpt-image/1.5-text-to-image";

  // KIE input
  const input = {
    prompt,
    aspect_ratio,
    quality: "high"
  };

  if (chosenImages && chosenImages.length){
    input.input_urls = chosenImages;
  }

  const payload = {
    model,
    input,
    callBackUrl: callbackUrl,
    meta: {
      telegram_id: telegramId,
      run_id,
      credits_before: creditsBefore,
      new_credits: newCredits,
      cost,
      mode,
      leng,
      loading_message_id: loadingMessageId
    }
  };

  try{
    const res = await fetch(endpoint, {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${KIE_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text().catch(()=> "");
    let data = null;
    try{ data = JSON.parse(text); }catch{ data = { raw:text }; }

    if (!res.ok){
      return json(res.status, { ok:false, submitted:false, error:"kie_create_failed", details:data });
    }

    // Best-effort task id extraction (KIE responses vary by interface)
    const task_id = (data && (data.taskId || data.task_id || data.id || (data.data && (data.data.taskId || data.data.id)))) || null;

    await writeTelegramGeneration({ telegramId, cost, prompt, runId: run_id, taskId: task_id });

    return json(201, { ok:true, submitted:true, task_id, taskId: task_id, run_id, loading_message_id: loadingMessageId, new_credits:newCredits, cost });
  }catch(e){
    return json(500, { ok:false, submitted:false, error:"server_error", details:String(e && e.message || e) });
  }
};
