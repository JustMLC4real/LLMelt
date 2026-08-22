import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import { agentCommandEnvironment } from './agent-command-environment';
import { cliSpawnSpec, terminateProcessTree } from './process-utils';
import { ProviderRuntimeError } from './provider-runtime';

export async function runProviderProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  input?: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = agentCommandEnvironment(),
  language: UiLanguage = 'nl',
) {
  if (signal.aborted) {
    throw new ProviderRuntimeError(localizedText(language, 'Procesverzoek geannuleerd.', 'Process request cancelled.'), 'cancelled');
  }

  return new Promise<{ text: string }>((resolve, reject) => {
    const spawnSpec = cliSpawnSpec(command, args);
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      windowsHide: true,
      cwd,
      env,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let text = '';
    let errorText = '';
    let settled = false;

    const finish = (error?: ProviderRuntimeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      if (error) {
        terminateProcessTree(proc);
        reject(error);
      } else {
        resolve({ text });
      }
    };
    const onAbort = () => finish(new ProviderRuntimeError(localizedText(language, 'Procesverzoek geannuleerd.', 'Process request cancelled.'), 'cancelled'));
    const timeoutTimer = setTimeout(() => {
      finish(new ProviderRuntimeError(localizedText(language, 'CLI-proces stopte niet binnen 600 seconden.', 'The CLI process did not finish within 600 seconds.'), 'network'));
    }, 600_000);

    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }

    if (proc.stdin) {
      proc.stdin.on('error', () => { });
      if (input !== undefined) proc.stdin.write(input);
      proc.stdin.end();
    }

    proc.stdout?.on('data', (data) => {
      const delta = data.toString();
      text += delta;
      if (text.length > 5_000_000) {
        finish(new ProviderRuntimeError(localizedText(language, 'CLI-uitvoer overschreed de limiet van 5 MB.', 'CLI output exceeded the 5 MB limit.'), 'provider_error'));
        return;
      }
      onDelta(delta);
    });
    proc.stderr?.on('data', (data) => {
      errorText = `${errorText}${data.toString()}`.slice(-100_000);
    });
    proc.on('error', (error) => finish(new ProviderRuntimeError(error.message, 'provider_error')));
    proc.on('close', (code) => {
      if (code !== 0) {
        finish(new ProviderRuntimeError(
          errorText || localizedText(language, `${path.basename(command)} stopte met code ${code ?? 'onbekend'}`, `${path.basename(command)} exited with code ${code ?? 'unknown'}`),
          'provider_error',
        ));
      } else {
        finish();
      }
    });
  });
}

export async function runCodexAgent(options: {
  exe: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  timeoutSeconds: number;
  onStatus: (status: string) => void;
  language?: UiLanguage;
}) {
  const language = options.language || 'nl';
  if (options.signal.aborted) {
    throw new ProviderRuntimeError(localizedText(language, 'Codex-verzoek geannuleerd.', 'Codex request cancelled.'), 'cancelled');
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-codex-'));
  const outputFile = path.join(dir, 'last-message.txt');

  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const args = [...options.args, '--output-last-message', outputFile, '-'];
      const spawnSpec = cliSpawnSpec(options.exe, args);
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        windowsHide: true,
        cwd: dir,
        env: agentCommandEnvironment(),
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      });
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(statusTimer);
        clearTimeout(timeoutTimer);
        options.signal.removeEventListener('abort', abortHandler);
        if (error) {
          terminateProcessTree(proc);
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      };
      const publishStatus = () => {
        const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        options.onStatus(localizedText(language, `Codex draait: ${seconds}s`, `Codex is running: ${seconds}s`));
      };
      const statusTimer = setInterval(publishStatus, 1000);
      const timeoutTimer = setTimeout(() => {
        finish(new ProviderRuntimeError(localizedText(language, `Codex stopte niet binnen ${options.timeoutSeconds}s.`, `Codex timed out after ${options.timeoutSeconds}s.`), 'network'));
      }, Math.max(1, options.timeoutSeconds) * 1000);
      const abortHandler = () => finish(new ProviderRuntimeError(localizedText(language, 'Codex-verzoek geannuleerd.', 'Codex request cancelled.'), 'cancelled'));

      options.signal.addEventListener('abort', abortHandler);
      publishStatus();
      proc.stdin.on('error', () => { });
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) parseCodexJsonStatus(line, options.onStatus, language);
      });
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      proc.on('error', (error) => finish(new ProviderRuntimeError(error.message, 'provider_error')));
      proc.on('close', (code) => {
        if (stdoutBuffer) parseCodexJsonStatus(stdoutBuffer, options.onStatus, language);
        if (code !== 0) {
          const codexError = extractCodexError(stdout) || extractCodexError(stderr);
          finish(new ProviderRuntimeError(
            codexError || cleanProcessError(stderr || stdout || localizedText(language, `Codex stopte met code ${code ?? 'onbekend'}`, `Codex exited with code ${code ?? 'unknown'}`), language),
            codexError && /usage limit|rate limit|quota/i.test(codexError) ? 'rate_limit' : 'provider_error',
          ));
          return;
        }
        finish();
      });
      proc.stdin.write(options.prompt);
      proc.stdin.end();
    });

    const fileText = await fs.promises.readFile(outputFile, 'utf8').catch(() => '');
    const text = normalizeCodexFinalText(fileText) || extractCodexFinalText(result.stdout);
    if (!text) {
      const codexError = extractCodexError(result.stdout) || extractCodexError(result.stderr);
      throw new ProviderRuntimeError(
        codexError || cleanProcessError(result.stderr || result.stdout || localizedText(language, 'Codex gaf geen eindantwoord terug.', 'Codex returned no final message.'), language),
        codexError && /usage limit|rate limit|quota/i.test(codexError) ? 'rate_limit' : 'provider_error',
      );
    }
    return { text };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

