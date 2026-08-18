import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface CliSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export type AgentShellProcess = 'powershell' | 'pwsh' | 'cmd';

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Een verpakte Electron-app erft op een verse Windows-installatie niet altijd
 * hetzelfde PATH als een interactieve terminal. Gebruik daarom het echte
 * Windows PowerShell-pad als dat bestaat.
 */
export function windowsPowerShellExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync,
) {
  const windowsRoot = String(environment.SystemRoot || environment.WINDIR || '').trim();
  if (windowsRoot) {
    const candidate = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function escapeCmdCommand(value: string) {
  return value.replace(CMD_META_CHARS, '^$1');
}

function escapeCmdArgument(value: string) {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1');
  escaped = `"${escaped}"`;
  return escaped.replace(CMD_META_CHARS, '^$1');
}

/**
 * Node kan een Windows npm-shim (`.cmd`/`.bat`) niet rechtstreeks starten.
 * Houd de omzetting op één plek, zodat ook handmatig ingestelde Codex- en
 * Antigravity-shims hetzelfde gedrag krijgen als Claude.
 */
export function cliSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.COMSPEC || 'cmd.exe',
): CliSpawnSpec {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }
  const shellCommand = [escapeCmdCommand(executable), ...args.map(escapeCmdArgument)].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * node-pty verwacht op Windows voor `cmd.exe` een reeds opgebouwde commandline.
 * Een argv-array escapt de quotes van een npm-`.cmd` letterlijk (`\"...\"`),
 * waardoor de echte provider-shim niet start.
 */
export function cliPtySpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.COMSPEC || 'cmd.exe',
): { command: string; args: string[] | string } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }
  const commandLine = [quotePtyCmdArgument(executable), ...args.map(quotePtyCmdArgument)].join(' ');
  return {
    command: comspec,
    args: `/d /s /c "${commandLine}"`,
  };
}

function quotePtyCmdArgument(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Start een door de agent gekozen shell zonder dat Windows aanhalingstekens
 * rond bestandsnamen met spaties opnieuw interpreteert. Vooral `cmd /s /c`
 * heeft een extra buitenste quote en verbatim argumentdoorgifte nodig.
 */
export function agentShellSpawnSpec(
  shell: AgentShellProcess,
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CliSpawnSpec {
  if (platform !== 'win32') {
    return {
      command: environment.SHELL || '/bin/sh',
      args: ['-lc', command],
    };
  }
  if (shell === 'cmd') {
    return {
      command: environment.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (shell === 'pwsh') {
    return {
      command: 'pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return {
    command: windowsPowerShellExecutable(environment),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  };
}

export function terminateProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }) {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
      return;
    } catch { /* val terug op child.kill */ }
  }
  try { child.kill('SIGTERM'); } catch { /* proces is al gesloten */ }
}

export function clipNativeOutput(value: unknown, maxChars = 100_000) {
  const text = typeof value === 'string' ? value : String(value || '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[uitvoer afgekapt na ${maxChars.toLocaleString('nl-NL')} tekens]`;
}
