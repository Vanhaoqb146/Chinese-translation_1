import { sql } from '@vercel/postgres';
import { NextResponse } from 'next/server';

// GET /api/history?userId=xxx — Lấy 100 bản ghi mới nhất
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const { rows } = await sql`
      SELECT id, source_text, target_text, from_lang, to_lang, created_at
      FROM conversation_history
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 500
    `;

    // Map sang format frontend
    const history = rows.map(row => ({
      id: row.id,
      source: row.source_text,
      target: row.target_text,
      fromLang: row.from_lang,
      toLang: row.to_lang,
      createdAt: row.created_at,
      time: new Date(row.created_at).toLocaleTimeString('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    }));

    return NextResponse.json({ history });
  } catch (error) {
    console.error('❌ [History GET]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/history — Lưu 1 bản ghi mới
export async function POST(request) {
  try {
    const body = await request.json();
    const { userId, source, target, fromLang, toLang } = body;

    if (!userId || !source || !target) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const { rows } = await sql`
      INSERT INTO conversation_history (user_id, source_text, target_text, from_lang, to_lang)
      VALUES (${userId}, ${source}, ${target}, ${fromLang || ''}, ${toLang || ''})
      RETURNING id, created_at
    `;

    return NextResponse.json({
      success: true,
      id: rows[0].id,
      createdAt: rows[0].created_at,
    });
  } catch (error) {
    console.error('❌ [History POST]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE /api/history — Xóa 1 bản ghi (id) hoặc tất cả (userId)
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const userId = searchParams.get('userId');

    if (id) {
      // Xóa 1 bản ghi
      const result = await sql`DELETE FROM conversation_history WHERE id = ${Number(id)}`;
      return NextResponse.json({ success: true, deleted: result.rowCount });
    }

    if (userId) {
      // Xóa tất cả của user
      const result = await sql`DELETE FROM conversation_history WHERE user_id = ${userId}`;
      return NextResponse.json({ success: true, deleted: result.rowCount });
    }

    return NextResponse.json({ error: 'id or userId is required' }, { status: 400 });
  } catch (error) {
    console.error('❌ [History DELETE]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
