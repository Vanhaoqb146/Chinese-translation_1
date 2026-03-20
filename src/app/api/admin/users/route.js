import { NextResponse } from 'next/server';
import { getUsers, toggleUserStatus, createUser } from '@/lib/auth';

// GET — Lấy danh sách người dùng
export async function GET() {
  try {
    const users = await getUsers();
    const safeUsers = users.map(({ password, ...u }) => u);
    return NextResponse.json({ users: safeUsers }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Lỗi khi tải danh sách người dùng' }, { status: 500 });
  }
}

// POST — Tạo tài khoản mới
export async function POST(request) {
  try {
    const body = await request.json();
    const { username, password, name, unit, role } = body;

    if (!username || !password || !name) {
      return NextResponse.json({ error: 'Thiếu thông tin bắt buộc (username, password, name)' }, { status: 400 });
    }

    const result = await createUser({ username, password, name, unit, role });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    return NextResponse.json({ message: 'Tạo tài khoản thành công', id: result.id }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Lỗi server' }, { status: 500 });
  }
}

// PATCH — Bật/tắt trạng thái tài khoản
export async function PATCH(request) {
  try {
    const { userId, isActive } = await request.json();

    if (!userId || typeof isActive !== 'boolean') {
      return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
    }

    const success = await toggleUserStatus(userId, isActive);

    if (success) {
      return NextResponse.json({ message: 'Cập nhật trạng thái thành công' }, { status: 200 });
    } else {
      return NextResponse.json({ error: 'Không thể cập nhật (Tài khoản Admin gốc không được phép khóa)' }, { status: 403 });
    }
  } catch (error) {
    return NextResponse.json({ error: 'Lỗi server' }, { status: 500 });
  }
}