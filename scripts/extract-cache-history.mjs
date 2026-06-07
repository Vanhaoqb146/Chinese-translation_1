import fs from 'fs';
import path from 'path';

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('LOCALAPPDATA is not set.');
  process.exit(1);
}

const roots = [
  path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data'),
  path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Service Worker', 'CacheStorage'),
  path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data'),
  path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Service Worker', 'CacheStorage'),
];

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

function balancedJsonAt(text, start) {
  if (text[start] !== '{' && text[start] !== '[') return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const last = stack.pop();
      if (!last) return null;
      if ((last === '{' && char !== '}') || (last === '[' && char !== ']')) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function collectRows(value, rows = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, rows);
    return rows;
  }
  if (!value || typeof value !== 'object') return rows;

  const source = value.source ?? value.source_text;
  const target = value.target ?? value.target_text;
  if (source || target) {
    rows.push({
      id: value.id ?? null,
      userId: value.userId ?? value.user_id ?? null,
      source,
      target,
      fromLang: value.fromLang ?? value.from_lang ?? '',
      toLang: value.toLang ?? value.to_lang ?? '',
      createdAt: value.createdAt ?? value.created_at ?? value.time ?? null,
    });
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') collectRows(nested, rows);
  }

  return rows;
}

const snapshots = [];
const seenSnapshots = new Set();
const seenRows = new Set();
const rows = [];

for (const root of roots.filter((dir) => fs.existsSync(dir))) {
  for (const file of walk(root)) {
    let text;
    try {
      text = fs.readFileSync(file).toString('utf8');
    } catch {
      continue;
    }

    if (!text.includes('"history"') || !text.includes('"source"') || !text.includes('"target"')) {
      continue;
    }

    let pos = 0;
    while ((pos = text.indexOf('"history"', pos)) !== -1) {
      const start = text.lastIndexOf('{', pos);
      if (start < 0) {
        pos += 9;
        continue;
      }

      const candidate = balancedJsonAt(text, start);
      if (!candidate || candidate.length < 20 || candidate.length > 1000000) {
        pos += 9;
        continue;
      }

      try {
        const parsed = JSON.parse(candidate);
        if (!Array.isArray(parsed.history)) {
          pos += 9;
          continue;
        }

        const snapshotRows = collectRows(parsed.history);
        if (snapshotRows.length === 0) {
          pos += 9;
          continue;
        }

        const serialized = JSON.stringify(parsed.history);
        if (!seenSnapshots.has(serialized)) {
          seenSnapshots.add(serialized);
          snapshots.push({
            file,
            count: snapshotRows.length,
            firstCreatedAt: snapshotRows.at(-1)?.createdAt ?? null,
            lastCreatedAt: snapshotRows[0]?.createdAt ?? null,
          });
        }

        for (const row of snapshotRows) {
          const key = JSON.stringify([row.id, row.source, row.target, row.createdAt]);
          if (seenRows.has(key)) continue;
          seenRows.add(key);
          rows.push({ ...row, recoveredFrom: file });
        }
      } catch {
        // Ignore malformed cache fragments.
      }

      pos += 9;
    }
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const outPath = path.join('data', `cache_history_candidates_${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  snapshots,
  recoveredRows: rows.length,
  rows,
}, null, 2), 'utf8');

console.log(JSON.stringify({
  outPath,
  snapshots: snapshots.length,
  recoveredRows: rows.length,
}, null, 2));
