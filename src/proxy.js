import { NextResponse } from 'next/server';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://chinese-translation1.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function getAllowedOrigins() {
  const configured = (process.env.API_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured, vercelUrl].filter(Boolean));
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return getAllowedOrigins().has(origin);
}

function applyCorsHeaders(request, response) {
  const origin = request.headers.get('origin');

  if (origin && isAllowedOrigin(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    response.headers.set('Access-Control-Allow-Origin', '*');
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  response.headers.set('Access-Control-Max-Age', '86400');
  response.headers.set('Vary', 'Origin');
  return response;
}

export function proxy(request) {
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  if (request.method === 'OPTIONS') {
    const status = isAllowedOrigin(request.headers.get('origin')) ? 204 : 403;
    return applyCorsHeaders(request, new NextResponse(null, { status }));
  }

  return applyCorsHeaders(request, NextResponse.next());
}

export const config = {
  matcher: '/api/:path*',
};
