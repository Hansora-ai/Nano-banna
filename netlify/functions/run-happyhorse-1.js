// netlify/functions/run-happyhorse-1.js
// Submit a HappyHorse 1.0 video task via KIE for Telegram Mini App.

const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY = process.env.KIE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : '';

const MAKE_HOOK = 'https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354';
const LOADING_HOOK = 'https://n8n.srv1223021.hstgr.cloud/webhook/83b19830-f204-4e40-bef7-cfab15abf797';

const RATE = { '720p': 2.5, '1080p': 3.5 };
const MAX_REFERENCE_IMAGES = 6;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function normalizeLeng(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'ru' ? 'ru' : 'en';
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === 'ru'
    ? '⏳ Ваша генерация принята.\n\nПожалуйста, подождите — это может занять 5–10 минут в зависимости от видеомодели.\n\nПока ваш запрос обрабатывается, вы можете создавать другие материалы.'
    : '⏳ Your generation has been accepted.\n\nPlease wait — this can take 5–10 minutes depending on the video model.\n\nWhile this is being processed, you can generate other things as well.';
}

async function sendLoadingMessage({ telegramId, runId, leng, mode, cost, creditsBefore, newCredits }) {
  if (!LOADING_HOOK) return null;

  try {
    const resp = await fetch(LOADING_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
    try { data = JSON.parse(text || '{}'); } catch { data = { raw: text }; }

    if (!resp.ok) {
      console.error('loading message hook failed', resp.status, data);
      return null;
    }

    return data.message_id || data.messageId || data.result?.message_id || null;
  } catch (e) {
    console.error('loading message hook error', e && e.message ? e.message : e);
    return null;
  }
}

function normalizeUrl(u) {
  try {
    return new URL(String(u || '')).href;
  } catch {
    return '';
  }
}

function normalizeUrlList(arr) {
  return Array.isArray(arr) ? arr.map(normalizeUrl).filter(Boolean) : [];
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function extractTaskId(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = [data?.data?.taskId, data?.taskId, data?.result?.taskId, data?.data?.task_id, data?.task_id, data?.result?.task_id, data?.id]
    .map(v => (v == null ? '' : String(v)))
    .filter(Boolean);
  if (direct.length) return direct[0];

  const seen = new Set();
  const scan = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      if (/^(task[_-]?id|request[_-]?id|id)$/i.test(key) && (typeof inner === 'string' || typeof inner === 'number')) {
        const s = String(inner);
        if (s.length > 3) return s;
      }
      const nested = scan(inner);
      if (nested) return nested;
    }
    return '';
  };
  return scan(data) || '';
}

function calcExpectedCost(duration, resolution, isVideoEdit) {
  if (isVideoEdit) return RATE[resolution];
  const rate = RATE[resolution];
  if (!rate) return NaN;
  return duration * rate;
}

