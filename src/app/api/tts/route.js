// Default voice mapping per language
const DEFAULT_VOICES = {
  vi: 'vi-VN-HoaiMyNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

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

    console.log(`🔊 [Azure TTS] voice=${selectedVoice}, text="${text.slice(0, 60)}..."`);

    // Build SSML
    const ssml = `<speak version='1.0' xml:lang='en-US'>
  <voice name='${selectedVoice}'>
    ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}
  </voice>
</speak>`;

    // Call Azure TTS REST API
    const endpoint = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
        'User-Agent': 'MyTranslatorApp',
      },
      body: ssml,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`🔊 [Azure TTS] API error ${response.status}: ${errText}`);
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
