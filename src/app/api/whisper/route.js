import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import {
  detectSttTextLanguage,
  findWhisperHallucination,
  normalizeSttLanguage,
} from '@/lib/sttTextPolicy.mjs';

export const maxDuration = 60;

// =============================================
// [LƯỚI LỌC THÉP] — Aggressive Hallucination Filter
// =============================================

// Bản đồ mã ngôn ngữ app → mã ISO 639-1 cho Whisper
const LANG_TO_ISO = { vi: 'vi', zh: 'zh', en: 'en', ja: 'ja', ko: 'ko' };
const CJK_KANA_HANGUL_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const VIETNAMESE_STT_PROMPT = [
  'Tieng Viet hoi thoai co dau:',
  'ch\u00e0o c\u00e1c b\u1ea1n',
  't\u00f4i \u0111\u1ebfn t\u1eeb Vi\u1ec7t Nam',
  'c\u1ea3m \u01a1n c\u00e1c b\u1ea1n \u0111\u00e3 ch\u00fa \u00fd l\u1eafng nghe',
  'r\u1ea5t vui \u0111\u01b0\u1ee3c g\u1eb7p m\u1ecdi ng\u01b0\u1eddi',
].join(' ');

function allowClientApiKeys() {
  return process.env.ALLOW_CLIENT_API_KEYS === 'true' || process.env.NODE_ENV !== 'production';
}

function timedJson(body, {
  status = 200,
  startedAt,
  timings = {},
  headers = {},
  requestId,
}) {
  const totalMs = Date.now() - startedAt;
  const responseTimings = { ...timings, totalMs };
  const serverTiming = [
    ...Object.entries(timings).map(([name, duration]) => (
      `${name.replace(/Ms$/, '')};dur=${Math.max(0, Math.round(duration))}`
    )),
    `total;dur=${Math.max(0, Math.round(totalMs))}`,
  ].join(', ');

  return NextResponse.json(
    { ok: status < 400, ...body, requestId, timings: responseTimings },
    {
      status,
      headers: {
        'Server-Timing': serverTiming,
        'X-Request-ID': requestId,
        ...headers,
      },
    }
  );
}

