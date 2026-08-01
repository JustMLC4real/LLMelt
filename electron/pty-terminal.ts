import { type IpcMain, type WebContents } from 'electron';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as pty from 'node-pty';
import type { AgentShell } from '../src/providers/types';

type TerminalSession = {
  id: string;
  shell: AgentShell;
  cwd: string;
  ownerId: number;
  process: pty.IPty;
};

const sessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_SESSIONS_PER_RENDERER = 8;

export function registerTerminalIpcHandlers(ipcMain: IpcMain, getDefaultCwd?: () => string) {
  ipcMain.handle('terminal:listShells', async () => listAvailableShells());
  ipcMain.handle('terminal:create', async (event, options?: { shell?: AgentShell; cwd?: string; cols?: number; rows?: number }) => {
    const owner = event.sender;
    const ownedCount = [...sessions.values()].filter((session) => session.ownerId === owner.id).length;
    if (ownedCount >= MAX_TERMINAL_SESSIONS_PER_RENDERER) {
      throw new Error(`Maximaal ${MAX_TERMINAL_SESSIONS_PER_RENDERER} terminals tegelijk toegestaan.`);
    }
    const shell = normalizeShell(options?.shell);
    const cwd = resolveCwd(options?.cwd, getDefaultCwd);
    const cols = clampNumber(options?.cols, 20, 300, 100);
    const rows = clampNumber(options?.rows, 5, 100, 30);
    const spec = shellSpec(shell);
    const id = crypto.randomUUID();

    const term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    sessions.set(id, { id, shell, cwd, ownerId: owner.id, process: term });
    term.onData((data) => {
      if (!owner.isDestroyed()) owner.send('terminal:data', { id, data });
    });
    term.onExit(({ exitCode }) => {
      sessions.delete(id);
      if (!owner.isDestroyed()) owner.send('terminal:exit', { id, exitCode });
    });

    owner.once('destroyed', () => killOwnedSessions(owner));
    return { id, shell, cwd, pid: term.pid };
  });
  ipcMain.handle('terminal:write', async (event, id: string, data: string) => {
    const session = ownedSession(event.sender, id);
    if (!session) return false;
    session.process.write(String(data || ''));
    return true;
  });
  ipcMain.handle('terminal:resize', async (event, id: string, cols: number, rows: number) => {
    const session = ownedSession(event.sender, id);
    if (!session) return false;
    session.process.resize(clampNumber(cols, 20, 300, 100), clampNumber(rows, 5, 100, 30));
    return true;
  });
  ipcMain.handle('terminal:kill', async (event, id: string) => {
    const session = ownedSession(event.sender, id);
    if (!session) return false;
    session.process.kill();
    sessions.delete(id);
    return true;
  });
}

function ownedSession(owner: WebContents, id: string) {
  const session = sessions.get(String(id || ''));
  return session?.ownerId === owner.id ? session : undefined;
}

function killOwnedSessions(owner: WebContents) {
  for (const session of sessions.values()) {
    if (session.ownerId === owner.id) {
      session.process.kill();
      sessions.delete(session.id);
    }
  }
}

function listAvailableShells(): Array<{ id: AgentShell; label: string; available: boolean }> {
  return [
    { id: 'powershell', label: 'PowerShell', available: commandExists('powershell.exe') },
    { id: 'cmd', label: 'Cmd', available: commandExists('cmd.exe') },
    { id: 'pwsh', label: 'PowerShell 7', available: commandExists('pwsh.exe') },
  ];
}

function shellSpec(shell: AgentShell): { file: string; args: string[] } {
  if (process.platform !== 'win32') {
    const fallback = process.env.SHELL || '/bin/sh';
    return { file: fallback, args: [] };
  }
  if (shell === 'cmd') return { file: 'cmd.exe', args: [] };
  if (shell === 'pwsh') return { file: 'pwsh.exe', args: ['-NoLogo'] };
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

function normalizeShell(shell?: AgentShell): AgentShell {
  if (shell === 'cmd' || shell === 'pwsh' || shell === 'powershell') return shell;
  return 'powershell';
}

function resolveCwd(cwd?: string, getDefaultCwd?: () => string) {
  if (cwd && path.isAbsolute(cwd) && fs.existsSync(cwd)) return cwd;
  try {
    const fallback = getDefaultCwd?.();
    if (fallback && path.isAbsolute(fallback) && fs.existsSync(fallback)) return fallback;
  } catch {
    /* val terug op home hieronder */
  }
  return os.homedir() || process.cwd();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function commandExists(command: string) {
  if (process.platform !== 'win32') return command === 'powershell.exe' || command === 'cmd.exe' ? false : true;
  const result = spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}
