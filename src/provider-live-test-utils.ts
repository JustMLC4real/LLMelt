import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { NativeToolActivity, NativeToolExecutionResult, NativeToolExecutor } from '../electron/native-tools';
import { agentShellSpawnSpec } from '../electron/process-utils';
import { normalizePowerShell5ConditionalChain } from '../electron/windows-command-normalization';

const execFileAsync = promisify(execFile);

export const SKYLINE_LIVE_PROMPT = 'Maak nu als Python-script een artistieke stadsskyline tekenen, visueel duidelijk verschillend zijn, ANSI-kleuren en een korte animatie gebruiken, Sla de definitieve scripts op, voer ze allebei uit en toon hier zowel de volledige code als de uiteindelijke terminaluitvoer zonder kleurcodes.';

export interface LiveProviderRun {
  text: string;
  activities: NativeToolActivity[];
}

export function createIsolatedNativeExecutor(root: string): NativeToolExecutor {
  const resolveInsideRoot = (requested: unknown) => {
    const relative = String(requested || '').trim();
    if (!relative) throw new Error('Toolpad ontbreekt.');
    const target = path.resolve(root, relative);
    const boundary = `${path.resolve(root)}${path.sep}`.toLowerCase();
    if (target.toLowerCase() !== path.resolve(root).toLowerCase() && !target.toLowerCase().startsWith(boundary)) {
      throw new Error('Toolpad valt buiten de tijdelijke projectmap.');
    }
    return target;
  };

  return async (toolName, input): Promise<NativeToolExecutionResult> => {
    try {
      const name = toolName.toLowerCase();
      if (name === 'read_file') {
        const target = resolveInsideRoot(input.path);
        return { ok: true, output: await fs.promises.readFile(target, 'utf8') };
      }
      if (name === 'write_file') {
        const target = resolveInsideRoot(input.path);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const overwrite = input.overwrite !== false;
        await fs.promises.writeFile(target, String(input.content || ''), { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
        return { ok: true, output: `created ${path.relative(root, target)}` };
      }
      if (name === 'edit_file') {
        const target = resolveInsideRoot(input.path);
        const current = await fs.promises.readFile(target, 'utf8');
        const oldText = String(input.old_text || '');
        const newText = String(input.new_text || '');
        if (!oldText || !current.includes(oldText)) return { ok: false, output: '[geen wijziging] old_text niet gevonden' };
        const next = input.replace_all === true
          ? current.split(oldText).join(newText)
          : current.replace(oldText, newText);
        await fs.promises.writeFile(target, next, 'utf8');
        return { ok: true, output: `edited ${path.relative(root, target)}` };
      }
      if (name === 'run_command') {
        const requestedCommand = String(input.command || '').trim();
        if (!requestedCommand) return { ok: false, output: 'Commando ontbreekt.' };
        const shell = String(input.shell || 'powershell').toLowerCase();
        const requestedExecutable = shell === 'cmd' ? 'cmd.exe' : shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
        const executable = shell === 'pwsh' && !windowsCommandExists('pwsh.exe')
          ? 'powershell.exe'
          : requestedExecutable;
        const effectiveShell = executable === 'cmd.exe' ? 'cmd' : executable === 'pwsh.exe' ? 'pwsh' : 'powershell';
        const command = normalizePowerShell5ConditionalChain(requestedCommand, effectiveShell);
        const spec = agentShellSpawnSpec(effectiveShell, command, process.platform, {
          ...process.env,
          COMSPEC: executable === 'cmd.exe' ? executable : process.env.COMSPEC,
        });
        try {
          const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            windowsHide: true,
            windowsVerbatimArguments: spec.windowsVerbatimArguments,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          });
          return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() || '[exit 0]' };
        } catch (error: any) {
          const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n').trim();
          return { ok: false, output: output || 'Commando mislukt.' };
        }
      }
      return { ok: false, output: `Onbekende testtool: ${toolName}` };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  };
}

function windowsCommandExists(command: string) {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync('where.exe', [command], {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function assertSkylineArtifacts(root: string, run: LiveProviderRun) {
  const pythonFiles = (await fs.promises.readdir(root, { recursive: true }))
    .map(String)
    .filter((name) => name.toLowerCase().endsWith('.py'));
  const sources = await Promise.all(pythonFiles.map((name) => fs.promises.readFile(path.join(root, name), 'utf8')));
  const successfulCommands = run.activities.filter((activity) => (
    ['run_command', 'bash', 'powershell', 'command'].includes(activity.toolName.toLowerCase())
      && activity.phase === 'result'
      && activity.ok === true
  ));
  const failedResults = run.activities.filter((activity) => activity.phase === 'result' && activity.ok === false);
  const executedPythonFiles = pythonFiles.filter((fileName) => {
    const normalizedFile = fileName.replace(/\\/g, '/').toLowerCase();
    const basename = path.basename(normalizedFile);
    return successfulCommands.some((activity) => {
      // Antigravity publiceert de officiële run_command-parameter als
      // `CommandLine`; de andere native providers gebruiken `command`.
      const command = String(activity.input?.command || activity.input?.CommandLine || '')
        .replace(/\\/g, '/')
        .toLowerCase();
      return command.includes(normalizedFile) || command.includes(basename);
    });
  });
  return {
    pythonFiles,
    sources,
    successfulCommands,
    executedPythonFiles,
    failedResults,
    hasAnsi: sources.some((source) => /(?:\\x1b|\\033|\\u001b|colorama)/i.test(source)),
    hasAnimation: sources.some((source) => /time\s*\.\s*sleep|sleep\s*\(/i.test(source)),
  };
}

export async function createLiveCaseDirectory(root: string, name: string) {
  const directory = path.join(root, name);
  await fs.promises.mkdir(directory, { recursive: true });
  return directory;
}
