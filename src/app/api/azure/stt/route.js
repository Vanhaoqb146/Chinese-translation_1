import { requireAuth } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const AZURE_FAST_TRANSCRIPTION_API_VERSION = process.env.AZURE_STT_API_VERSION || '2024-11-15';
const LANG_TO_LOCALE = {
  zh: 'zh-CN',
  vi: 'vi-VN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

function toAzureLocale(lang) {
  if (!lang || typeof lang !== 'string') return null;
  if (lang.includes('-')) return lang;
  return LANG_TO_LOCALE[lang.toLowerCase()] || null;
}

function normalizeDetectedLanguage(locale) {
  return typeof locale === 'string' && locale !== 'Unknown'
    ? locale.split('-')[0].toLowerCase()
    : null;
}

function getAudioName(audioFile) {
  return audioFile?.name || 'speech.m4a';
}

function isWavAudio(audioFile) {
  const name = getAudioName(audioFile).toLowerCase();
  const type = (audioFile?.type || '').toLowerCase();
  return name.endsWith('.wav') || type === 'audio/wav' || type === 'audio/x-wav';
}

function getAzureSpeechEndpoint(region) {
  const configured = process.env.AZURE_SPEECH_ENDPOINT || process.env.AZURE_STT_ENDPOINT;
  return (configured || `https://${region}.api.cognitive.microsoft.com`).replace(/\/$/, '');
}

function getCandidateLocales(srcLang, tgtLang, mode) {
  const srcLocale = toAzureLocale(srcLang);
  const tgtLocale = toAzureLocale(tgtLang);
  const primaryLocale = srcLocale || tgtLocale || 'vi-VN';
  const locales = mode === 'conversation'
    ? [...new Set([srcLocale, tgtLocale].filter(Boolean))]
    : [primaryLocale];

  return {
    primaryLocale,
    locales: locales.length ? locales : [primaryLocale],
  };
}

function getFastTranscriptText(data) {
  const combinedText = data?.combinedPhrases
    ?.map((phrase) => phrase.text)
    .filter(Boolean)
    .join(' ')
    .trim();

  if (combinedText) return combinedText;

  return data?.phrases
    ?.map((phrase) => phrase.text)
    .filter(Boolean)
    .join(' ')
    .trim() || '';
}

function getFastDetectedLocale(data, fallbackLocale) {
  const totals = new Map();
  for (const phrase of data?.phrases || []) {
    const locale = phrase.locale || phrase.language;
    if (!locale || locale === 'Unknown') continue;
    const weight = Number(phrase.durationMilliseconds || phrase.duration || 1);
    totals.set(locale, (totals.get(locale) || 0) + (Number.isFinite(weight) ? weight : 1));
  }

  if (totals.size === 0) return fallbackLocale;

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])[0][0];
}

function getFastConfidence(data) {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const phrase of data?.phrases || []) {
    const confidence = Number(phrase.confidence);
    if (!Number.isFinite(confidence)) continue;
    const duration = Number(phrase.durationMilliseconds || phrase.duration || 1);
    const weight = Number.isFinite(duration) && duration > 0 ? duration : 1;
    weightedTotal += confidence * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedTotal / totalWeight : null;
}

