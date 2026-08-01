import { spawn } from 'child_process';

export interface CliSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export type AgentShellProcess = 'powershell' | 'pwsh' | 'cmd';

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

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
    command: 'powershell.exe',
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
