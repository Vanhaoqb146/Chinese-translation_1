import fs from 'fs/promises';
import path from 'path';

const dataFilePath = path.join(process.cwd(), 'data', 'users.json');

// Biến lưu trữ dữ liệu trên RAM để giả lập thay đổi trạng thái trên Vercel
let memUsers = null;

/**
 * Reads and parses the users mock data.
 * @returns {Promise<Array>} List of users
 */
export async function getUsers() {
  // Chỉ đọc file 1 lần đầu tiên, sau đó dùng dữ liệu trên RAM
  if (!memUsers) {
    try {
      const fileContents = await fs.readFile(dataFilePath, 'utf8');
      memUsers = JSON.parse(fileContents);
    } catch (error) {
      console.error('Error reading users data:', error);
      return [];
    }
  }
  return memUsers;
}

/**
 * Authenticates a user by username and password.
 */
export async function authenticate(username, password) {
  const users = await getUsers();
  const user = users.find((u) => u.username === username && u.password === password);

  if (user) {
    // Nếu tài khoản bị Admin vô hiệu hóa, trả về cờ locked
    if (user.isActive === false) return { locked: true };

    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  return null;
}

/**
 * [HÀM MỚI] Admin dùng để Bật/Tắt quyền truy cập của User
 */
export async function toggleUserStatus(userId, isActive) {
  const users = await getUsers();
  const userIndex = users.findIndex(u => u.id === userId);

  if (userIndex !== -1) {
    // Không cho phép tự khóa tài khoản Admin số 1 để tránh lỗi mất quyền
    if (users[userIndex].role === 'admin') return false;

    users[userIndex].isActive = isActive;
    return true;
  }
  return false;
}