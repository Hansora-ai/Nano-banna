// netlify/functions/run-gpt-image-tg.js
// Creates a Replicate GPT-Image-1 prediction for Telegram Mini App.
// Credits are handled on the Telegram side; this just calls Replicate
// and forwards the completed result to Make.com.

const BASE = (process.env.REPLICATE_BASE_URL || 'https://api.replicate.com/v1').replace(/\/+$/,'');
const TOKEN = process.env.REPLICATE_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SUPABASE_URL  = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const MAKE_HOOK = "https://hook.eu2.make.com/l25fsaf15od9oywtqtm45zb0i7r7ff2o";

function json(statusCode, body){
  return {
    statusCode,
    headers:{
      "Content-Type":"application/json"
    },
    body: JSON.stringify(body)
  };
}

// Optional: insert into telegram_generations
async function writeTelegramGeneration({ telegramId, cost, prompt }){
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
        prompt
      }])
    });
    if (!resp.ok){
      const t = await resp.text().catch(()=>"");
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

  if (!TOKEN || !OPENAI_API_KEY){
    console.error("Missing REPLICATE_API_KEY or OPENAI_API_KEY");
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

  // Choose images precedence same as website function
  let chosenImages = null;
  if (image_urls && image_urls.length){
    chosenImages = image_urls;
  } else if (image_url){
    chosenImages = [image_url];
  }

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits    = Number(body.new_credits || 0);
  const cost          = Number(body.cost || 4) || 4;

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

  const run_id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,10);

  // Webhook goes directly to Make.com, carrying all needed info
  const callbackUrl =
    MAKE_HOOK +
    "?telegram_id=" + encodeURIComponent(telegramId) +
    "&run_id=" + encodeURIComponent(run_id) +
    "&new_credits=" + encodeURIComponent(newCredits) +
    "&credits_before=" + encodeURIComponent(creditsBefore) +
    "&cost=" + encodeURIComponent(cost) +
    "&mode=" + encodeURIComponent(mode) +
    "&leng=" + encodeURIComponent(leng);

  const endpoint = BASE + "/predictions";

  // Replicate input
  const input = { openai_api_key: OPENAI_API_KEY, prompt, aspect_ratio, output_format: "png" };

  if (chosenImages && chosenImages.length){
    input.image = chosenImages[0];
    input.images = chosenImages;
    input.input_image = chosenImages[0];
    input.input_images = chosenImages;
    input.reference_images = chosenImages;
  }

  const payload = {
    input,
    webhook: callbackUrl,
    webhook_events_filter: ["completed"]
  };

  try{
    const res = await fetch(endpoint, {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text().catch(()=>"");
    let data = null;
    try{ data = JSON.parse(text); }catch{ data = { raw:text }; }

    if (!res.ok){
      return json(res.status, { ok:false, submitted:false, error:"replicate_create_failed", details:data });
    }

    const id = data && data.id;
    if (!id){
      return json(502, { ok:false, submitted:false, error:"missing_prediction_id", details:data });
    }

    // Non-blocking log
    await writeTelegramGeneration({ telegramId, cost, prompt });

    return json(201, { ok:true, submitted:true, id, run_id, new_credits:newCredits });
  }catch(e){
    return json(500, { ok:false, submitted:false, error:"server_error", details:String(e && e.message || e) });
  }
};
