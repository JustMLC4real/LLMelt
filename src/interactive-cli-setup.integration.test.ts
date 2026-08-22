import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  interactiveCliTerminalLauncherPowerShell,
  progressAwareInvokeWebRequestPowerShell,
} from '../electron/interactive-cli-setup';

const integration = process.platform === 'win32'
  && process.env.AI_SUPERAPP_RUN_WINDOWS_LOGIN_INTEGRATION === '1'
  ? describe
  : describe.skip;

integration('interactieve CLI-installatie op een echt Windows-proces', () => {
  it('streamt echte HTTP-bytes en houdt het zichtbare loginproces in leven', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-superapp-cli-setup-'));
    const downloadPath = path.join(directory, 'payload.bin');
    const fakeCliPath = path.join(directory, 'fake-claude.ps1');
    const argsPath = path.join(directory, 'args.txt');
    const payloadSize = 4 * 1024 * 1024;
    let loginProcessId = 0;
    const server = createServer((request, response) => {
      if (request.url === '/metadata') {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
        response.end('ok');
        return;
      }
      if (request.url !== '/payload') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payloadSize),
      });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const timer = setInterval(() => {
        const remaining = payloadSize - sent;
        if (remaining <= 0) {
          clearInterval(timer);
          response.end();
          return;
        }
        const next = chunk.subarray(0, Math.min(chunk.length, remaining));
        response.write(next);
        sent += next.length;
      }, 5);
      response.once('close', () => clearInterval(timer));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    try {
      const downloadCommand = [
        "$ErrorActionPreference = 'Stop'",
        progressAwareInvokeWebRequestPowerShell(),
        `$probeScript = @'
$metadata = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/metadata' -TimeoutSec 30
if ([string]::IsNullOrWhiteSpace([string]$metadata.Content)) { throw 'Metadatarequest gaf geen inhoud.' }
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/payload' -OutFile '${downloadPath.replace(/'/g, "''")}' -TimeoutSec 30
'@`,
        '& ([scriptblock]::Create($probeScript))',
      ].join('\n');
      const download = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command', downloadCommand,
        ], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('De download-integratietest duurde te lang.'));
        }, 60_000);
        child.stdout?.on('data', (data) => { stdout += data.toString(); });
        child.stderr?.on('data', (data) => { stderr += data.toString(); });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (status) => {
          clearTimeout(timeout);
          resolve({ status, stdout, stderr });
        });
      });

      expect(download.status, download.stderr || download.stdout).toBe(0);
      expect(download.stdout).toMatch(/AI_SUPERAPP_DOWNLOAD\|payload\|\d+\|\d+\|\d+\|100/);
      const measuredPercents = [...download.stdout.matchAll(
        /AI_SUPERAPP_DOWNLOAD\|payload\|\d+\|\d+\|\d+\|(\d+)/g,
      )].map((match) => Number(match[1]));
      expect(measuredPercents.some((percent) => percent > 0 && percent < 100)).toBe(true);
      expect(statSync(downloadPath).size).toBe(payloadSize);

      writeFileSync(
        fakeCliPath,
        `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)\n`
        + `Set-Content -LiteralPath '${argsPath.replace(/'/g, "''")}' -Value ($Rest -join ' ')\n`,
        'utf8',
      );
      const launcher = interactiveCliTerminalLauncherPowerShell('claude', fakeCliPath, directory);
      const opened = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', launcher,
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      expect(opened.status, opened.stderr || opened.stdout).toBe(0);
      loginProcessId = Number(opened.stdout.match(/AI_SUPERAPP_LOGIN_PID\|(\d+)/)?.[1]);
      expect(loginProcessId).toBeGreaterThan(0);
      const argsDeadline = Date.now() + 5_000;
      while (!existsSync(argsPath) && Date.now() < argsDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(argsPath)).toBe(true);
      expect(readFileSync(argsPath, 'utf8').trim()).toBe('auth login');
      expect(spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-Command', `Get-Process -Id ${loginProcessId} -ErrorAction Stop | Out-Null`],
      ).status).toBe(0);
    } finally {
      if (loginProcessId > 0) spawnSync('taskkill.exe', ['/PID', String(loginProcessId), '/T', '/F']);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
