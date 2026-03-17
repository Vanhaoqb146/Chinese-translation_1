import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

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
    const { text, lang, voice } = await request.json();

    if (!text || text.trim().length === 0) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }

    const selectedVoice = voice || DEFAULT_VOICES[lang] || 'en-US-JennyNeural';

    console.log(`🔊 [Edge TTS] voice=${selectedVoice}, text="${text.slice(0, 60)}..."`);

    const tts = new MsEdgeTTS();
    await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    // Get audio stream — in-memory, no file I/O
    const { audioStream } = tts.toStream(text);

    // Collect all chunks into Buffer
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }

    const audioBuffer = Buffer.concat(chunks);
    console.log(`🔊 [Edge TTS] Done: ${audioBuffer.length} bytes`);

    if (audioBuffer.length === 0) {
      console.error('🔊 [Edge TTS] ERROR: 0 bytes received — voice may not exist');
      return Response.json({ error: 'No audio data received' }, { status: 500 });
    }

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
      },
    });
  } catch (err) {
    console.error('TTS error:', err);
    return Response.json({ error: err.message || 'TTS failed' }, { status: 500 });
  }
}