async function transcribeFast({ audioFile, key, region, locales, requestId }) {
  const endpoint = getAzureSpeechEndpoint(region);
  const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${AZURE_FAST_TRANSCRIPTION_API_VERSION}`;
  const definition = {
    locales,
    profanityFilterMode: 'None',
    channels: [0],
  };

  const azureForm = new FormData();
  azureForm.append('audio', audioFile, getAudioName(audioFile));
  azureForm.append(
    'definition',
    new Blob([JSON.stringify(definition)], { type: 'application/json' }),
    'definition.json'
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
    },
    body: azureForm,
    signal: AbortSignal.timeout(55_000),
  });

  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {}

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || responseText || `HTTP ${response.status}`;
    throw new Error(`Azure Fast Transcription failed: ${detail}`);
  }

  const rawDetectedLocale = getFastDetectedLocale(data, null);
  const detectedLocale = locales.includes(rawDetectedLocale)
    ? rawDetectedLocale
    : null;
  console.log(`[Azure STT][${requestId}] Fast Transcription result:`, {
    locales,
    rawDetectedLocale,
    detectedLocale,
    text: (getFastTranscriptText(data) || '').slice(0, 80),
    phrases: (data?.phrases || []).map(p => ({
      text: (p.text || '').slice(0, 40),
      locale: p.locale,
      confidence: p.confidence,
      durationMs: p.durationMilliseconds,
    })),
  });
  return {
    text: getFastTranscriptText(data),
    detectedLocale,
    confidence: getFastConfidence(data),
  };
}

function recognizeOnce(recognizer) {
  return new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      (result) => {
        try { recognizer.close(); } catch {}
        resolve(result);
      },
      (error) => {
        try { recognizer.close(); } catch {}
        reject(error);
      }
    );
  });
}

async function transcribeWavWithSdk({ audioFile, key, region, locales, primaryLocale, mode }) {
  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '2000');

  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  const audioConfig = sdk.AudioConfig.fromWavFileInput(audioBuffer, getAudioName(audioFile));

  let recognizer;
  if (mode === 'conversation' && locales.length > 1) {
    const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(locales);
    recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetectConfig, audioConfig);
  } else {
    speechConfig.speechRecognitionLanguage = primaryLocale;
    recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  }

  const result = await recognizeOnce(recognizer);
  const detectedLocale = result.properties?.getProperty?.(
    sdk.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
  ) || primaryLocale;

  if (result.reason === sdk.ResultReason.NoMatch) {
    return { text: '', detectedLocale: null };
  }

  if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
    const cancellation = sdk.CancellationDetails.fromResult(result);
    throw new Error(cancellation?.errorDetails || 'Azure Speech SDK failed');
  }

  return {
    text: (result.text || '').trim(),
    detectedLocale,
    confidence: null,
  };
}

export async function POST(request) {
  const startedAt = Date.now();
  const requestId = request.headers.get('x-request-id') || `azure-${startedAt.toString(36)}`;
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const limit = enforceRateLimit(request, {
    name: 'azure-stt',
    user: auth.user,
    limit: 40,
    windowMs: 60_000,
  });
  if (limit.response) return limit.response;

  const headers = {
    ...noStoreHeaders(),
    ...rateLimitHeaders(limit.result),
    'X-Request-ID': requestId,
  };

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return jsonError('Azure Speech credentials not configured', { status: 500, headers });
  }

  try {
    const parseStartedAt = Date.now();
    const formData = await request.formData();
    const parseMs = Date.now() - parseStartedAt;
    const audioFile = formData.get('audio');
    const srcLang = formData.get('srcLang') || '';
    const tgtLang = formData.get('tgtLang') || '';
    const mode = formData.get('mode') || 'standard';

    if (!audioFile || typeof audioFile.arrayBuffer !== 'function') {
      return jsonError('No audio file', { status: 400, headers });
    }

    if (audioFile.size && audioFile.size > MAX_AUDIO_BYTES) {
      return jsonError('Audio file is too large', { status: 413, headers });
    }

    const { primaryLocale, locales } = getCandidateLocales(srcLang, tgtLang, mode);
    console.log(`[Azure STT][${requestId}] Request: srcLang=${srcLang} tgtLang=${tgtLang} mode=${mode} file=${getAudioName(audioFile)} size=${audioFile.size || '?'} → locales=${JSON.stringify(locales)}`);
    let result;
    const providerStartedAt = Date.now();

    try {
      result = await transcribeFast({
        audioFile,
        key,
        region,
        locales,
        requestId,
      });
    } catch (fastError) {
      if (!isWavAudio(audioFile)) throw fastError;
      console.warn('Azure Fast Transcription failed for WAV, falling back to Speech SDK:', fastError);
      result = await transcribeWavWithSdk({ audioFile, key, region, locales, primaryLocale, mode });
    }
    const providerMs = Date.now() - providerStartedAt;
    const totalMs = Date.now() - startedAt;
    console.log(`[Azure STT][${requestId}] timings=${JSON.stringify({ parseMs, providerMs, totalMs })}`);

    return jsonOk(
      {
        text: (result.text || '').trim(),
        language: normalizeDetectedLanguage(result.detectedLocale),
        detectedLocale: result.detectedLocale || null,
        provider: 'azure',
        confidence: result.confidence,
        requestId,
        timings: { parseMs, providerMs, totalMs },
      },
      { headers }
    );
  } catch (error) {
    console.error('Azure STT error:', error);
    return jsonError(error.message || 'Azure STT error', {
      status: 500,
      code: 'AZURE_STT_ERROR',
      headers,
    });
  }
}
