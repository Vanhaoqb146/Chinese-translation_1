/**
 * API Service for VoiceTranslate AI Mobile App
 * Handles communication with the Next.js API endpoints.
 */

import * as SecureStore from 'expo-secure-store';
import { DEFAULT_TRANSLATION_MODEL, normalizeTranslationModel } from '../lib/translationModels';
import {
  detectMobileTextLanguage,
  isTextLikelyLanguage,
  normalizeMobileAutoDetectLanguage,
} from '../lib/mobileAutoDetect';

// Default base URL. In development, you should replace this with your computer's local IP
// e.g., 'http://192.168.1.100:3000' or your deployed Vercel domain.
export const DEFAULT_API_BASE = 'https://chinese-translation1.vercel.app'; 

const STORAGE_KEYS = {
  USER: 'vt_mobile_user',
  AUTH_TOKEN: 'vt_mobile_access_token',
  API_BASE: 'vt_mobile_api_base',
  API_KEY: 'vt_mobile_api_key',
  TRANSLATION_MODEL: 'vt_mobile_model',
};

async function getAuthToken() {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN);
  } catch {
    return null;
  }
}

async function withAuthHeaders(headers = {}) {
  const token = await getAuthToken();
  return token
    ? { ...headers, Authorization: `Bearer ${token}` }
    : headers;
}

async function clearSavedSession() {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.USER);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.AUTH_TOKEN);
}

function createResponseError(res, data, fallbackMessage) {
  const error = new Error(data?.error || fallbackMessage);
  error.code = data?.code;
  error.status = res.status;
  return error;
}

export function isAuthenticationError(error) {
  return error?.status === 401 || error?.code === 'UNAUTHORIZED';
}

/**
 * Helper to fetch active Server Base URL from SecureStore or fallback to default
 */
export async function getApiBaseUrl() {
  try {
    const saved = await SecureStore.getItemAsync(STORAGE_KEYS.API_BASE);
    return saved || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

/**
 * Helper to save active Server Base URL
 */
export async function setApiBaseUrl(url) {
  const cleanUrl = url.trim().replace(/\/$/, ''); // Remove trailing slash
  await SecureStore.setItemAsync(STORAGE_KEYS.API_BASE, cleanUrl);
}

/**
 * Handle Login API Request
 */
export async function login(username, password) {
  const baseUrl = await getApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw createResponseError(res, data, 'Đăng nhập thất bại.');
  }
  if (!data.accessToken || !data.user) {
    await clearSavedSession();
    throw new Error('Máy chủ đăng nhập chưa hỗ trợ phiên mobile an toàn.');
  }

  // Save user session securely
  await SecureStore.setItemAsync(STORAGE_KEYS.AUTH_TOKEN, data.accessToken);
  await SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(data.user));
  return data.user;
}

/**
 * Get Saved User Session
 */
export async function getSavedUser() {
  try {
    const token = await getAuthToken();
    if (!token) {
      await clearSavedSession();
      return null;
    }

    const userStr = await SecureStore.getItemAsync(STORAGE_KEYS.USER);
    if (!userStr) {
      await clearSavedSession();
      return null;
    }

    const cachedUser = JSON.parse(userStr);
    const baseUrl = await getApiBaseUrl();

    try {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (res.status === 401) {
        await clearSavedSession();
        return null;
      }
      if (!res.ok) {
        throw createResponseError(res, data, 'Không thể xác minh phiên đăng nhập.');
      }

      const currentUser = data.user || cachedUser;
      await SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(currentUser));
      return currentUser;
    } catch (error) {
      if (isAuthenticationError(error)) {
        await clearSavedSession();
        return null;
      }

      // Keep the cached session during a temporary network outage.
      console.warn('Session validation deferred:', error?.message || error);
      return cachedUser;
    }
  } catch {
    await clearSavedSession();
    return null;
  }
}

/**
 * Log Out and clear session
 */
export async function logout() {
  await clearSavedSession();
}

/**
 * Get Saved Local Configs (API Key & Engine Model)
 */
export async function getLocalConfigs() {
  try {
    const apiKey = await SecureStore.getItemAsync(STORAGE_KEYS.API_KEY) || '';
    const savedModel = await SecureStore.getItemAsync(STORAGE_KEYS.TRANSLATION_MODEL);
    const model = normalizeTranslationModel(savedModel || DEFAULT_TRANSLATION_MODEL);
    return { apiKey, model };
  } catch {
    return { apiKey: '', model: DEFAULT_TRANSLATION_MODEL };
  }
}

