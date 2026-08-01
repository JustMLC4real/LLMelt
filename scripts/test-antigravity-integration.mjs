import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
const configured = String(process.env.AGY_EXE || '').trim();
const resolved = configured || String(spawnSync(resolver, ['agy'], {
  encoding: 'utf8',
  windowsHide: true,
}).stdout || '')
  .split(/\r?\n/)
  .map((candidate) => candidate.trim())
  .find((candidate) => candidate && fs.existsSync(candidate));

if (!resolved || !fs.existsSync(resolved)) {
  console.error('Antigravity CLI niet gevonden. Installeer/open agy of zet AGY_EXE op het executablepad.');
  process.exit(1);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [
  vitest,
  'run',
  'src/antigravity-native.integration.test.ts',
  '--reporter=verbose',
], {
  cwd: root,
  env: {
    ...process.env,
    RUN_ANTIGRAVITY_INTEGRATION: '1',
    AGY_EXE: resolved,
  },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
