// Default voice mapping per language
const DEFAULT_VOICES = {
  vi: 'vi-VN-HoaiMyNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

const ELEVENLABS_DEFAULT_VOICES = {
  zh: 'pFZP5JQG7iQjIQuC4Bku', // Lily
  vi: 'pFZP5JQG7iQjIQuC4Bku', // Lily
  en: '21m00Tcm4TlvDq8ikWAM', // Rachel
  ja: 'pFZP5JQG7iQjIQuC4Bku', // Lily
  ko: 'pFZP5JQG7iQjIQuC4Bku', // Lily
};

// Public default voices from ElevenLabs premade list, used as free-plan-safe fallbacks.
const ELEVENLABS_FREE_FALLBACK_VOICE_MALE = 'JBFqnCBsd6RMkjVDRZzb';    // George
const ELEVENLABS_FREE_FALLBACK_VOICE_FEMALE = '21m00Tcm4TlvDq8ikWAM';  // Rachel
const ELEVENLABS_BLOCKED_LIBRARY_VOICES = new Set();

const ELEVENLABS_FEMALE_VOICE_IDS = new Set([
  'pFZP5JQG7iQjIQuC4Bku', // Lily
  '21m00Tcm4TlvDq8ikWAM', // Rachel
  'EXAVITQu4vr4xnSDxMaL', // Sarah
  'cgSgspJ2msm6clMCkdW9', // Jessica
  'XrExE9yKIg1WjnnlVkGX', // Matilda
]);

function pickFreeFallbackVoice(originalVoiceId) {
  return ELEVENLABS_FEMALE_VOICE_IDS.has(originalVoiceId)
    ? ELEVENLABS_FREE_FALLBACK_VOICE_FEMALE
    : ELEVENLABS_FREE_FALLBACK_VOICE_MALE;
}

// Based on ElevenLabs docs: multilingual_v2 does not include Vietnamese, while flash_v2_5 does.
const ELEVENLABS_MULTILINGUAL_V2_LANGS = new Set([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fil', 'fr', 'hi',
  'hr', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk',
  'sv', 'ta', 'tr', 'uk', 'zh',
]);

function normalizeLangCode(lang) {
  return (lang || 'en').toString().split('-')[0].toLowerCase();
}

function selectElevenLabsModel(lang) {
  return ELEVENLABS_MULTILINGUAL_V2_LANGS.has(lang)
    ? 'eleven_multilingual_v2'
    : 'eleven_flash_v2_5';
}

function isLikelyElevenVoiceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{20}$/.test(value.trim());
}