function parseCodexJsonStatus(line: string, onStatus: (status: string) => void, language: UiLanguage) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const type = String(event.type || event.event || event.msg?.type || '');
    if (/error/i.test(type)) {
      const message = event.message || event.error?.message || event.msg?.message;
      if (message) onStatus(localizedText(language, `Codex-fout: ${message}`, `Codex error: ${message}`));
      return;
    }
    if (/tool|exec|command|turn|task|agent/i.test(type)) {
      onStatus(localizedText(language, `Codex-agent: ${type}`, `Codex agent: ${type}`));
    }
  } catch {
    // Niet-JSON-uitvoer is geen status-event; het eindantwoord komt uit het outputbestand.
  }
}

function extractCodexError(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      const type = String(event.type || '');
      const candidate = event.error?.message
        || (type === 'error' ? event.message : undefined)
        || (type === 'item.completed' && event.item?.type === 'error' ? event.item?.message : undefined);
      if (candidate && !/malformed agent role/i.test(String(candidate))) return String(candidate);
    } catch {
      // Negeer gewone CLI-regels.
    }
  }
  return null;
}

function normalizeCodexFinalText(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}

function extractCodexFinalText(stdout: string) {
  const normalized = normalizeCodexFinalText(stdout);
  const codexBlock = normalized.match(/\ncodex\n([\s\S]*?)(?:\ntokens used|$)/i);
  if (codexBlock?.[1]?.trim()) return codexBlock[1].trim();

  const jsonMessages = normalized
    .split(/\r?\n/)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .map((event: any) => event.message || event.text || event.msg?.message || event.msg?.content || '')
    .filter((value: string) => value && typeof value === 'string');
  if (jsonMessages.length) return jsonMessages[jsonMessages.length - 1].trim();

  return normalized
    .split(/\r?\n/)
    .filter((line) => !/^(OpenAI Codex|[-]{5,}|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|codex$|tokens used|\d[\d.]*$)/i.test(line.trim()))
    .filter((line) => !/\bWARN\b|\bERROR\b/.test(line))
    .join('\n')
    .trim();
}

function cleanProcessError(text: string, language: UiLanguage) {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .filter((line) => !/\b(WARN|INFO|DEBUG|TRACE)\b/.test(line))
    .filter((line) => !/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s/.test(line.trim()))
    .join('\n')
    .trim();
  if (cleaned) return cleaned.slice(0, 2000);
  return localizedText(
    language,
    'De CLI gaf geen leesbaar antwoord, alleen waarschuwingen. Controleer je CLI-configuratie/plugins en of het gekozen model beschikbaar is.',
    'The CLI returned no readable response, only warnings. Check your CLI configuration/plugins and whether the selected model is available.',
  );
}
