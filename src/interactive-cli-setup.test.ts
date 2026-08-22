import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  downloadAndInvokePowerShellInstallerPowerShell,
  interactiveCliInstallPowerShell,
  interactiveCliLaunchPowerShell,
  interactiveCliTerminalLauncherPowerShell,
  parseInteractiveCliInstallerProgress,
  progressAwareInvokeWebRequestPowerShell,
} from '../electron/interactive-cli-setup';

describe('interactieve CLI-installatie', () => {
  it('opent providerlogin in de LLMelt-werkmap en niet in het volledige gebruikersprofiel', () => {
    const handlers = readFileSync(new URL('../electron/ipc-handlers.ts', import.meta.url), 'utf8');
    expect(handlers).toContain('openInteractiveCliLogin(kind, executable, ensureDefaultWorkspacePath(), language)');
    expect(handlers).toContain('interactiveCliTerminalLauncherPowerShell(kind, executablePath, workingDirectory, language)');
    expect(handlers).not.toContain('interactiveCliTerminalLauncherPowerShell(kind, executablePath, os.homedir())');
  });

  it('gebruikt uitsluitend de officiële installatiebronnen', () => {
    expect(interactiveCliInstallPowerShell('codex')).toContain("-Uri 'https://chatgpt.com/codex/install.ps1'");
    expect(interactiveCliInstallPowerShell('claude')).toContain("-Uri 'https://claude.ai/install.ps1'");
    expect(interactiveCliInstallPowerShell('antigravity')).toContain("-Uri 'https://antigravity.google/cli/install.ps1'");
  });

  it('installeert Codex niet-interactief en start login pas in een aparte fase', () => {
    const command = interactiveCliInstallPowerShell('codex');
    expect(command).toContain("$env:CODEX_NON_INTERACTIVE = '1'");
    expect(command).not.toContain('codex login');
    expect(command).toContain('AI_SUPERAPP_DOWNLOAD');
    expect(command).toContain('ResponseHeadersRead');
    expect(command).toContain("-Label 'installer-script'");
    expect(command).toContain('[System.Text.Encoding]::UTF8.GetString($installerBytes)');
    expect(command).not.toContain('[string]$installerResponse.Content');
  });

  it('gebruikt de expliciete logincommando’s en quote paden veilig voor PowerShell', () => {
    expect(interactiveCliLaunchPowerShell('codex', "C:\\Test O'Brien\\codex.exe"))
      .toBe("& 'C:\\Test O''Brien\\codex.exe' login");
    expect(interactiveCliLaunchPowerShell('claude', 'C:\\Tools\\claude.exe'))
      .toBe("& 'C:\\Tools\\claude.exe' auth login");
  });

  it('start een blijvend zichtbaar loginvenster en meldt pas daarna de proces-id', () => {
    const command = interactiveCliTerminalLauncherPowerShell(
      'claude',
      "C:\\Test O'Brien\\claude.exe",
      'C:\\Users\\Test',
    );
    expect(command).toContain("Start-Process -FilePath 'powershell.exe'");
    expect(command).toContain("'-NoExit'");
    expect(command).toContain("'-EncodedCommand'");
    expect(command).toContain('-WindowStyle Normal -PassThru');
    expect(command).toContain('$loginProcess.HasExited');
    expect(command).toContain('AI_SUPERAPP_LOGIN_PID|');

    const encoded = command.match(/'-EncodedCommand', '([^']+)'/)?.[1];
    expect(encoded).toBeTruthy();
    const childCommand = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(childCommand).toContain("& 'C:\\Test O''Brien\\claude.exe' auth login");
  });

  it('leest echte installerfasen en percentages zonder voortgang te verzinnen', () => {
    expect(parseInteractiveCliInstallerProgress(
      'codex',
      'Resolved version: 1.2.3',
    )).toEqual({
      phase: 'checking',
      status: 'Codex CLI-download controleren...',
    });
    expect(parseInteractiveCliInstallerProgress(
      'antigravity',
      'Downloading Antigravity 43.7%',
    )).toEqual({
      phase: 'downloading',
      status: 'Antigravity CLI downloaden... 44%',
      percent: 44,
    });
    expect(parseInteractiveCliInstallerProgress(
      'claude',
      'Installation complete!',
    )).toEqual({
      phase: 'installing',
      status: 'Claude Code CLI is geïnstalleerd.',
      percent: 100,
    });
  });

  it('gebruikt voor Engelse setup uitsluitend Engelse hostframing', () => {
    expect(parseInteractiveCliInstallerProgress('codex', 'Resolved version: 1.2.3', 'en'))
      .toEqual({ phase: 'checking', status: 'Verifying Codex CLI download...' });
    expect(interactiveCliInstallPowerShell('claude', 'en')).toContain('Installing Claude Code CLI...');

    const launcher = interactiveCliTerminalLauncherPowerShell('codex', 'C:\\Tools\\codex.exe', 'C:\\Work', 'en');
    const encoded = launcher.match(/'-EncodedCommand', '([^']+)'/)?.[1];
    const childCommand = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(childCommand).toContain('Complete the sign-in here. You can close this window afterwards.');
    expect(childCommand).not.toContain('Rond de login hier af');
  });

  it('leest echte bytevoortgang, snelheid en percentage uit de downloadmarker', () => {
    expect(parseInteractiveCliInstallerProgress(
      'claude',
      'AI_SUPERAPP_DOWNLOAD|5242880|10485760|2097152|50',
    )).toEqual({
      phase: 'downloading',
      status: 'Claude Code CLI downloaden... 50%',
      percent: 50,
      transferred: 5_242_880,
      total: 10_485_760,
      bytesPerSecond: 2_097_152,
    });
  });

  it('maakt onderscheid tussen het kleine installatiescript en de echte CLI-download', () => {
    expect(parseInteractiveCliInstallerProgress(
      'codex',
      'AI_SUPERAPP_DOWNLOAD|installer-script|18500|37000|250000|50',
    )).toEqual({
      phase: 'downloading',
      status: 'Codex CLI-installatiescript ophalen... 50%',
      percent: 50,
      transferred: 18_500,
      total: 37_000,
      bytesPerSecond: 250_000,
    });
    expect(parseInteractiveCliInstallerProgress(
      'codex',
      'AI_SUPERAPP_DOWNLOAD|payload|5242880|10485760|2097152|50',
    )).toEqual({
      phase: 'downloading',
      status: 'Codex CLI downloaden... 50%',
      percent: 50,
      transferred: 5_242_880,
      total: 10_485_760,
      bytesPerSecond: 2_097_152,
    });
  });

  it('laat een nieuwere installerfase een oude 100%-downloadmarker vervangen', () => {
    expect(parseInteractiveCliInstallerProgress(
      'codex',
      'AI_SUPERAPP_DOWNLOAD|37146|37146|500000|100\nResolved version: 1.2.3',
    )).toEqual({
      phase: 'checking',
      status: 'Codex CLI-download controleren...',
    });
    expect(parseInteractiveCliInstallerProgress(
      'claude',
      'AI_SUPERAPP_DOWNLOAD|100|100|100|100\nInstalling Claude Code CLI',
    )).toEqual({
      phase: 'installing',
      status: 'Claude Code CLI installeren...',
    });
  });

  it.runIf(process.platform === 'win32')(
    'decodeert een als octet-stream geleverd installatiescript als UTF-8',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'ai-superapp-cli-script-'));
      const markerPath = path.join(directory, 'script-uitgevoerd.txt');
      const script = Buffer.from(
        `[System.IO.File]::WriteAllText('${markerPath.replace(/'/g, "''")}', 'uitgevoerd')`,
        'utf8',
      );
      const server = createServer((_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(script.length),
        });
        response.end(script);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const { port } = server.address() as AddressInfo;

      try {
        const command = [
          "$ErrorActionPreference = 'Stop'",
          progressAwareInvokeWebRequestPowerShell(),
          downloadAndInvokePowerShellInstallerPowerShell(`http://127.0.0.1:${port}/installer.ps1`),
        ].join('\n');
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            command,
          ], { windowsHide: true });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (data) => { stdout += data.toString(); });
          child.stderr?.on('data', (data) => { stderr += data.toString(); });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stdout, stderr }));
        });

        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toMatch(/AI_SUPERAPP_DOWNLOAD\|installer-script\|\d+\|\d+\|\d+\|100/);
        expect(readFileSync(markerPath, 'utf8')).toBe('uitgevoerd');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

});