// Detect xml:lang from voice name or lang param
function detectXmlLang(voiceName, lang) {
  if (voiceName) {
    // e.g. "vi-VN-HoaiMyNeural" → "vi-VN", "zh-CN-XiaoxiaoNeural" → "zh-CN"
    const match = voiceName.match(/^([a-z]{2}-[A-Z]{2,4})/);
    if (match) return match[1];
  }
  const map = { vi: 'vi-VN', zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
  return map[lang] || 'en-US';
}

// Check if a voice is Chinese
function isChineseVoice(voiceName, lang) {
  if (voiceName && voiceName.startsWith('zh-')) return true;
  return lang === 'zh';
}

// Escape XML special characters
function escXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeText(text) {
  let t = text.trim();
  // Collapse multiple spaces/newlines
  t = t.replace(/\s+/g, ' ');

  // Remove English filler words (standalone)
  t = t.replace(/\b(uh|um|er|erm)\b/gi, '');
  
  // Remove Vietnamese filler words ONLY when they are standalone words (bounded by spaces or punctuation)
  // We use lookbehind and lookahead to simulate word boundaries for Vietnamese characters
  t = t.replace(/(?<=^|\s|[.,!?])(ừm|ờ|à|ơi|ơ)(?=\s|[.,!?]|$)/gi, '');
  
  // Clean up any double spaces created by removals
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

/**
 * Split text into natural breath segments at punctuation boundaries.
 * Returns an array of { text, breakAfterMs }.
 */
function splitIntoSegments(text, lang) {
  const isChinese = lang === 'zh';

  // Split on sentence-ending punctuation (keep the punctuation)
  let segments = [];

  if (isChinese) {
    // Chinese: split at ，。！？；、
    const parts = text.split(/(?<=[，。！？；、])\s*/);
    for (const part of parts) {
      if (!part.trim()) continue;
      // Determine break duration based on ending punctuation
      let breakMs = 180; // default short break after comma-like
      if (/[。！？]$/.test(part)) breakMs = 300; // longer after sentence end
      else if (/[；]$/.test(part)) breakMs = 250;
      else if (/[，、]$/.test(part)) breakMs = 160;
      segments.push({ text: part.trim(), breakAfterMs: breakMs });
    }
  } else {
    // Vietnamese / others: split at , . ! ? ; :
    const parts = text.split(/(?<=[,\.!?;:])\s*/);
    for (const part of parts) {
      if (!part.trim()) continue;
      let breakMs = 180;
      if (/[.!?]$/.test(part)) breakMs = 300;
      else if (/[;:]$/.test(part)) breakMs = 220;
      else if (/[,]$/.test(part)) breakMs = 160;
      segments.push({ text: part.trim(), breakAfterMs: breakMs });
    }
  }

  // If no splitting happened, use the whole text as one segment
  if (segments.length === 0) {
    segments = [{ text: text.trim(), breakAfterMs: 0 }];
  }

  // Remove break after the very last segment
  if (segments.length > 0) {
    segments[segments.length - 1].breakAfterMs = 0;
  }

  return segments;
}

/**
 * Build rich SSML for Azure TTS with natural conversational prosody.
 */
function buildConversationalSSML(text, voiceName, lang) {
  const xmlLang = detectXmlLang(voiceName, lang);
  const isCN = isChineseVoice(voiceName, lang);
  const normalized = normalizeText(text);
  const segments = splitIntoSegments(normalized, lang);

  // Determine prosody settings
  // Questions get slightly higher pitch
  const isQuestion = /[?？]$/.test(normalized);
  // Polite/thanks/sorry phrases get softer tone
  const isPolite = isCN
    ? /谢谢|感谢|不好意思|对不起|抱歉|请|麻烦/.test(normalized)
    : /cảm ơn|xin lỗi|vui lòng|xin|nhờ|cám ơn|xin chào|chào/.test(normalized.toLowerCase());

  let rate = '-5%';
  let pitch = '+0%';

  if (isQuestion) {
    pitch = '+2%';
    rate = '-4%';
  } else if (isPolite) {
    pitch = '-1%';
    rate = '-6%';
  }

  // Build inner SSML content with breaks between segments
  let innerContent = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    innerContent += `\n        ${escXml(seg.text)}`;
    if (seg.breakAfterMs > 0) {
      innerContent += `\n        <break time="${seg.breakAfterMs}ms"/>`;
    }
  }

  // Build full SSML
  let ssml = `<speak version="1.0"
       xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="http://www.w3.org/2001/mstts"
       xml:lang="${xmlLang}">
  <voice name="${voiceName}">`;

  if (isCN) {
    // Chinese: wrap in mstts:express-as for conversational style
    const style = isPolite ? 'gentle' : 'chat';
    ssml += `
    <mstts:express-as style="${style}">
      <prosody rate="${rate}" pitch="${pitch}">${innerContent}
      </prosody>
    </mstts:express-as>`;
  } else {
    // Vietnamese / others: use prosody only
    ssml += `
    <prosody rate="${rate}" pitch="${pitch}">${innerContent}
    </prosody>`;
  }

  ssml += `
  </voice>
</speak>`;

  return { ssml, normalized };
}

export async function POST(request) {
  try {
    const { text, lang, voice, voiceId, provider = 'azure' } = await request.json();

    if (!text || text.trim().length === 0) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }

    // ========== ELEVENLABS TTS ==========
    if (provider === 'elevenlabs') {
      return await handleElevenLabsTTS(text, lang, voice || voiceId);
    }

    // ========== AZURE TTS (default) ==========
    return await handleAzureTTS(text, lang, voice, voiceId);

  } catch (err) {
    console.error('🔊 [TTS] Error:', err);
    return Response.json({ error: err.message || 'TTS failed' }, { status: 500 });
  }
}