/**
 * Save Local Configs (API Key & Engine Model)
 */
export async function saveLocalConfigs(apiKey, model) {
  await SecureStore.setItemAsync(STORAGE_KEYS.API_KEY, apiKey || '');
  await SecureStore.setItemAsync(
    STORAGE_KEYS.TRANSLATION_MODEL,
    normalizeTranslationModel(model || DEFAULT_TRANSLATION_MODEL)
  );
}

/**
 * Fetch Conversation History
 */
export async function fetchHistory(userId) {
  const baseUrl = await getApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/history?userId=${encodeURIComponent(userId)}`, {
    headers: await withAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = createResponseError(res, data, 'Không thể tải lịch sử dịch.');
    if (isAuthenticationError(error)) {
      await clearSavedSession();
    }
    throw error;
  }
  return data.history || [];
}

/**
 * Save translation entry to History
 */
export async function saveHistory({ userId, source, target, fromLang, toLang }) {
  const baseUrl = await getApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/history`, {
    method: 'POST',
    headers: await withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ userId, source, target, fromLang, toLang }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Lỗi khi lưu lịch sử.');
  }
  return data;
}

/**
 * Clear user history
 */
export async function deleteHistory(id, userId) {
  const baseUrl = await getApiBaseUrl();
  let url = `${baseUrl}/api/history`;
  if (id) url += `?id=${id}`;
  else if (userId) url += `?userId=${encodeURIComponent(userId)}`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: await withAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Không thể xóa lịch sử.');
  }
  return data;
}

/**
 * POST text translation
 */
export async function translateText({
  text,
  sourceLang,
  targetLang,
  engine,
  history = [],
  requestId = null,
}) {
  const traceId = requestId || `translate-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const baseUrl = await getApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: await withAuthHeaders({
      'Content-Type': 'application/json',
      'X-Request-ID': traceId,
    }),
    body: JSON.stringify({
      text,
      sourceLang,
      targetLang,
      engine,
      history,
      requestId: traceId,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Lỗi dịch thuật từ máy chủ.');
  }
  if (data.timings) {
    console.log(
      `[PERF ${traceId}] translate_api profile=${data.engine || engine || 'unknown'} actualModel=${data.model || 'unknown'} clientMs=${Date.now() - startedAt} server=${JSON.stringify(data.timings)}`
    );
  }

  return data.translation;
}

const AUDIO_TYPE_BY_EXT = {
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  caf: 'audio/x-caf',
  '3gp': 'audio/3gpp',
};

/** Default network timeout for STT upload calls (ms). */
const STT_FETCH_TIMEOUT_MS = 30_000;
const CJK_TEXT_RE = /[\u3400-\u9fff]/;
const KANA_TEXT_RE = /[\u3040-\u30ff]/;
const HANGUL_TEXT_RE = /[\uac00-\ud7af]/;
const LATIN_TEXT_RE = /[a-zA-Z]/;
const VIETNAMESE_MARKS_RE = /[\u0300-\u036f]|đ/i;

/**
 * Wrapper around fetch() with an explicit timeout.
 * React Native's fetch() has no built-in timeout; long-running or
 * stalled connections can hang indefinitely.
 */
async function fetchWithTimeout(url, options, timeoutMs = STT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`STT request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getAudioUploadMeta(audioUri) {
  const cleanUri = String(audioUri || '').split('?')[0];
  const match = cleanUri.match(/\.([a-zA-Z0-9]+)$/);
  const ext = (match?.[1] || 'wav').toLowerCase();
  return {
    name: `speech.${ext}`,
    type: AUDIO_TYPE_BY_EXT[ext] || 'application/octet-stream',
  };
}

function buildSpeechFormData({ audioUri, srcLang, tgtLang, mode }) {
  const { name, type } = getAudioUploadMeta(audioUri);
  const formData = new FormData();
  formData.append('audio', {
    uri: audioUri,
    name,
    type,
  });
  formData.append('mode', mode);
  formData.append('srcLang', srcLang);
  formData.append('tgtLang', tgtLang);
  return formData;
}

/**
 * Upload audio file to a server STT endpoint.
 * Includes one automatic retry for transient network errors.
 */
async function postSpeechAudio({ endpoint, audioUri, srcLang, tgtLang, mode, requestId }) {
  if (!audioUri) {
    throw new Error('postSpeechAudio: audioUri is null/undefined');
  }

  const baseUrl = await getApiBaseUrl();
  const url = `${baseUrl}${endpoint}`;
  const traceId = requestId || `stt-${Date.now().toString(36)}`;

  const doFetch = async () => {
    const startedAt = Date.now();
    console.log(`[PERF ${traceId}] stt_request endpoint=${endpoint} srcLang=${srcLang} tgtLang=${tgtLang} mode=${mode}`);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: await withAuthHeaders({
        'Accept': 'application/json',
        'X-Request-ID': traceId,
      }),
      body: buildSpeechFormData({ audioUri, srcLang, tgtLang, mode }),
    });

    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data.error || 'Loi nhan dang giong noi.');
      error.code = data.code;
      error.status = res.status;
      throw error;
    }

    return {
      text: data.text || '',
      language: data.language || null,
      provider: data.provider || null,
      confidence: data.confidence !== null &&
        data.confidence !== undefined &&
        Number.isFinite(Number(data.confidence))
        ? Number(data.confidence)
        : null,
      timings: {
        ...(data.timings || {}),
        clientMs: Date.now() - startedAt,
      },
    };
  };

  try {
    const result = await doFetch();
    console.log(`[PERF ${traceId}] stt_response endpoint=${endpoint} lang=${result.language} provider=${result.provider} confidence=${result.confidence} timings=${JSON.stringify(result.timings)}`);
    return result;
  } catch (firstError) {
    // Retry once for transient network errors (common on mobile LAN)
    const msg = String(firstError?.message || '');
    if (msg.includes('Network request failed') || msg.includes('timed out')) {
      console.warn(`[postSpeechAudio] Retrying after transient error: ${msg}  audioUri=${audioUri}`);
      await new Promise((r) => setTimeout(r, 500));
      return doFetch();
    }
    throw firstError;
  }
}

