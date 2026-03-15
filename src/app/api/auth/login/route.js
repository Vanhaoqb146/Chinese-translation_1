import { authenticate } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Vui lòng cung cấp tài khoản và mật khẩu.' },
        { status: 400 }
      );
    }

    const user = await authenticate(username, password);

    // Xử lý logic chặn truy cập
    if (user && user.locked) {
      return NextResponse.json(
        { error: 'Tài khoản của bạn đã bị Admin vô hiệu hóa. Vui lòng liên hệ quản trị viên.' },
        { status: 403 }
      );
    }

    if (user) {
      // User authenticated successfully
      return NextResponse.json(
        { message: 'Đăng nhập thành công', user },
        { status: 200 }
      );
    } else {
      // Invalid credentials
      return NextResponse.json(
        { error: 'Tài khoản hoặc mật khẩu không chính xác.' },
        { status: 401 }
      );
    }
  } catch (error) {
    console.error('Login Error:', error);
    return NextResponse.json(
      { error: 'Đã xảy ra lỗi hệ thống.' },
      { status: 500 }
    );
  }
}