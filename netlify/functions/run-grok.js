// netlify/functions/run-grok.js
// Submit a Grok image job for Telegram Mini App.
// Uses telegram_users.credits on the page side.
// Sends documented Grok text-to-image or image-to-image payloads to KIE.

const CREATE_URL = process.env.KIE_CREATE_URL || "https://api.kie.ai/api/v1/jobs/createTask";
const API_KEY = process.env.KIE_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : "";

const MAKE_HOOK = "https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

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
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        Prefer: "return=minimal"
      },
      body: JSON.stringify([{
        telegram_id: telegramId,
        model: "Grok",
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

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, submitted: false, error: "method_not_allowed" });
  }

  if (!API_KEY) {
    return jsonResponse(500, { ok: false, submitted: false, error: "missing_kie_api_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, {
      ok: false,
      submitted: false,
      error: "bad_json",
      details: String((e && e.message) || e)
    });
  }

  const telegramId = (body.telegram_id || "").toString();
  const prompt = (body.prompt || "").toString().trim();

  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const cleanUrls = rawUrls
    .map((u) => String(u || "").trim())
    .filter((u) => !!u);

  if (!telegramId) {
    return jsonResponse(400, { ok: false, submitted: false, error: "missing_telegram_id" });
  }
  if (!prompt) {
    return jsonResponse(400, { ok: false, submitted: false, error: "prompt_required" });
  }
  if (cleanUrls.length > 4) {
    return jsonResponse(400, { ok: false, submitted: false, error: "too_many_images" });
  }

  const creditsBefore = Number(body.credits_before || 0);
  const newCredits = Number(body.new_credits || 0);
  const cost = Number(body.cost || 0.5) || 0.5;

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

  const isImageEdit = cleanUrls.length > 0;

  const payload = {
    model: isImageEdit ? "grok-imagine/image-to-image" : "grok-imagine/text-to-image",
    input: isImageEdit
      ? {
          prompt,
          image_urls: cleanUrls.map((u) => encodeURI(String(u)))
        }
      : {
          prompt,
          aspect_ratio: (body.aspect_ratio || "3:2").toString(),
          enable_pro: true
        },
    webhook_url: callbackUrl,
    webhookUrl: callbackUrl,
    callbackUrl: callbackUrl,
    callBackUrl: callbackUrl,
    notify_url: callbackUrl,
    meta: { telegram_id: telegramId, run_id: runId, cost },
    metadata: { telegram_id: telegramId, run_id: runId, cost }
  };

  try {
    const resp = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok: false,
        submitted: false,
        error: (data && (data.error || data.message)) || "grok_image_error",
        data
      });
    }

    const taskId = data.taskId || data.id || data.data?.taskId || data.data?.id || null;

    await writeTelegramGeneration({ telegramId, cost, prompt });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId,
      new_credits: newCredits,
      mode_used: isImageEdit ? "image_to_image" : "text_to_image"
    });
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      submitted: false,
      error: e && e.message ? e.message : "server_error"
    });
  }
};
