import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  antigravityExecutableCandidates,
  claudeExecutableCandidates,
  codexExecutableCandidates,
  expandCliExecutablePath,
  findCliExecutable,
  isWindowsAppExecutionAlias,
} from '../electron/cli-discovery';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI-detectie', () => {
  it('breidt ingestelde Windows- en homepaden uit', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };

    expect(expandCliExecutablePath('%LOCALAPPDATA%\\agy\\bin\\agy.exe', env, env.USERPROFILE))
      .toBe('C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe');
    expect(expandCliExecutablePath('~\\.local\\bin\\claude.exe', env, env.USERPROFILE))
      .toBe('C:\\Users\\Test\\.local\\bin\\claude.exe');
    expect(expandCliExecutablePath('  "%LOCALAPPDATA%\\agy\\bin\\agy.exe"  ', env, env.USERPROFILE))
      .toBe('C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe');
  });

  it('neemt native en npm-installaties van Claude mee', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };
    const candidates = claudeExecutableCandidates('%USERPROFILE%\\custom\\claude.exe', env, env.USERPROFILE);

    expect(candidates[0]).toBe('C:\\Users\\Test\\custom\\claude.exe');
    expect(candidates).toContain(path.join(env.APPDATA, 'npm', 'claude.cmd'));
    expect(candidates).toContain(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  });

  it('neemt de officiële Antigravity-installatiemap mee', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };

    expect(antigravityExecutableCandidates(undefined, env, env.USERPROFILE))
      .toContain(path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
  });

  it('neemt de standalone-, desktop- en npm-installaties van Codex mee', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };
    const candidates = codexExecutableCandidates(undefined, env, env.USERPROFILE, null);

    expect(candidates).toContain(path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    expect(candidates).toContain(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    expect(candidates).toContain(path.join(env.APPDATA, 'npm', 'codex.cmd'));
  });

  it('zet een nieuwere Codex-desktopbinary vóór een opgeslagen top-level pad', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };
    const savedTopLevel = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const newestBundled = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'release', 'codex.exe');

    expect(codexExecutableCandidates(savedTopLevel, env, env.USERPROFILE, newestBundled).slice(0, 2))
      .toEqual([newestBundled, savedTopLevel]);
  });

  it('respecteert een bewust ingesteld extern Codex-pad', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\Test',
      HOME: '',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    };
    const custom = 'D:\\Eigen Codex\\codex.exe';
    const bundled = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'release', 'codex.exe');

    expect(codexExecutableCandidates(custom, env, env.USERPROFILE, bundled)[0]).toBe(custom);
  });

  it('geeft het echte absolute pad van een bestaand bestand terug', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-cli-'));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, process.platform === 'win32' ? 'voorbeeld.cmd' : 'voorbeeld');
    fs.writeFileSync(executable, 'test');

    await expect(findCliExecutable([executable])).resolves.toBe(path.resolve(executable));
  });

  it('voert een kale commandonaam niet uit de actieve projectmap uit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-cli-cwd-'));
    temporaryDirectories.push(directory);
    const previousCwd = process.cwd();
    const name = `lokale-kaper-${crypto.randomUUID()}.cmd`;
    fs.writeFileSync(path.join(directory, name), 'test');
    try {
      process.chdir(directory);
      await expect(findCliExecutable([name], { pathLookup: false })).resolves.toBeNull();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('weigert niet-uitvoerbare WindowsApps-aliaspaden', () => {
    expect(isWindowsAppExecutionAlias('C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe')).toBe(true);
    expect(isWindowsAppExecutionAlias('C:\\Tools\\codex.exe')).toBe(false);
  });

  it('simuleert een schoon profiel zonder de echte PATH of gebruikersdata te lezen', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-fresh-profile-'));
    temporaryDirectories.push(profile);
    const env = {
      USERPROFILE: path.join(profile, 'User'),
      HOME: '',
      APPDATA: path.join(profile, 'User', 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(profile, 'User', 'AppData', 'Local'),
      PROGRAMFILES: path.join(profile, 'Program Files'),
    };

    await expect(findCliExecutable(codexExecutableCandidates(undefined, env, env.USERPROFILE, null), { pathLookup: false })).resolves.toBeNull();
    await expect(findCliExecutable(claudeExecutableCandidates(undefined, env, env.USERPROFILE), { pathLookup: false })).resolves.toBeNull();
    await expect(findCliExecutable(antigravityExecutableCandidates(undefined, env, env.USERPROFILE), { pathLookup: false })).resolves.toBeNull();

    const claude = path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, 'isolated test executable');
    await expect(findCliExecutable(claudeExecutableCandidates(undefined, env, env.USERPROFILE), { pathLookup: false }))
      .resolves.toBe(path.resolve(claude));
  });
});
