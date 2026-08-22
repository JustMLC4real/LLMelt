import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import packageJson from '../package.json' with { type: 'json' };
import { connectCdp, evaluate, pause, waitForElectronPage, waitForText } from './lib/electron-cdp.mjs';

const root = process.cwd();
const installer = String(process.env.AI_SUPERAPP_INSTALLER || '').trim()
  || path.join(root, 'release', `LLMelt-Setup-${packageJson.version}.exe`);
const runRoot = path.join(os.tmpdir(), `llmelt-installer-smoke-${process.pid}`);
const installDir = path.join(runRoot, 'app');
const profileDir = path.join(runRoot, 'profile');
const debugPort = 9345;

if (!existsSync(installer)) {
  throw new Error(`Installer ontbreekt: ${installer}. Voer eerst npm run package uit.`);
}

await rm(runRoot, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });

let appProcess;
let cdp;
try {
  await runProcess(installer, ['/S', `/D=${installDir}`], 180_000);
  const executable = path.join(installDir, 'LLMelt.exe');
  await waitForFile(executable, 30_000);

  appProcess = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    cwd: installDir,
    env: { ...process.env, AI_SUPERAPP_TEST_USER_DATA_DIR: profileDir },
    stdio: 'ignore',
    windowsHide: true,
  });
  const target = await waitForElectronPage(
    debugPort,
    (candidate) => /LLMelt/i.test(`${candidate.title} ${candidate.url}`),
  );
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await waitForText(cdp, 'Hallo, welkom bij LLMelt', 30_000);
  const snapshot = await evaluate(cdp, `(() => ({
    body: document.body.innerText,
    hasPreload: Boolean(window.electronAPI),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }))()`);
  if (!snapshot.hasPreload) throw new Error('De preload-brug ontbreekt na installatie.');
  if (snapshot.horizontalOverflow) throw new Error('De geïnstalleerde onboarding heeft horizontale overflow.');
  if (!snapshot.body.includes('Beginnen')) throw new Error('De geïnstalleerde onboarding mist de startactie.');

  process.stdout.write(`Installer-smoke geslaagd voor LLMelt ${packageJson.version}.\n`);
} finally {
  cdp?.close();
  appProcess?.kill();
  await pause(750);
  if (existsSync(installDir)) {
    const uninstaller = (await readdir(installDir).catch(() => []))
      .find((name) => /^uninstall.*\.exe$/i.test(name));
    if (uninstaller) {
      await runProcess(path.join(installDir, uninstaller), ['/S'], 120_000).catch(() => {});
    }
  }
  await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(executable)} overschreed ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} eindigde met code ${code}.`));
    });
  });
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await pause(250);
  }
  throw new Error(`Geïnstalleerd uitvoerbaar bestand ontbreekt: ${file}`);
}
