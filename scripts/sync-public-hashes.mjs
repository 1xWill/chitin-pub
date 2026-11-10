import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const repoRoot = path.resolve(process.cwd());
const publicDir = path.join(repoRoot, 'apps', 'web', 'public');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeHashFile(filename) {
  const p = path.join(publicDir, filename);
  const buf = fs.readFileSync(p);
  const hex = sha256Hex(buf);
  const out = `${hex}  ${filename}\n`;
  fs.writeFileSync(p + '.sha256', out, 'utf8');
}

if (!fs.existsSync(publicDir)) {
  throw new Error(`Missing public dir: ${publicDir}`);
}

// Files agents install / execute. Keep hashes next to the assets.
const files = ['skill.md', 'heartbeat.md', 'skill.json', 'chitin-cli.cjs'];
for (const f of files) {
  const p = path.join(publicDir, f);
  if (!fs.existsSync(p)) throw new Error(`Missing public asset: ${p}`);
  writeHashFile(f);
}

process.stdout.write(`Wrote sha256 files for: ${files.join(', ')}\n`);

