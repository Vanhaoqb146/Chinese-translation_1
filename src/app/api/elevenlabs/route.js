import { requireAuth } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const limit = enforceRateLimit(request, {
    name: 'elevenlabs-token',
    user: auth.user,
    limit: 60,
    windowMs: 60_000,
  });
  if (limit.response) return limit.response;

  const apiKey = (process.env.ELEVENLABS_API_KEY || '').replace(/['"]/g, '').trim();
  if (!apiKey) {
    return jsonError('ELEVENLABS_API_KEY not configured', { status: 500 });
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get ElevenLabs token: ${err}`);
    }

    const data = await res.json();
    return jsonOk(
      {
        token: data.token,
        wsUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
      },
      {
        headers: {
          ...noStoreHeaders(),
          ...rateLimitHeaders(limit.result),
        },
      }
    );
  } catch (err) {
    console.error('[ElevenLabs Token]', err);
    return jsonError(err.message, { status: 500 });
  }
}
