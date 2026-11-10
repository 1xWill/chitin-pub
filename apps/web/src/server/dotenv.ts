import fs from 'node:fs';
import path from 'node:path';

/**
 * Load a repo-root `.env` in local dev so `npm run dev -w @chitin/web` works without manual exporting.
 *
 * Why this exists:
 * - Next.js loads `.env*` relative to the Next app root (`apps/web`), not the monorepo root.
 * - Many `.env` values (e.g. DATABASE_URL with `&...`) are not safe to `source` in a shell.
 *
 * Behavior:
 * - dev-only (skips in production/Vercel)
 * - best-effort; does not throw
 * - only sets keys that are currently missing in `process.env`
 */
function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (!key) continue;

    // Strip surrounding quotes (common in .env files).
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

function findEnvFile(): string | null {
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

export function loadRepoDotenvIfNeeded(): void {
  // Only for local dev / local scripts.
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
    // ignore (best-effort)
  }
}

// Load on import (server-only modules import this).
loadRepoDotenvIfNeeded();

