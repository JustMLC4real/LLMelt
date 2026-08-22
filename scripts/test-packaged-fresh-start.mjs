import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { connectCdp, evaluate, pause, waitForElectronPage, waitForText } from './lib/electron-cdp.mjs';

const root = process.cwd();
const executable = path.join(root, 'release', 'win-unpacked', 'LLMelt.exe');
const profileDir = path.join(root, '.tmp-packaged-fresh-profile');
const debugPort = 9335;

if (!existsSync(executable)) {
  throw new Error(`Verpakte app ontbreekt: ${executable}. Voer eerst npm run package uit.`);
}

await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  cwd: root,
  env: {
    ...process.env,
    AI_SUPERAPP_TEST_USER_DATA_DIR: profileDir,
  },
  stdio: 'ignore',
  windowsHide: true,
});

let cdp;
try {
  const target = await waitForElectronPage(
    debugPort,
    (candidate) => /LLMelt/i.test(`${candidate.title} ${candidate.url}`),
  );
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await waitForText(cdp, 'Hallo, welkom bij LLMelt', 30_000);

  const snapshot = await evaluate(cdp, `(() => ({
    title: document.title,
    body: document.body.innerText,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    hasPreload: Boolean(window.electronAPI),
  }))()`);
  if (!snapshot.hasPreload) throw new Error('De preload-brug ontbreekt in de verpakte app.');
  if (snapshot.horizontalOverflow) throw new Error('De fresh-startpagina heeft horizontale overflow.');
  if (!snapshot.body.includes('Beginnen')) throw new Error('De fresh-startactie ontbreekt.');

  process.stdout.write('Verpakte fresh-start geslaagd met lege profielmap, onboarding en preload-brug.\n');
} finally {
  cdp?.close();
  child.kill();
  await pause(500);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
