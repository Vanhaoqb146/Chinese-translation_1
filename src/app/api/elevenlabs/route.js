/**
 * ElevenLabs API proxy — Cung cấp token 1 lần cho STT WebSocket phía client
 * GET → trả về { token } cho Scribe v2 realtime STT
 */
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 500 });
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get ElevenLabs token: ${err}`);
    }

    const data = await res.json();
    return Response.json({ 
      token: data.token,
      wsUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
    });
  } catch (err) {
    console.error('❌ [ElevenLabs Token]', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
