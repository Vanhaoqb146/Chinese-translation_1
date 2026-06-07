import { getUsers, toggleUserStatus, createUser, adminResetPassword, requireAdmin } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

async function authorizeAdmin(request, name, limit = 60) {
  const auth = await requireAdmin(request);
  if (auth.response) return auth;

  const rate = enforceRateLimit(request, {
    name,
    user: auth.user,
    limit,
    windowMs: 60_000,
  });
  if (rate.response) return { response: rate.response };

  return { user: auth.user, rate: rate.result };
}

export async function GET(request) {
  try {
    const auth = await authorizeAdmin(request, 'admin-users-get');
    if (auth.response) return auth.response;

    const users = await getUsers();
    const safeUsers = users.map(({ password: _password, ...user }) => user);
    return jsonOk(
      { users: safeUsers },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('Admin users GET error:', error);
    return jsonError('Loi khi tai danh sach nguoi dung', { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = await authorizeAdmin(request, 'admin-users-post', 30);
    if (auth.response) return auth.response;

    const { username, password, name, unit, role } = await request.json();

    if (!username || !password || !name) {
      return jsonError('Thieu thong tin bat buoc (username, password, name)', { status: 400 });
    }

    const result = await createUser({ username, password, name, unit, role });

    if (result.error) {
      return jsonError(result.error, { status: 409 });
    }

    return jsonOk(
      { message: 'Tao tai khoan thanh cong', id: result.id },
      { status: 201, headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('Admin users POST error:', error);
    return jsonError('Loi server', { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const auth = await authorizeAdmin(request, 'admin-users-patch', 60);
    if (auth.response) return auth.response;

    const { userId, isActive } = await request.json();

    if (!userId || typeof isActive !== 'boolean') {
      return jsonError('Du lieu khong hop le', { status: 400 });
    }

    const success = await toggleUserStatus(userId, isActive);

    if (!success) {
      return jsonError('Khong the cap nhat tai khoan nay', { status: 403 });
    }

    return jsonOk(
      { message: 'Cap nhat trang thai thanh cong' },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('Admin users PATCH error:', error);
    return jsonError('Loi server', { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const auth = await authorizeAdmin(request, 'admin-users-put', 30);
    if (auth.response) return auth.response;

    const { userId, newPassword } = await request.json();

    if (!userId || !newPassword) {
      return jsonError('Thieu thong tin (userId, newPassword)', { status: 400 });
    }

    const result = await adminResetPassword(userId, newPassword);

    if (result.error) {
      return jsonError(result.error, { status: 403 });
    }

    return jsonOk(
      { message: 'Dat lai mat khau thanh cong' },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('Admin users PUT error:', error);
    return jsonError('Loi server', { status: 500 });
  }
}
