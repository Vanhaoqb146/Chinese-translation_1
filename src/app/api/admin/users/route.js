import { NextResponse } from 'next/server';
import { getUsers, toggleUserStatus } from '@/lib/auth';

export async function GET() {
    try {
        const users = await getUsers();
        // Loại bỏ password trước khi gửi về client để bảo mật
        const safeUsers = users.map(({ password, ...u }) => u);
        return NextResponse.json({ users: safeUsers }, { status: 200 });
    } catch (error) {
        return NextResponse.json({ error: 'Lỗi khi tải danh sách người dùng' }, { status: 500 });
    }
}

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