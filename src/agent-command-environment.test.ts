import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { agentCommandEnvironment } from '../electron/agent-command-environment';

const windowsPythonAvailable = process.platform === 'win32'
  && spawnSync('python', ['--version'], { windowsHide: true }).status === 0;

describe('agent-commandomgeving', () => {
  it('maakt Python-uitvoer in een verborgen Windows-shell standaard UTF-8', () => {
    expect(agentCommandEnvironment({ PATH: 'voorbeeld' })).toMatchObject({
      PATH: 'voorbeeld',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    });
  });

  it('respecteert een expliciete gebruikersconfiguratie', () => {
    expect(agentCommandEnvironment({
      PYTHONIOENCODING: 'utf-8:replace',
      PYTHONUTF8: '0',
    })).toMatchObject({
      PYTHONIOENCODING: 'utf-8:replace',
      PYTHONUTF8: '0',
    });
  });

  it.skipIf(!windowsPythonAvailable)('draait echte UTF-8-Python vanuit een pad met spaties en Unicode', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-python-pad '));
    const cwd = path.join(base, 'stad é 🏙');
    const scriptName = 'artistieke skyline.py';
    try {
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, scriptName), 'print("🏙️  Café aan het water")\n', 'utf8');

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command', `python ".\\${scriptName}"`,
        ], {
          cwd,
          windowsHide: true,
          env: agentCommandEnvironment({ ...process.env, PYTHONIOENCODING: undefined, PYTHONUTF8: undefined }),
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });

      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain('🏙️  Café aan het water');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 15_000);
});