// ==================== AZURE TTS ====================
async function handleAzureTTS(text, lang, voice, voiceId) {
  const azureKey = process.env.AZURE_SPEECH_KEY;
  const azureRegion = process.env.AZURE_SPEECH_REGION;

  if (!azureKey || !azureRegion) {
    console.error('🔊 [Azure TTS] Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION');
    return Response.json({ error: 'Azure Speech credentials not configured' }, { status: 500 });
  }

  const selectedVoice = voiceId || voice || DEFAULT_VOICES[lang] || 'en-US-JennyNeural';
  const baseLang = lang || selectedVoice.split('-')[0] || 'en';

  console.log(`🔊 [Azure TTS] voice=${selectedVoice}, lang=${baseLang}, text="${text.slice(0, 60)}..."`);

  const { ssml, normalized } = buildConversationalSSML(text, selectedVoice, baseLang);
  console.log(`🔊 [Azure TTS] SSML normalized="${normalized.slice(0, 60)}..."`);

  const endpoint = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
      'User-Agent': 'VoiceTranslateAI',
    },
    body: ssml,
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`🔊 [Azure TTS] API error ${response.status}: ${errText}`);
    return Response.json({ error: `Azure TTS error: ${response.status}` }, { status: response.status });
  }

  const audioBuffer = await response.arrayBuffer();
  console.log(`🔊 [Azure TTS] Done: ${audioBuffer.byteLength} bytes`);

  if (audioBuffer.byteLength === 0) {
    return Response.json({ error: 'No audio data received' }, { status: 500 });
  }

  return new Response(audioBuffer, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.byteLength.toString() },
  });
}

// ==================== ELEVENLABS TTS ====================
async function handleElevenLabsTTS(text, lang, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('[ElevenLabs TTS] Missing ELEVENLABS_API_KEY');
    return Response.json({ error: 'ElevenLabs API key not configured' }, { status: 500 });
  }

  const normalizedLang = normalizeLangCode(lang);
  const requestedVoice = (voiceId || '').toString().trim();
  let selectedVoice = isLikelyElevenVoiceId(requestedVoice)
    ? requestedVoice
    : (ELEVENLABS_DEFAULT_VOICES[normalizedLang] || ELEVENLABS_DEFAULT_VOICES.en);
  const selectedModel = selectElevenLabsModel(normalizedLang);

  if (ELEVENLABS_BLOCKED_LIBRARY_VOICES.has(selectedVoice)) {
    selectedVoice = pickFreeFallbackVoice(selectedVoice);
  }

  if (requestedVoice && !isLikelyElevenVoiceId(requestedVoice)) {
    console.warn(`[ElevenLabs TTS] Invalid voice id "${requestedVoice}" -> fallback "${selectedVoice}"`);
  }

  console.log(`[ElevenLabs TTS] voice=${selectedVoice}, model=${selectedModel}, lang=${normalizedLang}, text="${text.slice(0, 60)}..."`);

  const callTTS = async (voice) => {
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: selectedModel,
        language_code: normalizedLang,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.78,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    return response;
  };

  let response = await callTTS(selectedVoice);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const lowerErr = errText.toLowerCase();
    const isLibraryVoicePlanError =
      response.status === 402 &&
      (lowerErr.includes('paid_plan_required') || lowerErr.includes('library voices'));

    const retryVoice = pickFreeFallbackVoice(selectedVoice);
    if (isLibraryVoicePlanError && selectedVoice !== retryVoice) {
      ELEVENLABS_BLOCKED_LIBRARY_VOICES.add(selectedVoice);
      console.warn(
        `[ElevenLabs TTS] Voice "${selectedVoice}" requires paid plan, retry with fallback "${retryVoice}"`
      );
      response = await callTTS(retryVoice);
    } else {
      console.error(`[ElevenLabs TTS] API error ${response.status}: ${errText}`);
      return Response.json(
        { error: `ElevenLabs TTS error ${response.status}${errText ? `: ${errText}` : ''}` },
        { status: response.status }
      );
    }
  }

  if (!response.ok) {
    const retryErrText = await response.text().catch(() => '');
    console.error(`[ElevenLabs TTS] Retry failed ${response.status}: ${retryErrText}`);
    return Response.json(
      { error: `ElevenLabs TTS error ${response.status}${retryErrText ? `: ${retryErrText}` : ''}` },
      { status: response.status }
    );
  }

  const audioBuffer = await response.arrayBuffer();
  console.log(`[ElevenLabs TTS] Done: ${audioBuffer.byteLength} bytes`);

  if (audioBuffer.byteLength === 0) {
    return Response.json({ error: 'No audio data received' }, { status: 500 });
  }

  return new Response(audioBuffer, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.byteLength.toString() },
  });
}

