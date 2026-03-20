// scripts/init-db.js
// Chạy: node scripts/init-db.js
// Tạo bảng conversation_history + users trên Vercel Postgres

// Load .env.local vì chạy ngoài Next.js
require('dotenv').config({ path: '.env.local' });
const { sql } = require('@vercel/postgres');

async function initDB() {
  try {
    // ====== BẢNG LỊCH SỬ HỘI THOẠI ======
    console.log('🔄 Tạo bảng conversation_history...');
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
    await sql`CREATE INDEX IF NOT EXISTS idx_conv_user_id ON conversation_history(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversation_history(created_at DESC)`;
    console.log('✅ conversation_history OK');

    // ====== BẢNG NGƯỜI DÙNG ======
    console.log('🔄 Tạo bảng users...');
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        name VARCHAR(200) NOT NULL,
        unit VARCHAR(200) DEFAULT '',
        avatar VARCHAR(500) DEFAULT '',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ users OK');

    // ====== SEED DỮ LIỆU MẪU (chỉ khi bảng trống) ======
    const { rows } = await sql`SELECT COUNT(*) as count FROM users`;
    if (Number(rows[0].count) === 0) {
      console.log('🌱 Seed dữ liệu người dùng mẫu...');
      await sql`
        INSERT INTO users (username, password, role, name, unit, avatar, is_active) VALUES
        ('admin', 'admin123', 'admin', 'Super Admin', 'All Units', 'https://api.dicebear.com/7.x/avataaars/svg?seed=admin', true),
        ('user1', '123456', 'user', 'Nhân viên A', 'Đơn vị A', 'https://api.dicebear.com/7.x/avataaars/svg?seed=user1', true),
        ('user2', '123456', 'user', 'Nhân viên B', 'Đơn vị B', 'https://api.dicebear.com/7.x/avataaars/svg?seed=user2', true)
      `;
      console.log('✅ Seed 3 tài khoản thành công');
    } else {
      console.log(`📊 Bảng users đã có ${rows[0].count} tài khoản, bỏ qua seed.`);
    }

    // Tổng kết
    const histCount = await sql`SELECT COUNT(*) FROM conversation_history`;
    const userCount = await sql`SELECT COUNT(*) FROM users`;
    console.log(`\n📊 Tổng kết:`);
    console.log(`   - conversation_history: ${histCount.rows[0].count} bản ghi`);
    console.log(`   - users: ${userCount.rows[0].count} tài khoản`);

  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

initDB();
