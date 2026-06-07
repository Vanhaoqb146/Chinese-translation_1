import crypto from 'crypto';
import { sql } from '@vercel/postgres';
import { jsonError } from './apiResponse';

export const AUTH_COOKIE_NAME = 'vt_access_token';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_PREFIX = 'pbkdf2_sha256';
const PASSWORD_ITERATIONS = 310_000;
const PASSWORD_KEY_LENGTH = 32;

function normalizeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    password: row.password,
    role: row.role,
    name: row.name,
    unit: row.unit,
    avatar: row.avatar,
    isActive: row.is_active,
  };
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password: _password, ...safeUser } = user;
  return safeUser;
}

function getJwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.OPENAI_API_KEY ||
    process.env.AZURE_SPEECH_KEY ||
    'voice-translate-local-dev-secret'
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signValue(value) {
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(value)
    .digest('base64url');
}

export function signAccessToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({
    sub: user.username,
    userId: user.id,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
  const body = `${header}.${payload}`;
  return `${body}.${signValue(body)}`;
}

export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const body = `${header}.${payload}`;
  const expected = signValue(body);

  try {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function setAuthCookie(response, token) {
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS,
  });
}

export function clearAuthCookie(response) {
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

function getCookieValue(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map((part) => part.trim());
  const match = cookies.find((part) => part.startsWith(`${name}=`));
  if (!match) return '';
  return decodeURIComponent(match.slice(name.length + 1));
}

export function getAuthToken(request) {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return getCookieValue(request, AUTH_COOKIE_NAME);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto
    .pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, 'sha256')
    .toString('base64url');
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function isHashedPassword(storedPassword) {
  return typeof storedPassword === 'string' && storedPassword.startsWith(`${PASSWORD_PREFIX}$`);
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;

  if (!isHashedPassword(storedPassword)) {
    return storedPassword === password;
  }

  const [, iterationsRaw, salt, storedHash] = storedPassword.split('$');
  const iterations = Number(iterationsRaw);
  if (!iterations || !salt || !storedHash) return false;

  const candidate = crypto
    .pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, 'sha256')
    .toString('base64url');

  const candidateBuffer = Buffer.from(candidate);
  const storedBuffer = Buffer.from(storedHash);
  return (
    candidateBuffer.length === storedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, storedBuffer)
  );
}

async function upgradePasswordIfNeeded(user, plainPassword) {
  if (!user || isHashedPassword(user.password)) return;
  const nextHash = hashPassword(plainPassword);
  await sql`UPDATE users SET password = ${nextHash} WHERE id = ${user.id}`;
}

export async function getUsers() {
  try {
    const { rows } = await sql`SELECT * FROM users ORDER BY id ASC`;
    return rows.map(normalizeUserRow);
  } catch (error) {
    console.error('Error reading users from DB:', error);
    return [];
  }
}

export async function getUserById(userId) {
  const { rows } = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
  return normalizeUserRow(rows[0]);
}

export async function getUserByUsername(username) {
  const { rows } = await sql`SELECT * FROM users WHERE username = ${username} LIMIT 1`;
  return normalizeUserRow(rows[0]);
}

export async function authenticate(username, password) {
  const user = await getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password)) return null;
  if (user.isActive === false) return { locked: true };

  await upgradePasswordIfNeeded(user, password);
  return sanitizeUser(user);
}

export async function getCurrentUser(request) {
  const token = getAuthToken(request);
  const payload = verifyAccessToken(token);
  if (!payload?.userId) return null;

  const user = await getUserById(payload.userId);
  if (!user || user.isActive === false) return null;
  return sanitizeUser(user);
}

export async function requireAuth(request) {
  const user = await getCurrentUser(request);
  if (!user) {
    return {
      response: jsonError('Authentication required.', {
        status: 401,
        code: 'UNAUTHORIZED',
      }),
    };
  }
  return { user };
}

export async function requireAdmin(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth;
  if (auth.user.role !== 'admin') {
    return {
      response: jsonError('Admin permission required.', {
        status: 403,
        code: 'FORBIDDEN',
      }),
    };
  }
  return auth;
}

export async function toggleUserStatus(userId, isActive) {
  try {
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

export async function createUser({ username, password, name, unit, role }) {
  try {
    const { rows: existing } = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (existing.length > 0) return { error: 'Tai khoan da ton tai' };

    const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;
    const passwordHash = hashPassword(password);
    const { rows } = await sql`
      INSERT INTO users (username, password, name, unit, role, avatar, is_active)
      VALUES (${username}, ${passwordHash}, ${name}, ${unit || ''}, ${role || 'user'}, ${avatar}, true)
      RETURNING id
    `;
    return { success: true, id: rows[0].id };
  } catch (error) {
    console.error('createUser error:', error);
    return { error: error.message };
  }
}

export async function changePassword(userId, oldPassword, newPassword) {
  try {
    const user = await getUserById(userId);
    if (!user) return { error: 'Tai khoan khong ton tai' };

    if (!verifyPassword(oldPassword, user.password)) {
      return { error: 'Mat khau hien tai khong chinh xac' };
    }

    if (!newPassword || newPassword.length < 3) {
      return { error: 'Mat khau moi phai co it nhat 3 ky tu' };
    }
    if (newPassword === oldPassword) {
      return { error: 'Mat khau moi khong duoc trung voi mat khau cu' };
    }

    await sql`UPDATE users SET password = ${hashPassword(newPassword)} WHERE id = ${userId}`;
    return { success: true };
  } catch (error) {
    console.error('changePassword error:', error);
    return { error: error.message };
  }
}

export async function adminResetPassword(userId, newPassword) {
  try {
    const { rows } = await sql`SELECT role FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { error: 'Tai khoan khong ton tai' };
    if (rows[0].role === 'admin') return { error: 'Khong the dat lai mat khau tai khoan Admin' };

    if (!newPassword || newPassword.length < 3) {
      return { error: 'Mat khau moi phai co it nhat 3 ky tu' };
    }

    await sql`UPDATE users SET password = ${hashPassword(newPassword)} WHERE id = ${userId}`;
    return { success: true };
  } catch (error) {
    console.error('adminResetPassword error:', error);
    return { error: error.message };
  }
}
