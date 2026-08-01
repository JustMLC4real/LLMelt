import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, safeStorage } from 'electron';

const userData = path.join(process.env.APPDATA || '', 'ai-superapp');
if (userData) app.setPath('userData', userData);

function readGeminiKey() {
  const configPath = path.join(userData, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const credential = config?.credentials?.google;
  if (!credential?.value || credential.method !== 'apikey') {
    throw new Error('Geen opgeslagen Gemini API-key gevonden in LLMelt.');
  }
  if (!credential.encrypted) throw new Error('De opgeslagen Gemini API-key is niet veilig versleuteld.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows veilige opslag is niet beschikbaar.');
  return safeStorage.decryptString(Buffer.from(credential.value, 'base64'));
}

app.whenReady().then(() => {
  const nodeExecutable = process.env.AI_SUPERAPP_NODE_EXECUTABLE;
  const root = process.env.AI_SUPERAPP_ROOT;
  if (!nodeExecutable || !root) throw new Error('Integratietest-bootstrap mist Node of de projectmap.');
  const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const filter = process.env.LIVE_PROVIDER_FILTER?.trim();
  const needsGemini = !filter || /gemini/i.test(filter);
  const geminiApiKey = needsGemini
    ? String(process.env.GEMINI_API_KEY || '').trim() || readGeminiKey()
    : '';
  const child = spawn(nodeExecutable, [
    vitest,
    'run',
    'src/native-providers.integration.test.ts',
    '--reporter=verbose',
  ], {
    cwd: root,
    env: {
      ...process.env,
      RUN_NATIVE_PROVIDER_INTEGRATION: '1',
      ...(geminiApiKey ? { GEMINI_API_KEY: geminiApiKey } : {}),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error.message);
    app.exit(1);
  });
  child.on('close', (code) => app.exit(code ?? 1));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
