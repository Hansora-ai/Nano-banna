// netlify/functions/run-gemini-omni-flash-1-1.js
// KIE Gemini Omni 1.1 Flash launcher for website and Telegram Mini App requests.
const KIE_BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, '');
const KIE_KEY = process.env.KIE_API_KEY || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE_BASE = (process.env.SITE_BASE || 'https://hansora.co').replace(/\/+$/, '');
const WEBSITE_CALLBACK = `${SITE_BASE}/.netlify/functions/kie-check`;
const TELEGRAM_CALLBACK = process.env.TELEGRAM_VIDEO_CALLBACK_URL || 'https://n8n.srv1223021.hstgr.cloud/webhook/42acdd7a-21a6-4258-a925-3f0174c1f354';
const TELEGRAM_LOADING_HOOK = process.env.TELEGRAM_LOADING_HOOK_URL || 'https://n8n.srv1223021.hstgr.cloud/webhook/41c3d47d-eef6-49f6-95dd-51dce81f84d1';
const MODEL = 'google/gemini-omni-flash-1-1';
const VERSION = 'gemini_omni_flash_1_1_v1';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-USER-ID, x-user-id',
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Hansora-Version': VERSION, ...cors() },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const headers = event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function bearerToken(event) {
  return (String(header(event, 'authorization')).match(/^Bearer\s+(.+)$/i) || [])[1] || '';
}

function cleanString(value, max = 20000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function httpUrl(value) {
  const text = cleanString(value, 4000);
  if (!/^https:\/\//i.test(text)) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function uniqueUrls(values, max) {
  return [...new Set((Array.isArray(values) ? values : []).map(httpUrl).filter(Boolean))].slice(0, max);
}

function extractTaskId(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = [data?.data?.taskId, data?.taskId, data?.result?.taskId, data?.data?.task_id, data?.task_id, data?.id]
    .map((value) => value == null ? '' : String(value))
    .find((value) => value.length > 3);
  if (direct) return direct;
  const seen = new Set();
  const scan = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      if (/^(task[_-]?id|request[_-]?id|id)$/i.test(key) && ['string', 'number'].includes(typeof inner)) {
        const candidate = String(inner);
        if (candidate.length > 3) return candidate;
      }
      const nested = scan(inner);
      if (nested) return nested;
    }
    return '';
  };
  return scan(data);
}

function normalizeResolution(value) {
  const key = cleanString(value, 20).toLowerCase();
  return ['720p', '1080p', '4k'].includes(key) ? key : '';
}

function normalizeDuration(value) {
  const duration = Number(value);
  return [4, 6, 8, 10].includes(duration) ? duration : 0;
}

function costFor({ resolution, duration, hasVideo }) {
  if (hasVideo) return resolution === '4k' ? 16 : 11;
  const standard = { 4: 4, 6: 5.5, 8: 6.9, 10: 8.3 };
  const fourK = { 4: 10, 6: 11, 8: 12, 10: 14 };
  return resolution === '4k' ? fourK[duration] : standard[duration];
}

function normalizeRequest(body) {
  const prompt = cleanString(body.prompt);
  const resolution = normalizeResolution(body.resolution || '1080p');
  const aspectRatio = ['16:9', '9:16'].includes(cleanString(body.aspect_ratio, 10)) ? cleanString(body.aspect_ratio, 10) : '';
  const rawImageUrls = Array.isArray(body.image_urls) ? body.image_urls.filter((value) => cleanString(value, 4000)) : [];
  const rawAudioIds = Array.isArray(body.audio_ids) ? body.audio_ids.filter((value) => cleanString(value, 200)) : [];
  const rawCharacterIds = Array.isArray(body.character_ids) ? body.character_ids.filter((value) => cleanString(value, 200)) : [];
  const imageUrls = uniqueUrls(rawImageUrls, 7);
  const audioIds = [...new Set(rawAudioIds.map((value) => cleanString(value, 200)).filter(Boolean))].slice(0, 3);
  const characterIds = [...new Set(rawCharacterIds.map((value) => cleanString(value, 200)).filter(Boolean))].slice(0, 3);
  const firstFrameUrl = httpUrl(body.first_frame_url);
  const lastFrameUrl = httpUrl(body.last_frame_url);
  const rawVideos = Array.isArray(body.video_list) ? body.video_list.filter(Boolean) : [];
  const videoList = rawVideos.slice(0, 1).map((item) => {
    const start = Number(item && item.start);
    const ends = Number(item && item.ends);
    return { url: httpUrl(item && item.url), start, ends };
  }).filter((item) => item.url);
  const hasVideo = videoList.length === 1;
  const duration = hasVideo ? 0 : normalizeDuration(body.duration || 4);
  const seedValue = Number(body.seed);
  const seed = Number.isInteger(seedValue) && seedValue >= 0 && seedValue <= 2147483647 ? seedValue : null;
  return {
    prompt, resolution, aspectRatio, imageUrls, audioIds, characterIds, firstFrameUrl, lastFrameUrl,
    videoList, hasVideo, duration, seed,
    rawImageCount: rawImageUrls.length,
    rawAudioCount: rawAudioIds.length,
    rawCharacterCount: rawCharacterIds.length,
    rawVideoCount: rawVideos.length,
  };
}

