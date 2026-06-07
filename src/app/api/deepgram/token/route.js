import { requireAuth } from '@/lib/auth';
import { jsonError, noStoreHeaders } from '@/lib/apiResponse';
import { enforceRateLimit } from '@/lib/rateLimit';

export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const limit = enforceRateLimit(request, {
    name: 'deepgram-token',
    user: auth.user,
    limit: 30,
    windowMs: 60_000,
  });
  if (limit.response) return limit.response;

  return jsonError(
    'Deepgram raw API keys are no longer exposed to clients. Configure a secure short-lived token flow before enabling this provider.',
    {
      status: 501,
      code: 'DEEPGRAM_TOKEN_NOT_CONFIGURED',
      headers: noStoreHeaders(),
    }
  );
}
