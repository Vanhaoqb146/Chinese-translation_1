import { authenticate, setAuthCookie, signAccessToken } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export async function POST(request) {
  try {
    const limit = enforceRateLimit(request, {
      name: 'auth-login',
      limit: 20,
      windowMs: 15 * 60_000,
    });
    if (limit.response) return limit.response;

    const { username, password } = await request.json();

    if (!username || !password) {
      return jsonError('Vui long cung cap tai khoan va mat khau.', { status: 400 });
    }

    const user = await authenticate(username, password);

    if (user?.locked) {
      return jsonError('Tai khoan cua ban da bi Admin vo hieu hoa. Vui long lien he quan tri vien.', {
        status: 403,
        code: 'ACCOUNT_LOCKED',
      });
    }

    if (!user) {
      return jsonError('Tai khoan hoac mat khau khong chinh xac.', {
        status: 401,
        code: 'INVALID_CREDENTIALS',
        headers: rateLimitHeaders(limit.result),
      });
    }

    const accessToken = signAccessToken(user);
    const response = jsonOk(
      { message: 'Dang nhap thanh cong', user, accessToken },
      {
        headers: {
          ...noStoreHeaders(),
          ...rateLimitHeaders(limit.result),
        },
      }
    );
    setAuthCookie(response, accessToken);
    return response;
  } catch (error) {
    console.error('Login Error:', error);
    return jsonError('Da xay ra loi he thong.', { status: 500 });
  }
}
