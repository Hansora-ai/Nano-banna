// netlify/functions/run-wan-2-7.js
// Submit a Wan 2.7 video task via KIE for Telegram Mini App.

const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY = process.env.KIE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG_TABLE_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/telegram_generations` : '';

const MAKE_HOOK = 'https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354';
const LOADING_HOOK = 'https://n8n.srv1223021.hstgr.cloud/webhook/83b19830-f204-4e40-bef7-cfab15abf797';

const RATE = {
  '720p': 1.5,
  '1080p': 2
};

const MODELS = {
  text_to_video: 'wan/2-7-text-to-video',
  image_to_video: 'wan/2-7-image-to-video',
  reference_to_video: 'wan/2-7-r2v',
  video_edit: 'wan/2-7-videoedit'
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function normalizeLeng(v) {
  const value = String(v || '').trim().toLowerCase();
  return value === 'ru' ? 'ru' : 'en';
}

function getLoadingMessage(leng) {
  return normalizeLeng(leng) === 'ru'
    ? '⏳ Ваша генерация принята.\n\nПожалуйста, подождите — это может занять 5–10 минут, в зависимости от выбранного видео-моделя.\n\nПока ваш запрос обрабатывается, вы можете создавать другие материалы.'
    : '⏳ Your generation has been accepted.\n\nPlease wait — this can take 5–10 minutes, depending on the selected video model.\n\nWhile this is being processed, you can generate other things as well.';
}

async function sendLoadingMessage({ telegramId, runId, leng, mode, cost, creditsBefore, newCredits, wanMode }) {
  if (!LOADING_HOOK) return null;

  try {
    const normalizedLeng = normalizeLeng(leng);
    const resp = await fetch(LOADING_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        telegram_id: telegramId,
        chat_id: telegramId,
        run_id: runId,
        leng: normalizedLeng,
        lang: normalizedLeng,
        mode,
        wan_mode: wanMode,
        cost,
        credits_before: creditsBefore,
        new_credits: newCredits,
        message: getLoadingMessage(normalizedLeng)
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
  return '';
}

function calcExpectedCost(duration, resolution) {
  const rate = RATE[resolution === '1080p' ? '1080p' : '720p'];
  if (!rate) return NaN;
  return duration * rate;
}

function pickWanMode({ requestedMode, routeHint, firstFrameUrl, lastFrameUrl, inputVideoUrl, referenceImageUrls, referenceVideoUrls }) {
  if (requestedMode === 'video_edit' || routeHint === 'video_edit') return 'video_edit';
  if (routeHint === 'reference_to_video' && !lastFrameUrl) return 'reference_to_video';
  if (routeHint === 'image_to_video') return 'image_to_video';
  if (routeHint === 'text_to_video') return 'text_to_video';
  if ((referenceImageUrls.length > 0 || referenceVideoUrls.length > 0) && !lastFrameUrl) {
    return 'reference_to_video';
  }
  if (firstFrameUrl || lastFrameUrl || inputVideoUrl) {
    return 'image_to_video';
  }
  return 'text_to_video';
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
  const negativePrompt = String(body.negative_prompt || body.negativePrompt || 'low resolution, errors, worst quality, low quality, malformed, distorted, blurry, flicker').trim();
  const firstFrameUrl = normalizeUrl(body.first_frame_url || body.firstFrameUrl || '');
  const lastFrameUrl = normalizeUrl(body.last_frame_url || body.lastFrameUrl || '');
  const inputVideoUrl = normalizeUrl(body.input_video_url || body.inputVideoUrl || body.video_url || body.videoUrl || '');
  const audioUrl = normalizeUrl(body.audio_url || body.audioUrl || '');
  const referenceImageUrls = normalizeUrlList(body.reference_image_urls || body.referenceImageUrls);
  const referenceVideoUrls = normalizeUrlList(body.reference_video_urls || body.referenceVideoUrls);
  const resolution = body.resolution === '1080p' ? '1080p' : '720p';
  const aspectRatio = String(body.aspect_ratio || body.aspectRatio || '16:9').trim();
  const routeHintRaw = String(body.wan_route || body.wanRoute || '').trim();
  const routeHint = ['text_to_video', 'image_to_video', 'reference_to_video', 'video_edit'].includes(routeHintRaw) ? routeHintRaw : '';
  const requestedMode = body.wan_mode === 'video_edit' || routeHint === 'video_edit' ? 'video_edit' : 'auto';
  const promptExtend = typeof body.prompt_extend === 'boolean' ? body.prompt_extend : true;
  const watermark = typeof body.watermark === 'boolean' ? body.watermark : false;
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
  if (lastFrameUrl && !firstFrameUrl) return jsonResponse(400, { ok: false, submitted: false, error: 'last_frame_requires_first_frame' });
  const hasReferenceMedia = referenceImageUrls.length > 0 || referenceVideoUrls.length > 0;
  if (lastFrameUrl && hasReferenceMedia && requestedMode !== 'video_edit') {
    return jsonResponse(400, {
      ok: false,
      submitted: false,
      error: 'last_frame_cannot_use_reference_media',
      details: 'Remove Last Frame. Wan 2.7 Reference to Video accepts First Frame with reference images/videos, but not Last Frame.'
    });
  }

  const wanMode = pickWanMode({ requestedMode, routeHint, firstFrameUrl, lastFrameUrl, inputVideoUrl, referenceImageUrls, referenceVideoUrls });
  const r2vUsesInputVideoAsReference = wanMode === 'reference_to_video' && !!inputVideoUrl;
  const totalReferenceMedia = referenceImageUrls.length + referenceVideoUrls.length + (r2vUsesInputVideoAsReference ? 1 : 0);

  if (referenceImageUrls.length > 5) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_reference_images' });
  if (referenceVideoUrls.length + (r2vUsesInputVideoAsReference ? 1 : 0) > 5) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_reference_videos' });
  if (totalReferenceMedia > 5) return jsonResponse(400, { ok: false, submitted: false, error: 'too_many_total_references' });
  const maxDuration = wanMode === 'video_edit' ? 10 : 15;
  const duration = clampInt(body.duration, 4, maxDuration);

  if (wanMode === 'text_to_video') {
    if (firstFrameUrl || lastFrameUrl || inputVideoUrl || referenceImageUrls.length || referenceVideoUrls.length) {
      return jsonResponse(400, { ok: false, submitted: false, error: 'text_to_video_accepts_only_prompt_and_optional_audio' });
    }
  }

  if (wanMode === 'image_to_video') {
    if (!firstFrameUrl && !inputVideoUrl) return jsonResponse(400, { ok: false, submitted: false, error: 'image_to_video_requires_first_frame_or_video' });
    if (referenceImageUrls.length || referenceVideoUrls.length) {
      return jsonResponse(400, {
        ok: false,
        submitted: false,
        error: 'image_to_video_cannot_use_reference_media',
        details: 'Wan 2.7 Image to Video only uses first_frame_url, last_frame_url, or first_clip_url. Remove references or remove Last Frame so it routes to Reference to Video.'
      });
    }
  }

  if (wanMode === 'reference_to_video') {
    if (lastFrameUrl) return jsonResponse(400, { ok: false, submitted: false, error: 'reference_to_video_cannot_use_last_frame' });
    if (!referenceImageUrls.length && !referenceVideoUrls.length) return jsonResponse(400, { ok: false, submitted: false, error: 'reference_to_video_requires_reference_media' });
  }

  if (wanMode === 'video_edit') {
    if (!inputVideoUrl) return jsonResponse(400, { ok: false, submitted: false, error: 'video_edit_requires_video' });
    if (!referenceImageUrls.length) return jsonResponse(400, { ok: false, submitted: false, error: 'video_edit_requires_reference_images' });
    if (firstFrameUrl || lastFrameUrl || referenceVideoUrls.length || audioUrl) {
      return jsonResponse(400, { ok: false, submitted: false, error: 'video_edit_allows_only_video_reference_images_prompt_duration_resolution_ratio' });
    }
  }

  const expectedCost = calcExpectedCost(duration, resolution);
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
    newCredits,
    wanMode
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
    '&wan_mode=' + encodeURIComponent(wanMode) +
    '&loading_message_id=' + encodeURIComponent(loadingMessageId || '');

  const input = {
    prompt,
    negative_prompt: negativePrompt,
    resolution,
    duration,
    prompt_extend: promptExtend,
    watermark,
    seed: 0
  };

  if (wanMode === 'text_to_video') {
    input.ratio = aspectRatio;
    if (audioUrl) input.audio_url = audioUrl;
  } else if (wanMode === 'image_to_video') {
    if (firstFrameUrl) input.first_frame_url = firstFrameUrl;
    if (lastFrameUrl) input.last_frame_url = lastFrameUrl;
    if (inputVideoUrl && !firstFrameUrl) input.first_clip_url = inputVideoUrl;
    if (audioUrl) input.audio_url = audioUrl;
  } else if (wanMode === 'reference_to_video') {
    input.aspect_ratio = aspectRatio;
    const r2vReferenceVideoUrls = inputVideoUrl ? [inputVideoUrl, ...referenceVideoUrls] : referenceVideoUrls;
    if (referenceImageUrls.length) input.reference_image = referenceImageUrls;
    if (r2vReferenceVideoUrls.length) input.reference_video = r2vReferenceVideoUrls;
    if (firstFrameUrl) input.first_frame = firstFrameUrl;
    if (audioUrl) input.reference_voice = audioUrl;
  } else if (wanMode === 'video_edit') {
    input.aspect_ratio = aspectRatio;
    input.video_url = inputVideoUrl;
    input.reference_image = referenceImageUrls.length === 1 ? referenceImageUrls[0] : referenceImageUrls;
    input.audio_setting = 'auto';
  }

  const payload = {
    model: MODELS[wanMode],
    callBackUrl: callbackUrl,
    input,
    meta: { telegram_id: telegramId, run_id: runId, cost, wan_mode: wanMode, loading_message_id: loadingMessageId },
    metadata: { telegram_id: telegramId, run_id: runId, cost, wan_mode: wanMode, loading_message_id: loadingMessageId }
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
        error: (data && (data.error || data.msg || data.message)) || 'wan_create_failed',
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
      modelLabel: 'Wan 2.7 ' + wanMode.replace(/_/g, ' ')
    });

    return jsonResponse(201, {
      ok: true,
      submitted: true,
      run_id: runId,
      wan_mode: wanMode,
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