/**
 * POST speech audio to Whisper for STT fallback.
 */
async function transcribeAudioWhisperOnly({
  audioUri,
  srcLang,
  tgtLang,
  mode = 'standard',
  requestId = null,
  forcedLanguage = null,
}) {
  if (!audioUri) {
    throw new Error('transcribeAudioWhisperOnly: audioUri is null/undefined');
  }

  const baseUrl = await getApiBaseUrl();
  const traceId = requestId || `stt-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const doFetch = async () => {
    const res = await fetchWithTimeout(`${baseUrl}/api/whisper`, {
      method: 'POST',
      headers: await withAuthHeaders({
        'Accept': 'application/json',
        'X-Request-ID': traceId,
      }),
      body: buildSpeechFormData({
        audioUri,
        srcLang: forcedLanguage || srcLang,
        tgtLang,
        mode: forcedLanguage ? 'standard' : mode,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data.error || 'Lỗi nhận dạng giọng nói.');
      error.status = res.status;
      throw error;
    }

    return {
      text: data.text || '',
      language: data.language || null,
      provider: 'whisper',
      timings: {
        ...(data.timings || {}),
        clientMs: Date.now() - startedAt,
      },
    };
  };

  try {
    return await doFetch();
  } catch (firstError) {
    const message = String(firstError?.message || '');
    const isTransient =
      message.includes('Network request failed') ||
      message.includes('timed out') ||
      Number(firstError?.status) >= 500;

    if (!isTransient) throw firstError;

    console.warn(`[PERF ${traceId}] whisper_retry reason="${message}"`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return doFetch();
  }
}

function getVerifiedSttScore(result, allowedLangs) {
  const text = (result?.text || '').trim();
  if (!text) {
    return {
      score: -100,
      language: null,
      textLang: null,
    };
  }

  const language = normalizeMobileAutoDetectLanguage(result?.language);
  const textLang = detectMobileTextLanguage(text, allowedLangs);
  const allowedProviderLang = language && allowedLangs.includes(language)
    ? language
    : null;
  // Match the web app: the visible script/diacritics win when Azure's
  // auto-detect label conflicts with the transcript content.
  const resolvedLang = textLang || allowedProviderLang;
  let score = 0;

  if (allowedProviderLang) score += 2;
  if (textLang && allowedLangs.includes(textLang)) score += 2;
  if (allowedProviderLang && textLang && allowedProviderLang === textLang) score += 3;
  if (allowedProviderLang && textLang && allowedProviderLang !== textLang) score -= 2;
  if (language && !allowedProviderLang) score -= 2;
  if (resolvedLang && isTextLikelyLanguage(text, resolvedLang)) score += 1;
  if (result?.provider === 'whisper') score += 0.5;

  return {
    score,
    language: resolvedLang,
    textLang,
  };
}

function chooseVerifiedSttResult(primaryResult, verifierResult, srcLang, tgtLang) {
  if (!primaryResult?.text && verifierResult?.text) return verifierResult;
  if (!verifierResult?.text) return primaryResult;

  const allowedLangs = [srcLang, tgtLang]
    .map(normalizeMobileAutoDetectLanguage)
    .filter(Boolean);
  const primaryScore = getVerifiedSttScore(primaryResult, allowedLangs);
  const verifierScore = getVerifiedSttScore(verifierResult, allowedLangs);

  if (
    verifierScore.language &&
    verifierScore.textLang &&
    verifierScore.language === verifierScore.textLang &&
    verifierScore.language !== primaryScore.language &&
    verifierScore.score >= primaryScore.score - 0.5
  ) {
    return {
      ...verifierResult,
      provider: 'whisper-verified',
    };
  }

  if (primaryScore.score < 2 && verifierScore.score > primaryScore.score) {
    return {
      ...verifierResult,
      provider: 'whisper-verified',
    };
  }

  return primaryResult;
}

function canUseHighConfidenceAzureResult(result, srcLang, tgtLang) {
  const confidence = Number(result?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.82) return false;

  const allowedLangs = [srcLang, tgtLang]
    .map(normalizeMobileAutoDetectLanguage)
    .filter(Boolean);
  const score = getVerifiedSttScore(result, allowedLangs);

  return Boolean(
    score.language &&
    score.textLang &&
    score.language === score.textLang &&
    score.score >= 5
  );
}

function canUseEarlyWhisperResult(result, srcLang, tgtLang) {
  const text = (result?.text || '').trim();
  if (!text) return false;

  const allowedLangs = getAllowedSttLanguages(srcLang, tgtLang);
  const providerLang = normalizeMobileAutoDetectLanguage(result?.language);
  const textLang = detectMobileTextLanguage(text, allowedLangs);
  if (!providerLang || providerLang !== textLang || !allowedLangs.includes(providerLang)) {
    return false;
  }

  const hasStrongScriptEvidence =
    (providerLang === 'vi' && hasVietnameseMarks(text)) ||
    (providerLang === 'zh' && CJK_TEXT_RE.test(text)) ||
    (providerLang === 'ja' && KANA_TEXT_RE.test(text)) ||
    (providerLang === 'ko' && HANGUL_TEXT_RE.test(text)) ||
    (
      providerLang === 'en' &&
      !allowedLangs.includes('vi') &&
      isLatinOnlySpeechText(text) &&
      text.split(/\s+/).length >= 3
    );

  return hasStrongScriptEvidence && isTextLikelyLanguage(text, providerLang);
}

function getAllowedSttLanguages(srcLang, tgtLang) {
  return [srcLang, tgtLang]
    .map(normalizeMobileAutoDetectLanguage)
    .filter(Boolean);
}

function hasVietnameseMarks(text) {
  return VIETNAMESE_MARKS_RE.test((text || '').normalize('NFD'));
}

function isLatinOnlySpeechText(text) {
  const value = text || '';
  return LATIN_TEXT_RE.test(value) &&
    !CJK_TEXT_RE.test(value) &&
    !KANA_TEXT_RE.test(value) &&
    !HANGUL_TEXT_RE.test(value);
}

function shouldRunVietnameseVerifier(result, srcLang, tgtLang) {
  const text = (result?.text || '').trim();
  if (!text || !isLatinOnlySpeechText(text)) return false;

  const allowedLangs = getAllowedSttLanguages(srcLang, tgtLang);
  if (!allowedLangs.includes('vi') || allowedLangs.includes('en')) return false;

  const textLang = detectMobileTextLanguage(text, allowedLangs);
  if (textLang !== 'vi') return false;

  const providerLang = normalizeMobileAutoDetectLanguage(result?.language);
  const confidence = Number(result?.confidence);
  const provider = String(result?.provider || '');
  const lowConfidenceAzure = provider.startsWith('azure') &&
    (!Number.isFinite(confidence) || confidence < 0.7);

  return !hasVietnameseMarks(text) || providerLang !== 'vi' || lowConfidenceAzure;
}

function chooseForcedVietnameseResult(currentResult, forcedResult, srcLang, tgtLang) {
  if (!forcedResult?.text) return currentResult;

  const allowedLangs = getAllowedSttLanguages(srcLang, tgtLang);
  const currentScore = getVerifiedSttScore(currentResult, allowedLangs);
  const forcedScore = getVerifiedSttScore(
    { ...forcedResult, provider: 'whisper' },
    allowedLangs
  );

  if (forcedScore.score >= currentScore.score) {
    return {
      ...forcedResult,
      provider: 'whisper-forced-vi',
      language: 'vi',
    };
  }

  return currentResult;
}

function repairVietnameseSttText(text) {
  return (text || '')
    .replace(/\btodo\s+into\s+viet\s*nam\b/gi, 't\u00f4i \u0111\u1ebfn t\u1eeb Vi\u1ec7t Nam')
    .replace(/\btoi\s+den\s+tu\s+viet\s*nam\b/gi, 't\u00f4i \u0111\u1ebfn t\u1eeb Vi\u1ec7t Nam')
    .replace(/\bto\s+den\s+tu\s+viet\s*nam\b/gi, 't\u00f4i \u0111\u1ebfn t\u1eeb Vi\u1ec7t Nam')
    .replace(/\bviet\s*nam\b/gi, 'Vi\u1ec7t Nam')
    .replace(/\bcaban\b/gi, 'c\u00e1c b\u1ea1n')
    .replace(/\bca\s+ban\b/gi, 'c\u00e1c b\u1ea1n')
    .replace(/\bcac\s+ban\b/gi, 'c\u00e1c b\u1ea1n')
    .replace(/\bchao\b/gi, 'ch\u00e0o')
    .replace(/\bcam\s+on\b/gi, 'c\u1ea3m \u01a1n')
    .replace(/\bchu\s+y\b/gi, 'ch\u00fa \u00fd')
    .replace(/\blang\s+nghe\b/gi, 'l\u1eafng nghe');
}

function maybeRepairVietnameseResult(result, srcLang, tgtLang) {
  const text = (result?.text || '').trim();
  if (!text || !isLatinOnlySpeechText(text)) return result;

  const allowedLangs = getAllowedSttLanguages(srcLang, tgtLang);
  const resultLang = normalizeMobileAutoDetectLanguage(result?.language);
  const textLang = detectMobileTextLanguage(text, allowedLangs);
  if (resultLang !== 'vi' && textLang !== 'vi') return result;

  const repairedText = repairVietnameseSttText(text).replace(/\s+/g, ' ').trim();
  if (!repairedText || repairedText === text) return result;

  return {
    ...result,
    text: repairedText,
    repairedText: true,
  };
}

/**
 * POST speech audio for STT.
 * For conversation mode (auto-detect): runs Azure + Whisper in PARALLEL
 * and picks the best result. Azure Fast Transcription alone cannot
 * reliably distinguish tonal language pairs like zh/vi.
 */
export async function transcribeAudio({
  audioUri,
  srcLang,
  tgtLang,
  mode = 'standard',
  provider = 'azure',
  fallbackProvider = 'whisper',
  requestId = null,
  allowEarlyAzure = true,
  allowEarlyWhisper = false,
}) {
  const traceId = requestId || `stt-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  console.log(`[PERF ${traceId}] stt_started provider=${provider} fallback=${fallbackProvider} mode=${mode} srcLang=${srcLang} tgtLang=${tgtLang} allowEarlyAzure=${allowEarlyAzure}`);

  // Early bail-out: if the audio file URI is missing (recording failed
  // or file was cleaned up), return empty result instead of crashing.
  if (!audioUri) {
    console.warn('[transcribeAudio] audioUri is null — recording may have failed.');
    return { text: '', language: null, provider: null };
  }

  if (provider !== 'azure') {
    return transcribeAudioWhisperOnly({
      audioUri,
      srcLang,
      tgtLang,
      mode,
      requestId: traceId,
    });
  }

  // Conversation mode: run Azure + Whisper in PARALLEL for accuracy + speed
  if (mode === 'conversation') {
    const azurePromise = postSpeechAudio({
      endpoint: '/api/azure/stt',
      audioUri,
      srcLang,
      tgtLang,
      mode,
      requestId: traceId,
    }).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );
    const whisperPromise = transcribeAudioWhisperOnly({
      audioUri,
      srcLang,
      tgtLang,
      mode,
      requestId: traceId,
    }).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );

    const firstSettled = await Promise.race([
      azurePromise.then((result) => ({ source: 'azure', result })),
      whisperPromise.then((result) => ({ source: 'whisper', result })),
    ]);
    let azureSettled = firstSettled.source === 'azure'
      ? firstSettled.result
      : null;
    let whisperSettled = firstSettled.source === 'whisper'
      ? firstSettled.result
      : null;

    if (
      whisperSettled?.status === 'fulfilled' &&
      allowEarlyWhisper &&
      canUseEarlyWhisperResult(whisperSettled.value, srcLang, tgtLang)
    ) {
      const whisper = whisperSettled.value;
      const totalMs = Date.now() - startedAt;
      console.log(
        `[PERF ${traceId}] stt_chosen provider=whisper-strong-script ` +
        `lang=${whisper.language} totalMs=${totalMs}`
      );
      return {
        ...whisper,
        provider: 'whisper-strong-script',
        timings: {
          azureMs: null,
          whisperMs: whisper.timings?.clientMs || null,
          totalMs,
          earlyAzure: false,
          earlyWhisper: true,
        },
      };
    }

    if (!azureSettled) {
      azureSettled = await azurePromise;
    }
    const azure = azureSettled.status === 'fulfilled' ? azureSettled.value : null;

    if (azure && allowEarlyAzure && canUseHighConfidenceAzureResult(azure, srcLang, tgtLang)) {
      const totalMs = Date.now() - startedAt;
      console.log(`[PERF ${traceId}] stt_chosen provider=azure-high-confidence totalMs=${totalMs} confidence=${azure.confidence}`);
      return {
        ...azure,
        provider: 'azure-high-confidence',
        timings: {
          azureMs: azure.timings?.clientMs || null,
          whisperMs: null,
          totalMs,
          earlyAzure: true,
        },
      };
    }

    if (azure && !allowEarlyAzure && canUseHighConfidenceAzureResult(azure, srcLang, tgtLang)) {
      console.log(`[PERF ${traceId}] stt_wait_verifier reason=echo-risk confidence=${azure.confidence}`);
    }

    if (!whisperSettled) {
      whisperSettled = await whisperPromise;
    }
    const whisper = whisperSettled.status === 'fulfilled' ? whisperSettled.value : null;

    if (azure) {
      console.log(`[🎤 transcribeAudio] Azure: text="${(azure.text || '').slice(0, 60)}"  lang=${azure.language}`);
    } else {
      console.warn('[🎤 transcribeAudio] Azure failed:', azureSettled.reason?.message);
    }
    if (whisper) {
      console.log(`[🎤 transcribeAudio] Whisper: text="${(whisper.text || '').slice(0, 60)}"  lang=${whisper.language}`);
    } else {
      console.warn('[🎤 transcribeAudio] Whisper failed:', whisperSettled.reason?.message);
    }

    // If both failed, throw
    if (!azure && !whisper) {
      throw azureSettled.reason || whisperSettled.reason || new Error('Both STT providers failed');
    }

    // If only one succeeded, use it
    if (!azure) {
      return {
        ...whisper,
        provider: 'whisper-only',
        timings: {
          azureMs: null,
          whisperMs: whisper.timings?.clientMs || null,
          totalMs: Date.now() - startedAt,
          earlyAzure: false,
        },
      };
    }
    if (!whisper) {
      const totalMs = Date.now() - startedAt;
      console.warn(
        `[PERF ${traceId}] stt_unverified provider=azure confidence=${azure.confidence} verifierError="${whisperSettled.reason?.message || 'unknown'}"`
      );
      return {
        ...azure,
        provider: 'azure-unverified',
        timings: {
          azureMs: azure.timings?.clientMs || null,
          whisperMs: null,
          totalMs,
          earlyAzure: false,
          verifierFailed: true,
        },
      };
    }

    // Both succeeded — pick the best
    let chosen = chooseVerifiedSttResult(azure, whisper, srcLang, tgtLang);
    if (shouldRunVietnameseVerifier(chosen, srcLang, tgtLang)) {
      try {
        console.log(`[PERF ${traceId}] stt_forced_vi_verifier_started text="${(chosen.text || '').slice(0, 50)}" provider=${chosen.provider}`);
        const forcedVietnamese = await transcribeAudioWhisperOnly({
          audioUri,
          srcLang,
          tgtLang,
          mode,
          requestId: `${traceId}-vi`,
          forcedLanguage: 'vi',
        });
        const revised = chooseForcedVietnameseResult(chosen, forcedVietnamese, srcLang, tgtLang);
        if (revised !== chosen) {
          chosen = revised;
          console.log(`[PERF ${traceId}] stt_forced_vi_selected text="${(chosen.text || '').slice(0, 60)}"`);
        }
      } catch (forcedError) {
        console.warn(`[PERF ${traceId}] stt_forced_vi_failed reason="${forcedError?.message || forcedError}"`);
      }
    }
    const repairedChosen = maybeRepairVietnameseResult(chosen, srcLang, tgtLang);
    if (repairedChosen !== chosen) {
      chosen = repairedChosen;
      console.log(`[PERF ${traceId}] stt_vi_text_repaired text="${(chosen.text || '').slice(0, 60)}"`);
    }
    const totalMs = Date.now() - startedAt;
    const chosenProvider = chosen === azure && whisper?.text
      ? 'azure-verified'
      : chosen.provider;
    console.log(`[PERF ${traceId}] stt_chosen provider=${chosenProvider} lang=${chosen.language} totalMs=${totalMs}`);
    return {
      ...chosen,
      provider: chosenProvider,
      timings: {
        azureMs: azure.timings?.clientMs || null,
        whisperMs: whisper.timings?.clientMs || null,
        totalMs,
        earlyAzure: false,
      },
    };
  }

  // Standard mode: Azure only, Whisper as fallback
  try {
    return await postSpeechAudio({
      endpoint: '/api/azure/stt',
      audioUri,
      srcLang,
      tgtLang,
      mode,
      requestId: traceId,
    });
  } catch (primaryError) {
    if (fallbackProvider !== 'whisper') {
      throw primaryError;
    }

    console.warn('Primary STT provider failed (azure), falling back to whisper:', primaryError);
    return transcribeAudioWhisperOnly({
      audioUri,
      srcLang,
      tgtLang,
      mode,
      requestId: traceId,
    });
  }
}

