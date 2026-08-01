import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export interface PythonRuntimeStatus {
  ready: boolean;
  executablePath?: string;
  version?: string;
  managerAvailable: boolean;
  detail: string;
}

export interface PythonInstallerProgress {
  percent: number;
  transferred?: number;
  total?: number;
}

export const PYTHON_INSTALL_MANAGER_PACKAGE_ID = '9NQ7512CXL7T';

export function pythonInstallManagerCommands() {
  return [
    {
      phase: 'configuring' as const,
      status: 'Python Install Manager configureren...',
      args: ['install', '--configure', '-y'],
    },
    {
      phase: 'installing' as const,
      status: 'Nieuwste stabiele Python 3-runtime installeren...',
      args: ['install', '3', '-y'],
    },
  ];
}

export async function getPythonRuntimeStatus(
  configured?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonRuntimeStatus> {
  const candidates = await pythonExecutableCandidates(configured, env);
  for (const candidate of candidates) {
    const version = await probePythonExecutable(candidate);
    if (!version) continue;
    const executablePath = path.isAbsolute(candidate) ? path.resolve(candidate) : candidate;
    return {
      ready: true,
      executablePath,
      version,
      managerAvailable: await commandWorks('py', ['help']),
      detail: `${version} gevonden.`,
    };
  }

  return {
    ready: false,
    managerAvailable: await commandWorks('py', ['help']),
    detail: 'Geen werkende Python-runtime gevonden.',
  };
}

export function activatePythonRuntime(executablePath: string | undefined) {
  if (!executablePath) return;
  process.env.AI_SUPERAPP_PYTHON = executablePath;
  if (!path.isAbsolute(executablePath)) return;
  const directory = path.dirname(executablePath);
  process.env.PATH = prependPathEntry(process.env.PATH, directory);
}

export function pythonRuntimeEnvironment(base: NodeJS.ProcessEnv = process.env) {
  const executable = String(base.AI_SUPERAPP_PYTHON || '').trim();
  if (!path.isAbsolute(executable)) return base;
  return {
    ...base,
    PATH: prependPathEntry(base.PATH, path.dirname(executable)),
  };
}

export function prependPathEntry(current: string | undefined, entry: string) {
  const items = String(current || '').split(path.delimiter).filter(Boolean);
  const normalized = path.resolve(entry).toLocaleLowerCase();
  const withoutDuplicate = items.filter((item) => {
    try {
      return path.resolve(item).toLocaleLowerCase() !== normalized;
    } catch {
      return true;
    }
  });
  return [entry, ...withoutDuplicate].join(path.delimiter);
}

export function parsePythonVersion(output: string) {
  const match = String(output || '').trim().match(/\bPython\s+(\d+\.\d+(?:\.\d+)?(?:[a-z0-9.+-]*)?)/i);
  return match ? `Python ${match[1]}` : null;
}

function bytesFromUnit(value: string, unit: string) {
  const number = Number(value.replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return null;
  const multiplier = ({
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
  } as const)[unit.toLocaleLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return multiplier ? Math.round(number * multiplier) : null;
}

/**
 * Winget en Python Install Manager hebben geen vast JSON-progressprotocol.
 * We tonen daarom alleen een percentage wanneer hun echte uitvoer zelf een
 * percentage of een ontvangen/totaal-byteverhouding bevat.
 */
export function parsePythonInstallerProgress(output: string): PythonInstallerProgress | null {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  const normalized = String(output || '').replace(ansiSequence, '').replace(/\r/g, '\n');
  const percentages = [...normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)];
  const rawPercent = percentages.at(-1)?.[1];
  if (rawPercent !== undefined) {
    return {
      percent: Math.min(100, Math.max(0, Math.round(Number(rawPercent.replace(',', '.'))))),
    };
  }

  const bytePairs = [...normalized.matchAll(
    /(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)/gi,
  )];
  const pair = bytePairs.at(-1);
  if (!pair) return null;
  const transferred = bytesFromUnit(pair[1], pair[2]);
  const total = bytesFromUnit(pair[3], pair[4]);
  if (transferred === null || total === null || total <= 0) return null;
  return {
    percent: Math.min(100, Math.max(0, Math.round((transferred * 100) / total))),
    transferred,
    total,
  };
}

async function pythonExecutableCandidates(configured: unknown, env: NodeJS.ProcessEnv) {
  const candidates = [
    String(configured || '').trim(),
    String(env.AI_SUPERAPP_PYTHON || '').trim(),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Python', 'bin', 'python.exe') : '',
  ].filter(Boolean);

  if (process.platform === 'win32') {
    candidates.push(...await whereCommands(['python.exe', 'python3.exe']));
  } else {
    candidates.push('python3', 'python');
  }
  return [...new Set(candidates)];
}

async function whereCommands(names: string[]) {
  const found: string[] = [];
  for (const name of names) {
    const output = await captureProcess('where.exe', [name], 5_000);
    if (!output.ok) continue;
    for (const line of output.output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try {
        if (fs.statSync(line).isFile()) found.push(path.resolve(line));
      } catch {
        // Verouderde PATH-hit overslaan.
      }
    }
  }
  return found;
}

async function probePythonExecutable(executable: string) {
  const output = await captureProcess(executable, ['--version'], 7_000);
  if (!output.ok) return null;
  return parsePythonVersion(output.output);
}

async function commandWorks(executable: string, args: string[]) {
  const output = await captureProcess(executable, args, 7_000);
  return output.ok;
}

function captureProcess(executable: string, args: string[], timeoutMs: number) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    let settled = false;
    let output = '';
    let child;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ ok: false, output: '' });
      return;
    }
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok, output });
    };
    child.stdout?.on('data', (data) => { output += data.toString(); });
    child.stderr?.on('data', (data) => { output += data.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
  });
}
