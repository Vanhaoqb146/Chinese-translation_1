import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/apiResponse';

export async function GET(request) {
  const user = await getCurrentUser(request);
  if (!user) {
    return jsonError('Authentication required.', {
      status: 401,
      code: 'UNAUTHORIZED',
      headers: noStoreHeaders(),
    });
  }

  return jsonOk({ user }, { headers: noStoreHeaders() });
}