function validateInput(input) {
  if (!input.prompt) return 'missing_prompt';
  if (!input.resolution) return 'invalid_resolution';
  if (!input.aspectRatio) return 'invalid_aspect_ratio';
  if (!input.hasVideo && !input.duration) return 'invalid_duration';
  if (input.rawImageCount > 7) return 'too_many_images';
  if (input.rawAudioCount > 3) return 'too_many_audio_ids';
  if (input.rawCharacterCount > 3) return 'too_many_character_ids';
  if (input.rawVideoCount > 1) return 'too_many_videos';
  if (input.imageUrls.length !== input.rawImageCount) return 'invalid_or_duplicate_image_url';
  if (input.videoList.length !== input.rawVideoCount) return 'invalid_video_url';
  if (input.hasVideo) {
    const clip = input.videoList[0];
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.ends) || clip.start < 0 || clip.ends <= clip.start || clip.ends - clip.start > 10.0001) {
      return 'invalid_video_clip';
    }
  }
  if (input.lastFrameUrl && !input.firstFrameUrl) return 'last_frame_requires_first_frame';
  if (input.firstFrameUrl && (input.imageUrls.length || input.videoList.length || input.characterIds.length || input.audioIds.length)) {
    return 'first_frame_conflicts_with_references';
  }
  const quota = input.imageUrls.length + (input.videoList.length * 2) + input.characterIds.length;
  if (quota > 7) return 'media_quota_exceeded';
  return '';
}

function kieInput(input) {
  return {
    prompt: input.prompt,
    resolution: input.resolution,
    aspect_ratio: input.aspectRatio,
    ...(input.hasVideo ? {} : { duration: String(input.duration) }),
    ...(input.imageUrls.length ? { image_urls: input.imageUrls } : {}),
    ...(input.audioIds.length ? { audio_ids: input.audioIds } : {}),
    ...(input.characterIds.length ? { character_ids: input.characterIds } : {}),
    ...(input.videoList.length ? { video_list: input.videoList } : {}),
    ...(input.firstFrameUrl ? { first_frame_url: input.firstFrameUrl } : {}),
    ...(input.lastFrameUrl ? { last_frame_url: input.lastFrameUrl } : {}),
    ...(input.seed != null ? { seed: input.seed } : {}),
  };
}

async function verifyWebsiteAuth(event, uid) {
  const token = bearerToken(event);
  if (!token) return { ok: false, error: 'missing_auth' };
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { ok: false, error: 'bad_auth' };
  const user = await response.json().catch(() => null);
  const authenticatedId = user && (user.id || user.user?.id);
  return authenticatedId && String(authenticatedId) === String(uid) ? { ok: true } : { ok: false, error: 'uid_mismatch' };
}

async function fetchGeneration(uid, runId) {
  const url = `${SUPABASE_URL}/rest/v1/user_generations?user_id=eq.${encodeURIComponent(uid)}&meta->>run_id=eq.${encodeURIComponent(runId)}&select=id,meta`;
  const response = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function insertGeneration(uid, runId, prompt, meta) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/user_generations`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: uid, provider: 'Gemini Omni 1.1 Flash', kind: 'video', prompt, result_url: null, meta }),
  });
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0].id : null;
}

async function patchGeneration(rowId, meta) {
  if (!rowId) return;
  await fetch(`${SUPABASE_URL}/rest/v1/user_generations?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ meta }),
  });
}

async function getCredits(uid) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(uid)}&select=credits`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = await response.json().catch(() => []);
  return Number(Array.isArray(rows) && rows[0] ? rows[0].credits : 0);
}

async function debitCredits(uid, cost) {
  const current = await getCredits(uid);
  if (!Number.isFinite(current) || current < cost) return { ok: false, error: 'not_enough_credits', credits: current || 0 };
  const next = Number((current - cost).toFixed(2));
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ credits: next }),
  });
  if (!response.ok) return { ok: false, error: 'profile_update_failed' };
  return { ok: true, credits: next };
}

async function writeTelegramGeneration({ telegramId, runId, prompt, taskId, cost }) {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/telegram_generations`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{ telegram_id: telegramId, model: 'Gemini Omni 1.1 Flash', credits: cost, prompt, run_id: runId, task_id: taskId, status: 'submitted', kind: 'video', result_url: null }]),
  });
}

async function sendTelegramLoading({ telegramId, runId, cost, creditsBefore, newCredits, language }) {
  if (!TELEGRAM_LOADING_HOOK) return '';
  try {
    const response = await fetch(TELEGRAM_LOADING_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: telegramId, chat_id: telegramId, run_id: runId, cost, credits_before: creditsBefore, new_credits: newCredits, leng: language, lang: language, message: language === 'ru' ? '⏳ Генерация видео запущена. Пожалуйста, подождите…' : '⏳ Your video generation has started. Please wait…' }),
    });
    const data = await response.json().catch(() => ({}));
    return String(data.message_id || data.messageId || data.result?.message_id || '');
  } catch (_) {
    return '';
  }
}

