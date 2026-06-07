import { sql } from '@vercel/postgres';
import { requireAuth } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/apiResponse';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

function mapHistoryRow(row) {
  return {
    id: row.id,
    source: row.source_text,
    target: row.target_text,
    fromLang: row.from_lang,
    toLang: row.to_lang,
    createdAt: row.created_at,
    time: new Date(row.created_at).toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Ho_Chi_Minh',
    }),
  };
}

async function authorizeHistory(request, name, limit = 120) {
  const auth = await requireAuth(request);
  if (auth.response) return auth;

  const rate = enforceRateLimit(request, {
    name,
    user: auth.user,
    limit,
    windowMs: 60_000,
  });
  if (rate.response) return { response: rate.response };

  return { user: auth.user, rate: rate.result };
}

export async function GET(request) {
  try {
    const auth = await authorizeHistory(request, 'history-get');
    if (auth.response) return auth.response;

    const { rows } = await sql`
      SELECT id, source_text, target_text, from_lang, to_lang, created_at
      FROM conversation_history
      WHERE user_id = ${auth.user.username}
      ORDER BY created_at DESC
      LIMIT 500
    `;

    return jsonOk(
      { history: rows.map(mapHistoryRow) },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('[History GET]', error);
    return jsonError(error.message, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = await authorizeHistory(request, 'history-post', 180);
    if (auth.response) return auth.response;

    const { source, target, fromLang, toLang } = await request.json();
    const cleanSource = typeof source === 'string' ? source.trim() : '';
    const cleanTarget = typeof target === 'string' ? target.trim() : '';

    if (!cleanSource || !cleanTarget) {
      return jsonError('Missing required fields', { status: 400 });
    }

    const { rows } = await sql`
      INSERT INTO conversation_history (user_id, source_text, target_text, from_lang, to_lang)
      VALUES (${auth.user.username}, ${cleanSource}, ${cleanTarget}, ${fromLang || ''}, ${toLang || ''})
      RETURNING id, created_at
    `;

    return jsonOk(
      {
        success: true,
        id: rows[0].id,
        createdAt: rows[0].created_at,
      },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('[History POST]', error);
    return jsonError(error.message, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const auth = await authorizeHistory(request, 'history-delete', 60);
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return jsonError('Invalid history id', { status: 400 });
      }

      const result = await sql`
        DELETE FROM conversation_history
        WHERE id = ${numericId} AND user_id = ${auth.user.username}
      `;
      return jsonOk(
        { success: true, deleted: result.rowCount },
        { headers: rateLimitHeaders(auth.rate) }
      );
    }

    const result = await sql`
      DELETE FROM conversation_history
      WHERE user_id = ${auth.user.username}
    `;
    return jsonOk(
      { success: true, deleted: result.rowCount },
      { headers: rateLimitHeaders(auth.rate) }
    );
  } catch (error) {
    console.error('[History DELETE]', error);
    return jsonError(error.message, { status: 500 });
  }
}
