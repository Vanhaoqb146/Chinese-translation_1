import { requireAuth } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const limit = enforceRateLimit(request, {
    name: 'azure-token',
    user: auth.user,
    limit: 60,
    windowMs: 60_000,
  });
  if (limit.response) return limit.response;

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return jsonError('AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not configured', { status: 500 });
  }

  try {
    const tokenRes = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Length': '0',
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const token = await tokenRes.text();
    return jsonOk(
      { token, region },
      {
        headers: {
          ...noStoreHeaders(),
          ...rateLimitHeaders(limit.result),
        },
      }
    );
  } catch (err) {
    console.error('Azure token error:', err);
    return jsonError(err.message, { status: 500 });
  }
}
