import fs from 'fs';
import path from 'path';

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('LOCALAPPDATA is not set.');
  process.exit(1);
}

const roots = [
  path.join(localAppData, 'Google', 'Chrome', 'User Data'),
  path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
];

const keyPatterns = [
  'vt_user',
  'vt_conv_history',
  'vt_sim_history',
  'vt_quick_history',
  'source',
  'target',
  'source_text',
  'target_text',
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
      continue;
    }

    if (/\.(ldb|log|sst)$/i.test(entry.name) || /^MANIFEST-/i.test(entry.name)) {
      out.push(fullPath);
    }
  }

  return out;
}

function storageDirs() {
  const dirs = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    let profiles = [];
    try {
      profiles = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name));
    } catch {
      continue;
    }

    for (const profile of profiles) {
      const name = path.basename(profile);
      if (!/^(Default|Profile|Guest|System Profile)/i.test(name)) continue;
      dirs.push(path.join(profile, 'Session Storage'));
      dirs.push(path.join(profile, 'Local Storage', 'leveldb'));
    }
  }
  return dirs.filter((dir) => fs.existsSync(dir));
}

function cleanSnippet(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

function balancedJsonAt(text, start) {
  const first = text[start];
  if (first !== '{' && first !== '[') return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const last = stack.pop();
      if (!last) return null;
      if ((last === '{' && char !== '}') || (last === '[' && char !== ']')) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function hasHistoryShape(text) {
  return (
    (text.includes('"source"') || text.includes('"source_text"')) &&
    (text.includes('"target"') || text.includes('"target_text"'))
  );
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

function stableRowKey(row) {
  return JSON.stringify([
    row.id,
    row.userId,
    row.source,
    row.target,
    row.createdAt,
  ]);
}

const snippets = [];
const jsonBlocks = [];
const rows = [];
const seenBlocks = new Set();
const seenRows = new Set();

for (const dir of storageDirs()) {
  for (const file of walk(dir)) {
    let raw;
    try {
      raw = fs.readFileSync(file);
    } catch {
      continue;
    }

    const variants = [
      { encoding: 'utf8', text: raw.toString('utf8') },
      { encoding: 'utf16le', text: raw.toString('utf16le') },
    ];

    for (const variant of variants) {
      const { encoding, text } = variant;

      for (const key of keyPatterns) {
        let pos = 0;
        while ((pos = text.indexOf(key, pos)) !== -1) {
          snippets.push({
            file,
            encoding,
            key,
            snippet: cleanSnippet(text.slice(Math.max(0, pos - 160), pos + 2400)),
          });
          pos += key.length;
          if (snippets.length > 1000) break;
        }
      }

      for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== '{' && text[i] !== '[') continue;

        const candidate = balancedJsonAt(text, i);
        if (!candidate || candidate.length < 30 || candidate.length > 250000) continue;
        if (!hasHistoryShape(candidate)) continue;

        try {
          const parsed = JSON.parse(candidate);
          const serialized = JSON.stringify(parsed);
          if (seenBlocks.has(serialized)) continue;
          seenBlocks.add(serialized);
          jsonBlocks.push({ file, encoding, parsed });

          for (const row of collectRows(parsed)) {
            const key = stableRowKey(row);
            if (seenRows.has(key)) continue;
            seenRows.add(key);
            rows.push({ ...row, recoveredFrom: file });
          }
        } catch {
          // Ignore fragments that look like JSON but are not complete LevelDB values.
        }
      }
    }
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const snippetsPath = path.join('data', `browser_storage_snippets_${stamp}.json`);
const rowsPath = path.join('data', `recovered_history_candidates_${stamp}.json`);

fs.writeFileSync(snippetsPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  snippets,
}, null, 2), 'utf8');

fs.writeFileSync(rowsPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  candidateJsonBlocks: jsonBlocks.length,
  recoveredRows: rows.length,
  rows,
}, null, 2), 'utf8');

console.log(JSON.stringify({
  snippetsPath,
  rowsPath,
  snippets: snippets.length,
  candidateJsonBlocks: jsonBlocks.length,
  recoveredRows: rows.length,
}, null, 2));
