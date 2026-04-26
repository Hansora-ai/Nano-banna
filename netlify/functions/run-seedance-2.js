// netlify/functions/run-seedance-2.js
// Submit a Seedance 2 / Seedance 2 Lite video task via KIE for Telegram Mini App.

const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY = process.env.KIE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : '';

const MAKE_HOOK = 'https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354';

const RATE = {
  lite: { '720p': 3 },
  pro: { '720p': 3.5, '1080p': 7 }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
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
  return '';
}

function calcExpectedCost(duration, seedanceModel, resolution) {
  const modelKey = seedanceModel === 'pro' ? 'pro' : 'lite';
  const resKey = resolution === '1080p' ? '1080p' : '720p';
  const rate = RATE[modelKey][resKey];
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
  const firstFrameUrl = normalizeUrl(body.first_frame_url || body.firstFrameUrl || '');
  const lastFrameUrl = normalizeUrl(body.last_frame_url || body.lastFrameUrl || '');
  const referenceImageUrls = normalizeUrlList(body.reference_image_urls || body.referenceImageUrls);
  const referenceVideoUrls = normalizeUrlList(body.reference_video_urls || body.referenceVideoUrls);
  const referenceAudioUrls = normalizeUrlList(body.reference_audio_urls || body.referenceAudioUrls);
  const generateAudio = !!body.generate_audio;
  const webSearch = !!body.web_search;
  const resolution = body.resolution === '1080p' ? '1080p' : '720p';
  const aspectRatio = String(body.aspect_ratio || body.aspectRatio || '16:9').trim();
  const duration = clampInt(body.duration, 4, 15);
  const seedanceModel = body.seedance_model === 'pro' ? 'pro' : 'lite';
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

  if (!telegramId) return jsonResponse(400, { ok: false, submitted: false, error: 'missing_telegram_id' });
  if (!prompt) return jsonResponse(400, { ok: false, submitted: false, error: 'missing_prompt' });
  if (lastFrameUrl && !firstFrameUrl) return jsonResponse(400, { ok: false, submitted: false, error: 'last_frame_requires_first_frame' });
  if (referenceImageUrls.length > 9) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_reference_images' });
  if (referenceVideoUrls.length > 3) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_reference_videos' });
  if (referenceAudioUrls.length > 3) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_reference_audios' });

  const hasFrames = !!firstFrameUrl || !!lastFrameUrl;
  const hasReferences = referenceImageUrls.length > 0 || referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0;
  if (hasFrames && hasReferences) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'frames_and_multimodal_references_are_mutually_exclusive' });
  }

  if (seedanceModel === 'lite' && resolution !== '720p') {
    return jsonResponse(400, { ok: false, submitted: false, error: 'seedance_2_lite_supports_only_720p' });
  }

  const expectedCost = calcExpectedCost(duration, seedanceModel, resolution);
  if (!Number.isFinite(expectedCost)) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'invalid_cost_config' });
  }
  if (Number.isFinite(costFromUI) && costFromUI > 0 && Math.abs(costFromUI - expectedCost) > 0.001) {
    return jsonResponse(400, { ok: false, submitted: false, error: 'cost_mismatch', expected_cost: expectedCost });
  }

  const cost = Number.isFinite(costFromUI) && costFromUI > 0 ? costFromUI : expectedCost;
  const newCredits = Number.isFinite(creditsBefore) ? Math.max(0, creditsBefore - cost) : 0;
  const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  const callbackUrl =
    MAKE_HOOK +
    '?telegram_id=' + encodeURIComponent(telegramId) +
    '&run_id=' + encodeURIComponent(runId) +
    '&new_credits=' + encodeURIComponent(newCredits) +
    '&credits_before=' + encodeURIComponent(creditsBefore) +
    '&cost=' + encodeURIComponent(cost) +
    '&mode=' + encodeURIComponent(mode) +
    '&leng=' + encodeURIComponent(leng);

  const input = {
    prompt,
    return_last_frame: false,
    generate_audio: generateAudio,
    resolution,
    aspect_ratio: aspectRatio,
    duration,
    web_search: webSearch
  };

  if (firstFrameUrl) input.first_frame_url = firstFrameUrl;
  if (lastFrameUrl) input.last_frame_url = lastFrameUrl;
  if (referenceImageUrls.length) input.reference_image_urls = referenceImageUrls;
  if (referenceVideoUrls.length) input.reference_video_urls = referenceVideoUrls;
  if (referenceAudioUrls.length) input.reference_audio_urls = referenceAudioUrls;

  const payload = {
    model: seedanceModel === 'pro' ? 'bytedance/seedance-2' : 'bytedance/seedance-2-fast',
    callBackUrl: callbackUrl,
    input
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
        error: (data && (data.error || data.msg || data.message)) || 'seedance_create_failed',
        data
      });
    }

    const taskId = extractTaskId(data);
    if (!taskId) {
      return jsonResponse(502, { ok: false, submitted: false, error: 'missing_task_id', data });
    }

    await writeTelegramGeneration({
      telegramId,
      cost,
      prompt,
      modelLabel: seedanceModel === 'pro' ? 'Seedance 2 Video' : 'Seedance 2 Lite Video'
    });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id: runId,
      taskId,
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
