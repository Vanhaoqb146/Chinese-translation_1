// scripts/init-db.js
// Chạy: node scripts/init-db.js
// Tạo bảng conversation_history trên Vercel Postgres

// Load .env.local vì chạy ngoài Next.js
require('dotenv').config({ path: '.env.local' });
const { sql } = require('@vercel/postgres');

async function initDB() {
  try {
    console.log('🔄 Đang tạo bảng conversation_history...');

    await sql`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        source_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        from_lang VARCHAR(10) NOT NULL,
        to_lang VARCHAR(10) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_conv_user_id ON conversation_history(user_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversation_history(created_at DESC)
    `;

    console.log('✅ Tạo bảng thành công!');

    // Kiểm tra
    const result = await sql`SELECT COUNT(*) FROM conversation_history`;
    console.log(`📊 Hiện có ${result.rows[0].count} bản ghi.`);

  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

initDB();
