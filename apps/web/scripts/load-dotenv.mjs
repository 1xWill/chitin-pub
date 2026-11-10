import fs from 'node:fs';
import path from 'node:path';

function parseDotenv(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function findEnvFile() {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, '.env'),
    // monorepo root when cwd is apps/web
    path.join(cwd, '..', '..', '.env')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export function loadRepoDotenvIfNeeded() {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.VERCEL) return;
  const p = findEnvFile();
  if (!p) return;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = parseDotenv(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // ignore
  }
}

loadRepoDotenvIfNeeded();

