import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = path.join(root, 'scripts', 'native-provider-bootstrap.mjs');
const filter = process.argv.slice(2).join(' ').trim();
const child = spawn(electron, [bootstrap], {
  cwd: root,
  env: {
    ...process.env,
    AI_SUPERAPP_NODE_EXECUTABLE: process.execPath,
    AI_SUPERAPP_ROOT: root,
    ...(filter ? { LIVE_PROVIDER_FILTER: filter } : {}),
  },
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