async function writeTelegramGeneration({ telegramId, cost, prompt, modelLabel }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TG_TABLE_URL) {
    console.error('telegram_generations insert skipped: missing Supabase env');
    return;
  }

  try {
    const resp = await fetch(TG_TABLE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify([{ telegram_id: telegramId, model: modelLabel, credits: cost, prompt }])
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('telegram_generations insert failed', resp.status, text);
    }
  } catch (e) {
    console.error('telegram_generations insert error', e && e.message ? e.message : e);
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, submitted: false, error: 'method_not_allowed' });
  }

  if (!KIE_KEY) {
    return jsonResponse(500, { ok: false, submitted: false, error: 'missing_kie_key' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'bad_json', details: String(e && e.message || e) });
  }

  const telegramId = String(body.telegram_id || '').trim();
  const prompt = String(body.prompt || '').trim();
  const imageUrls = normalizeUrlList(body.image_urls || body.imageUrls || body.reference_image_urls || body.referenceImageUrls);
  const videoUrl = normalizeUrl(body.video_url || body.videoUrl || '');
  const resolution = body.resolution === '1080p' ? '1080p' : '720p';
  const aspectRatio = String(body.aspect_ratio || body.aspectRatio || '16:9').trim();
  const duration = clampInt(body.duration, 3, 15);
  const creditsBefore = Number(body.credits_before || 0);
  const costFromUI = Number(body.cost || 0);

  const query = event.queryStringParameters || {};
  const referer = (event.headers && (event.headers.referer || event.headers.Referer)) || '';
  let mode = String(body.mode || body.modul || query.mode || query.modul || '');
  let leng = String(body.leng || body.lang || query.leng || query.lang || '');
  if (!mode && referer) {
    try { mode = String(new URL(referer).searchParams.get('mode') || new URL(referer).searchParams.get('modul') || ''); } catch (_) {}
  }
  if (!leng && referer) {
    try { leng = String(new URL(referer).searchParams.get('leng') || new URL(referer).searchParams.get('lang') || ''); } catch (_) {}
  }

  leng = normalizeLeng(leng);

  if (!telegramId) return jsonResponse(400, { ok: false, submitted: false, error: 'missing_telegram_id' });
  if (!prompt) return jsonResponse(400, { ok: false, submitted: false, error: 'missing_prompt' });
  if (imageUrls.length > MAX_REFERENCE_IMAGES) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_images' });

  const isVideoEdit = !!videoUrl;
  let model = 'happyhorse/text-to-video';
  let modelLabel = 'HappyHorse 1.0 Text to Video';
  const input = { prompt, resolution };

  if (isVideoEdit) {
    model = 'happyhorse/video-edit';
    modelLabel = 'HappyHorse 1.0 Video Edit';
    input.video_url = videoUrl;
    if (imageUrls.length) input.reference_image = imageUrls;
    input.audio_setting = 'auto';
  } else if (imageUrls.length === 1) {
    model = 'happyhorse/image-to-video';
    modelLabel = 'HappyHorse 1.0 Image to Video';
    input.image_urls = imageUrls;
    input.duration = duration;
  } else if (imageUrls.length > 1) {
    model = 'happyhorse/reference-to-video';
    modelLabel = 'HappyHorse 1.0 Reference to Video';
    input.reference_image = imageUrls;
    input.aspect_ratio = aspectRatio;
    input.duration = duration;
  } else {
    input.aspect_ratio = aspectRatio;
    input.duration = duration;
  }

  const expectedCost = calcExpectedCost(duration, resolution, isVideoEdit);
  if (!Number.isFinite(expectedCost)) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'invalid_cost_config' });
  }
  if (Number.isFinite(costFromUI) && costFromUI > 0 && Math.abs(costFromUI - expectedCost) > 0.001) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'cost_mismatch', expected_cost: expectedCost });
  }

  const cost = Number.isFinite(costFromUI) && costFromUI > 0 ? costFromUI : expectedCost;
  const newCredits = Number.isFinite(creditsBefore) ? Math.max(0, creditsBefore - cost) : 0;
  const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

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
    '?telegram_id=' + encodeURIComponent(telegramId) +
    '&run_id=' + encodeURIComponent(runId) +
    '&new_credits=' + encodeURIComponent(newCredits) +
    '&credits_before=' + encodeURIComponent(creditsBefore) +
    '&cost=' + encodeURIComponent(cost) +
    '&mode=' + encodeURIComponent(mode) +
    '&leng=' + encodeURIComponent(leng) +
    '&loading_message_id=' + encodeURIComponent(loadingMessageId || '');

  const payload = {
    model,
    callBackUrl: callbackUrl,
    input,
    meta: { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId },
    metadata: { telegram_id: telegramId, run_id: runId, cost, loading_message_id: loadingMessageId }
  };

  try {
    const resp = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KIE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }

    if (!resp.ok) {
      return jsonResponse(resp.status || 502, {
        ok: false,
        submitted: false,
        error: (data && (data.error || data.msg || data.message)) || 'happyhorse_create_failed',
        data
      });
    }

    const taskId = extractTaskId(data);
    if (!taskId) {
      return jsonResponse(502, { ok: false, submitted: false, error: 'missing_task_id', data });
    }

    await writeTelegramGeneration({ telegramId, cost, prompt, modelLabel });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId,
      loading_message_id: loadingMessageId,
      new_credits: newCredits
    });
  } catch (e) {
    return jsonResponse(500, {
      ok: false,
      submitted: false,
      error: e && e.message ? e.message : 'server_error'
    });
  }
};
