import { jsonError } from './apiResponse';

const buckets = globalThis.__voiceTranslateRateLimitBuckets || new Map();
globalThis.__voiceTranslateRateLimitBuckets = buckets;

function getClientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

export function getRateLimitIdentity(request, user) {
  return user?.username || user?.id || getClientIp(request);
}

export function checkRateLimit(request, {
  name = 'api',
  user,
  limit = 60,
  windowMs = 60_000,
} = {}) {
  const now = Date.now();
  const identity = getRateLimitIdentity(request, user);
  const key = `${name}:${identity}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    buckets.set(key, next);
    return {
      ok: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt: next.resetAt,
    };
  }

  current.count += 1;

  return {
    ok: current.count <= limit,
    limit,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.resetAt,
  };
}

export function rateLimitHeaders(result) {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

export function rateLimitResponse(result) {
  return jsonError('Too many requests. Please wait a moment and try again.', {
    status: 429,
    code: 'RATE_LIMITED',
    headers: rateLimitHeaders(result),
  });
}

export function enforceRateLimit(request, options) {
  const result = checkRateLimit(request, options);
  return result.ok ? { result } : { result, response: rateLimitResponse(result) };
}
