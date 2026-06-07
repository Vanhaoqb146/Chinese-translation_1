import fs from 'fs';
import dotenv from 'dotenv';
import { createPool } from '@vercel/postgres';

dotenv.config({ path: '.env.local', quiet: true });

const inputPath = process.argv[2];
const userId = process.argv[3] || 'admin';

if (!inputPath) {
  console.error('Usage: node scripts/restore-cache-history.mjs <cache candidates json> [userId]');
  process.exit(1);
}

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('POSTGRES_URL or DATABASE_URL is not set.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const candidateRows = Array.isArray(data.rows) ? data.rows : [];
const rows = candidateRows
  .filter((row) => row?.id && row?.source && row?.target)
  .map((row) => ({
    id: Number(row.id),
    userId,
    source: row.source,
    target: row.target,
    fromLang: row.fromLang || '',
    toLang: row.toLang || '',
    createdAt: row.createdAt,
  }))
  .sort((a, b) => a.id - b.id);

const pool = createPool({ connectionString });

try {
  const current = await pool.query('SELECT id FROM conversation_history');
  const currentIds = new Set(current.rows.map((row) => Number(row.id)));
  const missing = rows.filter((row) => !currentIds.has(row.id));

  if (missing.length === 0) {
    console.log(JSON.stringify({ inserted: 0, skipped: rows.length }, null, 2));
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of missing) {
      await client.query(`
        INSERT INTO conversation_history
          (id, user_id, source_text, target_text, from_lang, to_lang, created_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [
        row.id,
        row.userId,
        row.source,
        row.target,
        row.fromLang,
        row.toLang,
        row.createdAt,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(JSON.stringify({
    userId,
    inserted: missing.length,
    skipped: rows.length - missing.length,
    firstId: missing[0]?.id ?? null,
    lastId: missing.at(-1)?.id ?? null,
  }, null, 2));
} finally {
  await pool.end();
}
