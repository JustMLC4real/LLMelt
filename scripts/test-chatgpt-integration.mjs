import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'scripts', 'chatgpt-provider-integration.ts');
const output = path.join(root, 'scripts', '.generated-chatgpt-integration.mjs');

await build({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
});

const child = spawn(electron, [output], {
  cwd: root,
  env: { ...process.env },
  stdio: 'inherit',
  windowsHide: true,
});

const cleanup = () => fs.rmSync(output, { force: true });
child.on('error', (error) => {
  cleanup();
  console.error(error.message);
  process.exit(1);
});
child.on('close', (code) => {
  cleanup();
  process.exit(code ?? 1);
});
