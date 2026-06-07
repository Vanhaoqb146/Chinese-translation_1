import { NextResponse } from 'next/server';

export function jsonOk(data = {}, { status = 200, headers = {} } = {}) {
  return NextResponse.json(
    { ok: true, ...data },
    { status, headers }
  );
}

export function jsonError(error, { status = 500, code, details, headers = {} } = {}) {
  const body = { ok: false, error };
  if (code) body.code = code;
  if (details !== undefined) body.details = details;

  return NextResponse.json(body, { status, headers });
}

export function noStoreHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    ...extra,
  };
}
