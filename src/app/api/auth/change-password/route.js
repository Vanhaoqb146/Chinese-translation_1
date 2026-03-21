import { changePassword } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    const { userId, oldPassword, newPassword } = await request.json();

    if (!userId || !oldPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Vui lòng cung cấp đầy đủ thông tin.' },
        { status: 400 }
      );
    }

    const result = await changePassword(userId, oldPassword, newPassword);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(
      { message: 'Đổi mật khẩu thành công' },
      { status: 200 }
    );
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json(
      { error: 'Đã xảy ra lỗi hệ thống.' },
      { status: 500 }
    );
  }
}