/**
 * Fetch Text-to-Speech (TTS) Neural Voice binary stream
 */
export async function getTtsAudioUrl({ text, lang, voice, provider, requestId = null }) {
  const baseUrl = await getApiBaseUrl();
  const params = new URLSearchParams({
    text,
    lang,
    voice,
    provider: provider || 'azure',
  });
  if (requestId) params.set('requestId', requestId);
  return `${baseUrl}/api/tts?${params.toString()}`;
}

export async function getTtsAudioSource({ text, lang, voice, provider, requestId = null }) {
  return {
    uri: await getTtsAudioUrl({ text, lang, voice, provider, requestId }),
    headers: await withAuthHeaders(requestId ? { 'X-Request-ID': requestId } : {}),
  };
}

/**
 * Save panel-specific settings securely
 */
export async function saveModeSettings(mode, settings) {
  try {
    await SecureStore.setItemAsync(`vt_mobile_settings_${mode}`, JSON.stringify(settings));
  } catch (e) {
    console.warn(`Failed to save settings for mode ${mode}:`, e);
  }
}

/**
 * Load panel-specific settings securely
 */
export async function getModeSettings(mode) {
  try {
    const saved = await SecureStore.getItemAsync(`vt_mobile_settings_${mode}`);
    return saved ? JSON.parse(saved) : null;
  } catch (e) {
    console.warn(`Failed to load settings for mode ${mode}:`, e);
    return null;
  }
}

/**
 * Get saved app theme ('dark' | 'light')
 */
export async function getAppTheme() {
  try {
    return await SecureStore.getItemAsync('vt_app_theme') || 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Save app theme ('dark' | 'light')
 */
export async function saveAppTheme(theme) {
  await SecureStore.setItemAsync('vt_app_theme', theme || 'dark');
}
