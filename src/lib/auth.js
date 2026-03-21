import { sql } from '@vercel/postgres';

/**
 * Lấy tất cả users (dùng Postgres thay JSON)
 */
export async function getUsers() {
  try {
    const { rows } = await sql`SELECT * FROM users ORDER BY id ASC`;
    // Map column names (snake_case → camelCase)
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      password: r.password,
      role: r.role,
      name: r.name,
      unit: r.unit,
      avatar: r.avatar,
      isActive: r.is_active,
    }));
  } catch (error) {
    console.error('Error reading users from DB:', error);
    return [];
  }
}

/**
 * Xác thực đăng nhập
 */
export async function authenticate(username, password) {
  const users = await getUsers();
  const user = users.find(u => u.username === username && u.password === password);

  if (user) {
    if (user.isActive === false) return { locked: true };
    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }
  return null;
}

/**
 * Admin: Bật/Tắt truy cập user
 */
export async function toggleUserStatus(userId, isActive) {
  try {
    // Không cho khóa admin
    const { rows } = await sql`SELECT role FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return false;
    if (rows[0].role === 'admin') return false;

    await sql`UPDATE users SET is_active = ${isActive} WHERE id = ${userId}`;
    return true;
  } catch (error) {
    console.error('toggleUserStatus error:', error);
    return false;
  }
}

/**
 * Admin: Tạo user mới
 */
export async function createUser({ username, password, name, unit, role }) {
  try {
    // Check trùng username
    const { rows: existing } = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (existing.length > 0) return { error: 'Tài khoản đã tồn tại' };

    const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;
    const { rows } = await sql`
      INSERT INTO users (username, password, name, unit, role, avatar, is_active)
      VALUES (${username}, ${password}, ${name}, ${unit || ''}, ${role || 'user'}, ${avatar}, true)
      RETURNING id
    `;
    return { success: true, id: rows[0].id };
  } catch (error) {
    console.error('createUser error:', error);
    return { error: error.message };
  }
}

/**
 * User: Tự đổi mật khẩu (cần xác minh mật khẩu cũ)
 */
export async function changePassword(userId, oldPassword, newPassword) {
  try {
    // Lấy password hiện tại
    const { rows } = await sql`SELECT password FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { error: 'Tài khoản không tồn tại' };

    // Xác minh mật khẩu cũ
    if (rows[0].password !== oldPassword) {
      return { error: 'Mật khẩu hiện tại không chính xác' };
    }

    // Validate mật khẩu mới
    if (!newPassword || newPassword.length < 3) {
      return { error: 'Mật khẩu mới phải có ít nhất 3 ký tự' };
    }
    if (newPassword === oldPassword) {
      return { error: 'Mật khẩu mới không được trùng với mật khẩu cũ' };
    }

    // Cập nhật
    await sql`UPDATE users SET password = ${newPassword} WHERE id = ${userId}`;
    return { success: true };
  } catch (error) {
    console.error('changePassword error:', error);
    return { error: error.message };
  }
}

/**
 * Admin: Đặt lại mật khẩu cho user (không cần mật khẩu cũ)
 */
export async function adminResetPassword(userId, newPassword) {
  try {
    // Không cho reset password admin khác
    const { rows } = await sql`SELECT role FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { error: 'Tài khoản không tồn tại' };
    if (rows[0].role === 'admin') return { error: 'Không thể đặt lại mật khẩu tài khoản Admin' };

    if (!newPassword || newPassword.length < 3) {
      return { error: 'Mật khẩu mới phải có ít nhất 3 ký tự' };
    }

    await sql`UPDATE users SET password = ${newPassword} WHERE id = ${userId}`;
    return { success: true };
  } catch (error) {
    console.error('adminResetPassword error:', error);
    return { error: error.message };
  }
}