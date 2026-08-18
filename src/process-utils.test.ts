import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { agentShellSpawnSpec, cliPtySpawnSpec, cliSpawnSpec, clipNativeOutput, windowsPowerShellExecutable } from '../electron/process-utils';

describe('CLI-proceshulpen', () => {
  it('start een echt executable rechtstreeks', () => {
    expect(cliSpawnSpec('C:\\Tools\\agy.exe', ['models'], 'win32', 'C:\\Windows\\cmd.exe')).toEqual({
      command: 'C:\\Tools\\agy.exe',
      args: ['models'],
    });
  });

  it('routeert Windows cmd- en bat-shims via COMSPEC zonder argumenten te verliezen', () => {
    expect(cliSpawnSpec('C:\\Program Files\\CLI\\codex.cmd', ['exec', '--model', 'model met spatie'], 'win32', 'C:\\Windows\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program^ Files\\CLI\\codex.cmd ^"exec^" ^"--model^" ^"model^ met^ spatie^""'],
      windowsVerbatimArguments: true,
    });
  });

  it('markeert afgekapte native uitvoer zichtbaar', () => {
    expect(clipNativeOutput('123456', 4)).toContain('uitvoer afgekapt');
  });

  it('bouwt een Windows cmd-opdracht met verbatim buitenquotes', () => {
    expect(agentShellSpawnSpec('cmd', 'python "map met spatie\\script.py"', 'win32', {
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"python "map met spatie\\script.py""'],
      windowsVerbatimArguments: true,
    });
  });

  it('bouwt voor node-pty één vooraf gequote commandline voor een npm-shim', () => {
    expect(cliPtySpawnSpec(
      'C:\\Users\\Test User\\AppData\\Roaming\\npm\\claude.cmd',
      ['--version'],
      'win32',
      'C:\\Windows\\cmd.exe',
    )).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: '/d /s /c ""C:\\Users\\Test User\\AppData\\Roaming\\npm\\claude.cmd" "--version""',
    });
  });

  it('vindt Windows PowerShell ook wanneer System32 niet in PATH staat', () => {
    const expected = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(windowsPowerShellExecutable(
      { SystemRoot: 'C:\\Windows', PATH: '' },
      (candidate) => candidate === expected,
    )).toBe(expected);
    expect(agentShellSpawnSpec('powershell', 'Get-Date', 'win32', {
      SystemRoot: 'C:\\Windows',
      PATH: '',
    }).command).toBe(expected);
  });

  it('voert via cmd een gequote scriptpad met spaties intact uit', async () => {
    if (process.platform !== 'win32') return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp shell test '));
    try {
      const script = path.join(directory, 'quote probe.cjs');
      fs.writeFileSync(script, 'process.stdout.write("QUOTE_OK")', 'utf8');
      const spec = agentShellSpawnSpec('cmd', `"${process.execPath}" "${script}"`);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
      });
      expect(output).toBe('QUOTE_OK');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('behoudt speciale argumenten via een Windows cmd-shim zonder shellinjectie', async () => {
    if (process.platform !== 'win32') return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp cmd test '));
    try {
      const capture = path.join(directory, 'capture.cjs');
      const shim = path.join(directory, 'provider shim.cmd');
      fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8');
      fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0capture.cjs" %*\r\n', 'utf8');
      const expected = ['model met spatie', 'waarde&ver', 'haak(je)', '100%'];
      const spec = cliSpawnSpec(shim, expected);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
      });
      expect(JSON.parse(output)).toEqual(expected);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
