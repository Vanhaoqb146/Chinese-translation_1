import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@vercel/postgres';

dotenv.config({ path: '.env.local', quiet: true });

const timestamp = process.argv[2];
if (!timestamp) {
  console.error('Usage: node scripts/export-history-at-time.mjs <RFC3339 timestamp>');
  process.exit(1);
}

const baseUrl = process.env.POSTGRES_URL_NON_POOLING
  || process.env.DATABASE_URL_UNPOOLED
  || process.env.POSTGRES_URL
  || process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('POSTGRES_URL or DATABASE_URL is not set.');
  process.exit(1);
}

function withNeonTimestamp(connectionString, value) {
  const url = new URL(connectionString);
  url.searchParams.set('options', `neon_timestamp:${value}`);
  return url.toString();
}

const client = createClient({
  connectionString: withNeonTimestamp(baseUrl, timestamp),
});

try {
  await client.connect();
  const result = await client.query(`
    SELECT id, user_id, source_text, target_text, from_lang, to_lang, created_at
    FROM conversation_history
    ORDER BY created_at DESC, id DESC
  `);

  const stamp = timestamp.replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const outPath = path.join('data', `conversation_history_timetravel_${stamp}.json`);

  fs.writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    neonTimestamp: timestamp,
    count: result.rowCount,
    rows: result.rows,
  }, null, 2), 'utf8');

  const counts = new Map();
  for (const row of result.rows) {
    const current = counts.get(row.user_id) || 0;
    counts.set(row.user_id, current + 1);
  }

  console.log(JSON.stringify({
    outPath,
    count: result.rowCount,
    byUser: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }, null, 2));
} finally {
  await client.end();
}
