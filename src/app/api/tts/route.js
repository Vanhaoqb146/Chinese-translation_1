// Default voice mapping per language
const DEFAULT_VOICES = {
  vi: 'vi-VN-HoaiMyNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

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

/**
 * Normalize text for more natural TTS reading:
 * - Clean up extra spaces/newlines
 * - Normalize common patterns (numbers, dates, etc.)
 */
function normalizeText(text) {
  let t = text.trim();
  // Collapse multiple spaces/newlines
  t = t.replace(/\s+/g, ' ');
  // Remove filler words
  t = t.replace(/\b(uh|um|er|erm)\b/gi, '');
  t = t.replace(/(ừm|ờ|à ơi|ơ)\s*/gi, '');
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
    const { text, lang, voice, voiceId } = await request.json();

    if (!text || text.trim().length === 0) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }

    const azureKey = process.env.AZURE_SPEECH_KEY;
    const azureRegion = process.env.AZURE_SPEECH_REGION;

    if (!azureKey || !azureRegion) {
      console.error('🔊 [Azure TTS] Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION');
      return Response.json(
        { error: 'Azure Speech credentials not configured' },
        { status: 500 }
      );
    }

    // voiceId (from user request) > voice (from frontend) > default by lang
    const selectedVoice = voiceId || voice || DEFAULT_VOICES[lang] || 'en-US-JennyNeural';
    const baseLang = lang || selectedVoice.split('-')[0] || 'en';

    console.log(`🔊 [Azure TTS] voice=${selectedVoice}, lang=${baseLang}, text="${text.slice(0, 60)}..."`);

    // Build conversational SSML
    const { ssml, normalized } = buildConversationalSSML(text, selectedVoice, baseLang);
    console.log(`🔊 [Azure TTS] SSML normalized="${normalized.slice(0, 60)}..."`);

    // Call Azure TTS REST API
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
      console.error(`🔊 [Azure TTS] SSML sent:\n${ssml}`);
      return Response.json(
        { error: `Azure TTS error: ${response.status}` },
        { status: response.status }
      );
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(`🔊 [Azure TTS] Done: ${audioBuffer.byteLength} bytes`);

    if (audioBuffer.byteLength === 0) {
      console.error('🔊 [Azure TTS] ERROR: 0 bytes received');
      return Response.json({ error: 'No audio data received' }, { status: 500 });
    }

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.byteLength.toString(),
      },
    });
  } catch (err) {
    console.error('🔊 [Azure TTS] Error:', err);
    return Response.json({ error: err.message || 'TTS failed' }, { status: 500 });
  }
}