async function createKieTask(input, callbackUrl) {
  const response = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KIE_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: MODEL, input: kieInput(input), callBackUrl: callbackUrl }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code != null && Number(data.code) !== 200)) return { ok: false, status: response.status || 502, data };
  const taskId = extractTaskId(data);
  return taskId ? { ok: true, taskId, data } : { ok: false, status: 502, data: { ...data, error: 'missing_task_id' } };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!KIE_KEY || !SUPABASE_URL || !SERVICE_KEY) return json(500, { ok: false, error: 'missing_env' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { ok: false, error: 'bad_json' }); }

  try {
    const input = normalizeRequest(body);
    const validationError = validateInput(input);
    if (validationError) return json(400, { ok: false, error: validationError });
    const cost = costFor({ resolution: input.resolution, duration: input.duration, hasVideo: input.hasVideo });
    const isTelegram = !bearerToken(event) && !!cleanString(body.telegram_id, 100);
    const uid = cleanString(isTelegram ? body.telegram_id : (body.uid || body.user_id || header(event, 'x-user-id')), 200);
    if (!uid) return json(401, { ok: false, error: 'missing_uid' });
    const runId = cleanString(body.run_id || `${uid}-${Date.now()}`, 240);

    if (isTelegram) {
      if (cleanString(header(event, 'x-user-id'), 200) !== uid) return json(401, { ok: false, error: 'telegram_uid_mismatch' });
      const creditsBefore = Number(body.credits_before || 0);
      if (!Number.isFinite(creditsBefore) || creditsBefore < cost) return json(402, { ok: false, error: 'not_enough_credits', credits: creditsBefore || 0, need: cost });
      const newCredits = Number((creditsBefore - cost).toFixed(2));
      const language = cleanString(body.leng || body.lang, 10).toLowerCase() === 'ru' ? 'ru' : 'en';
      const loadingMessageId = await sendTelegramLoading({ telegramId: uid, runId, cost, creditsBefore, newCredits, language });
      const callbackUrl = `${TELEGRAM_CALLBACK}?telegram_id=${encodeURIComponent(uid)}&run_id=${encodeURIComponent(runId)}&new_credits=${encodeURIComponent(newCredits)}&credits_before=${encodeURIComponent(creditsBefore)}&cost=${encodeURIComponent(cost)}&leng=${encodeURIComponent(language)}&loading_message_id=${encodeURIComponent(loadingMessageId)}`;
      const created = await createKieTask(input, callbackUrl);
      if (!created.ok) return json(created.status, { ok: false, error: 'kie_create_failed', details: created.data });
      await writeTelegramGeneration({ telegramId: uid, runId, prompt: input.prompt, taskId: created.taskId, cost });
      return json(201, { ok: true, submitted: true, taskId: created.taskId, id: created.taskId, run_id: runId, new_credits: newCredits, cost, checker: 'kie-check' });
    }

    const auth = await verifyWebsiteAuth(event, uid);
    if (!auth.ok) return json(401, { ok: false, error: auth.error });
    const existing = await fetchGeneration(uid, runId);
    const existingTaskId = existing?.meta?.task_id || existing?.meta?.taskId || '';
    if (existingTaskId) return json(200, { ok: true, submitted: true, taskId: existingTaskId, run_id: runId, already_submitted: true });

    const metaBase = { source: 'kie', engine: 'gemini-omni-flash-1-1', model: MODEL, run_id: runId, status: 'pending', refund_amount: cost };
    const rowId = existing?.id || await insertGeneration(uid, runId, input.prompt, metaBase);
    const credits = await getCredits(uid);
    if (!Number.isFinite(credits) || credits < cost) return json(402, { ok: false, error: 'not_enough_credits', credits: credits || 0, need: cost });

    const callbackUrl = `${WEBSITE_CALLBACK}?uid=${encodeURIComponent(uid)}&run_id=${encodeURIComponent(runId)}`;
    const created = await createKieTask(input, callbackUrl);
    if (!created.ok) {
      await patchGeneration(rowId, { ...metaBase, status: 'failed', error: created.data });
      return json(created.status, { ok: false, error: 'kie_create_failed', details: created.data });
    }

    const debit = await debitCredits(uid, cost);
    if (!debit.ok) {
      await patchGeneration(rowId, { ...metaBase, status: 'failed', error: debit.error, orphaned_task_id: created.taskId });
      return json(402, { ok: false, error: debit.error, details: debit });
    }
    await patchGeneration(rowId, { ...metaBase, status: 'processing', task_id: created.taskId, charged: true, charged_at: new Date().toISOString(), charged_cost: cost, debited: cost, refund_amount: cost });
    return json(201, { ok: true, submitted: true, taskId: created.taskId, id: created.taskId, run_id: runId, row_id: rowId, debited: cost, credits: debit.credits, checker: 'kie-check' });
  } catch (error) {
    return json(500, { ok: false, error: 'server_error', details: String(error && error.message || error) });
  }
};
