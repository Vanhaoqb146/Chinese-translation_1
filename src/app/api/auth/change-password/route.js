import { changePassword, requireAuth } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export async function POST(request) {
  try {
    const auth = await requireAuth(request);
    if (auth.response) return auth.response;

    const limit = enforceRateLimit(request, {
      name: 'auth-change-password',
      user: auth.user,
      limit: 10,
      windowMs: 15 * 60_000,
    });
    if (limit.response) return limit.response;

    const { oldPassword, newPassword } = await request.json();

    if (!oldPassword || !newPassword) {
      return jsonError('Vui long cung cap day du thong tin.', { status: 400 });
    }

    const result = await changePassword(auth.user.id, oldPassword, newPassword);

    if (result.error) {
      return jsonError(result.error, { status: 400 });
    }

    return jsonOk(
      { message: 'Doi mat khau thanh cong' },
      { headers: rateLimitHeaders(limit.result) }
    );
  } catch (error) {
    console.error('Change password error:', error);
    return jsonError('Da xay ra loi he thong.', { status: 500 });
  }
}