export async function POST(request) {
  const startedAt = Date.now();
  const requestId = request.headers.get('x-request-id') || `whisper-${startedAt.toString(36)}`;
  let parseMs = 0;
  let providerMs = 0;
  try {
    const auth = await requireAuth(request);
    if (auth.response) return auth.response;

    const limit = enforceRateLimit(request, {
      name: 'whisper',
      user: auth.user,
      limit: 40,
      windowMs: 60_000,
    });
    if (limit.response) return limit.response;

    const parseStartedAt = Date.now();
    const formData = await request.formData();
    parseMs = Date.now() - parseStartedAt;
    const audioFile = formData.get('audio');
    const clientApiKey = formData.get('apiKey') || '';
    const apiKey = process.env.OPENAI_API_KEY || (allowClientApiKeys() ? clientApiKey : '');
    const srcLang = formData.get('srcLang') || '';
    const tgtLang = formData.get('tgtLang') || '';
    // mode: 'standard' = ép ngôn ngữ src; 'conversation' = tự phát hiện ngôn ngữ
    const mode = formData.get('mode') || 'standard';

    if (!audioFile) {
      return timedJson(
        { error: 'No audio file' },
        { status: 400, startedAt, timings: { parseMs }, requestId }
      );
    }
    if (audioFile.size && audioFile.size > MAX_AUDIO_BYTES) {
      return timedJson(
        { error: 'Audio file is too large' },
        { status: 413, startedAt, timings: { parseMs }, requestId }
      );
    }
    if (!apiKey) {
      return timedJson(
        { error: 'No API key configured on server.' },
        { status: 500, startedAt, timings: { parseMs }, requestId }
      );
    }

    const whisperForm = new FormData();
    const originalName = audioFile.name || 'audio.webm';
    const ext = originalName.split('.').pop() || 'webm';
    whisperForm.append('file', audioFile, `audio.${ext}`);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('temperature', '0.0');

    if (mode === 'conversation') {
      // [CONVERSATION MODE] Không ép ngôn ngữ — để Whisper tự phát hiện
      // Dùng verbose_json để nhận lại trường "language" trong response
      whisperForm.append('response_format', 'verbose_json');
    } else {
      // [STANDARD MODE] Ép ngôn ngữ nguồn để tăng chính xác
      if (srcLang && LANG_TO_ISO[srcLang]) {
        whisperForm.append('language', LANG_TO_ISO[srcLang]);
      }
      if (srcLang === 'vi') {
        whisperForm.append('prompt', VIETNAMESE_STT_PROMPT);
      }
    }

    const providerStartedAt = Date.now();
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: whisperForm,
      signal: AbortSignal.timeout(60000), // 60s timeout cho file WAV lớn (~5MB)
    });
    providerMs = Date.now() - providerStartedAt;

    if (!res.ok) {
      const err = await res.text();
      return timedJson(
        { error: 'Whisper API failed', detail: err },
        {
          status: res.status,
          startedAt,
          timings: { parseMs, providerMs },
          headers: rateLimitHeaders(limit.result),
          requestId,
        }
      );
    }

    const data = await res.json();
    let text = (data.text || '').trim();
    const requestedLangs = [srcLang, tgtLang].map(normalizeSttLanguage).filter(Boolean);
    const detectedLang = normalizeSttLanguage(data.language);
    const textLang = detectSttTextLanguage(text, requestedLangs);
    const hallucinationMatch = findWhisperHallucination(text);

    // Only explicit video/subscription boilerplate is blocked. Generic phrases
    // such as "Cảm ơn các bạn" are valid conversation and must be preserved.
    if (hallucinationMatch) {
      console.log(`🚫 [Whisper Filter] Blocked hallucination "${hallucinationMatch}": "${text}"`);
      return timedJson(
        { text: '', language: null },
        {
          startedAt,
          timings: { parseMs, providerMs },
          headers: rateLimitHeaders(limit.result),
          requestId,
        }
      );
    }

    // Match the web app: visible script/diacritics are more reliable than a
    // provider language label when the two disagree.
    let resolvedLang = textLang || detectedLang;
    if (detectedLang && !requestedLangs.includes(detectedLang)) {
      if (textLang && requestedLangs.includes(textLang)) {
        console.log(
          `[Whisper Language Override][${requestId}] provider=${data.language} text=${textLang}`
        );
        resolvedLang = textLang;
      } else {
        console.log(`🚫 [Whisper Filter] Blocked language: "${data.language}" — text: "${text}"`);
        return timedJson(
          { text: '', language: null },
          {
            startedAt,
            timings: { parseMs, providerMs },
            headers: rateLimitHeaders(limit.result),
            requestId,
          }
        );
      }
    }

    // ========== BỘ LỌC 3: VĂN BẢN QUÁ NGẮN (≤ 2 ký tự, bỏ qua nếu chứa chữ Trung/Nhật/Hàn) ==========
    const isShortAllowed = CJK_KANA_HANGUL_RE.test(text);
    if (text.length <= 2 && !isShortAllowed) {
      console.log(`🚫 [Whisper Filter] Blocked too-short text: "${text}"`);
      return timedJson(
        { text: '', language: null },
        {
          startedAt,
          timings: { parseMs, providerMs },
          headers: rateLimitHeaders(limit.result),
          requestId,
        }
      );
    }

    // ========== BỘ LỌC 4: VĂN BẢN RỖNG ==========
    if (!text) {
      return timedJson(
        { text: '', language: null },
        {
          startedAt,
          timings: { parseMs, providerMs },
          headers: rateLimitHeaders(limit.result),
          requestId,
        }
      );
    }

    console.log(`[Whisper STT][${requestId}] result:`, {
      language: resolvedLang || data.language || null,
      text: text.slice(0, 80),
    });
    console.log(`[Whisper STT][${requestId}] timings=${JSON.stringify({
      parseMs,
      providerMs,
      totalMs: Date.now() - startedAt,
    })}`);
    return timedJson(
      { text, language: resolvedLang || data.language || null },
      {
        startedAt,
        timings: { parseMs, providerMs },
        headers: rateLimitHeaders(limit.result),
        requestId,
      }
    );
  } catch (err) {
    console.error(`[Whisper STT][${requestId}] error:`, err);
    return timedJson(
      { error: err.message },
      {
        status: 500,
        startedAt,
        timings: { parseMs, providerMs },
        requestId,
      }
    );
  }
}
