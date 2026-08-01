import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  isCodexDesktopExecutable,
  newestBundledCodexExecutable,
} from './codex-cli-discovery';

export type CliEnvironment = Partial<Pick<NodeJS.ProcessEnv, 'APPDATA' | 'LOCALAPPDATA' | 'USERPROFILE' | 'HOME' | 'PROGRAMFILES'>>;

/** Zet paden uit instellingen om naar echte Windows-/homepaden voordat we zoeken. */
export function expandCliExecutablePath(
  value: string,
  env: CliEnvironment = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
) {
  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
  return unquoted
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%LOCALAPPDATA%/gi, env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, env.APPDATA || '')
    .replace(/%PROGRAMFILES%/gi, env.PROGRAMFILES || '');
}

export function claudeExecutableCandidates(
  configured?: string,
  env: CliEnvironment = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
) {
  return [
    configured ? expandCliExecutablePath(configured, env, home) : '',
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'claude') : '',
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'claude.cmd') : '',
    home ? path.join(home, '.local', 'bin', 'claude.exe') : '',
    home ? path.join(home, '.local', 'bin', 'claude') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe') : '',
    'claude',
  ].filter(Boolean);
}

export function codexExecutableCandidates(
  configured?: string,
  env: CliEnvironment = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
  bundled = newestBundledCodexExecutable(env.LOCALAPPDATA),
) {
  const expandedConfigured = configured ? expandCliExecutablePath(configured, env, home) : '';
  // Een expliciet extern/custom pad blijft leidend. Een opgeslagen pad binnen
  // Codex Desktop kan echter naar de verouderde top-level binary wijzen; daar
  // hoort de nieuwste gevonden desktopbinary vóór te staan.
  const customConfigured = expandedConfigured
    && !isCodexDesktopExecutable(expandedConfigured, env.LOCALAPPDATA)
    ? expandedConfigured
    : '';
  return [
    customConfigured,
    bundled || '',
    expandedConfigured,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'codex.exe') : '',
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'codex.cmd') : '',
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'codex') : '',
    home ? path.join(home, '.local', 'bin', 'codex.exe') : '',
    home ? path.join(home, '.local', 'bin', 'codex') : '',
    'codex',
  ].filter(Boolean);
}

export function antigravityExecutableCandidates(
  configured?: string,
  env: CliEnvironment = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
) {
  return [
    configured ? expandCliExecutablePath(configured, env, home) : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy') : '',
    home ? path.join(home, '.local', 'bin', 'agy') : '',
    'agy',
  ].filter(Boolean);
}

/** Vind eerst een echt bestand en val pas daarna terug op PATH (`where`/`which`). */
export async function findCliExecutable(candidates: string[], options: { pathLookup?: boolean } = {}) {
  const expanded = candidates.map((candidate) => expandCliExecutablePath(candidate));
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

  for (const candidate of expanded) {
    // Een kale commandonaam hoort uitsluitend via PATH te worden opgelost. Anders
    // kan een `claude.cmd` in de geopende projectmap een echte installatie kapen.
    if (!path.isAbsolute(candidate) && !candidate.includes('/') && !candidate.includes('\\')) continue;
    for (const extension of extensions) {
      const file = extension && !candidate.toLowerCase().endsWith(extension)
        ? `${candidate}${extension}`
        : candidate;
      try {
        const resolved = path.resolve(file);
        if (isWindowsAppExecutionAlias(resolved)) continue;
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {
        // Volgende kandidaat proberen.
      }
    }
  }

  if (options.pathLookup === false) return null;

  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  const commandNames = [...new Set(expanded.map((candidate) => path.basename(candidate)).filter(Boolean))];
  for (const commandName of commandNames) {
    const found = await new Promise<string | null>((resolve) => {
      const child = spawn(resolver, [commandName], { windowsHide: true });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.on('close', (code) => {
        if (code !== 0) { resolve(null); return; }
        const hit = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .find((line) => {
            if (isWindowsAppExecutionAlias(line)) return false;
            try { return fs.statSync(line).isFile(); } catch { return false; }
          });
        resolve(hit || null);
      });
      child.on('error', () => resolve(null));
    });
    if (found) {
      const resolved = path.resolve(found);
      if (!isWindowsAppExecutionAlias(resolved)) {
        try {
          if (fs.statSync(resolved).isFile()) return resolved;
        } catch {
          // Een verouderde PATH-hit is geen bruikbaar executable.
        }
      }
    }
  }

  return null;
}

/** WindowsApps bevat App Execution Aliases die vanuit Electron geregeld EACCES geven. */
export function isWindowsAppExecutionAlias(value: string) {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(path.resolve(value));
}
