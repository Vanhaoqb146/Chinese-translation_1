export async function POST(request) {
  try {
    const { text, lang } = await request.json();
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return Response.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }
    if (!text || text.trim().length === 0) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }

    // Chọn voice phù hợp theo ngôn ngữ
    // alloy: trung tính, nova: nữ tự nhiên, onyx: nam trầm
    const voiceMap = {
      zh: 'nova',
      vi: 'nova',
      en: 'alloy',
      ja: 'nova',
      ko: 'nova',
    };
    const voice = voiceMap[lang] || 'nova';

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'opus',
        speed: 1.0,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return Response.json(
        { error: errData.error?.message || `TTS API error ${res.status}` },
        { status: res.status }
      );
    }

    // Stream audio response thẳng về browser
    return new Response(res.body, {
      headers: {
        'Content-Type': 'audio/ogg',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    console.error('TTS error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
