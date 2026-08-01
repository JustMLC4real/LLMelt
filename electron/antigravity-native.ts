// Native Antigravity CLI-tools via officiële PreToolUse/PostToolUse hooks.
//
// `agy --print` heeft geen ACP- of permission-callback. Antigravity-hooks hebben die
// semantiek wel: een PreToolUse-hook ontvangt de volledige toolcall als JSON en kan
// allow/deny teruggeven. Een tijdelijke workspace-plugin stuurt elk hook-event via een
// getokende localhost-verbinding naar het Electron-mainproces en wordt na de beurt gewist.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { app } from 'electron';
import type { AgentApprovalMode } from '../src/providers/types';
import type { NativePermissionHandler, NativeToolActivity } from './native-tools';
import { antigravityFinalTranscriptText, antigravityPartialSummary } from './antigravity-output';
import { cliSpawnSpec, clipNativeOutput, terminateProcessTree } from './process-utils';
import { agentCommandEnvironment } from './agent-command-environment';

export interface RunAntigravityNativeOptions {
  exe: string;
  modelId: string;
  prompt: string;
  cwd: string;
  agentMode: AgentApprovalMode;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  requestPermission: NativePermissionHandler;
}

export interface RunAntigravityNativeResult {
  text: string;
}

interface AntigravityHookEvent {
  conversationId?: string;
  stepIdx?: number;
  transcriptPath?: string;
  error?: string;
  terminationReason?: string;
  fullyIdle?: boolean;
  toolCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface PendingAntigravityTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const BRIDGE_SCRIPT = String.raw`
const http = require('http');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => body += chunk);
process.stdin.on('end', () => {
  const url = process.env.AI_SUPERAPP_AGY_HOOK_URL;
  const token = process.env.AI_SUPERAPP_AGY_HOOK_TOKEN;
  if (!url || !token) { process.stdout.write(JSON.stringify({ decision: 'ask' })); return; }
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch {}
  const target = new URL(url);
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname,
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length,
      'authorization': 'Bearer ' + token } }, (res) => {
        let out = ''; res.setEncoding('utf8'); res.on('data', c => out += c);
        res.on('end', () => process.stdout.write(out || '{}'));
      });
  req.on('error', () => process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'LLMelt approval-brug niet bereikbaar.' })));
  req.write(data); req.end();
});
`;

let bridgePath: string | null = null;
let hookMutationTail: Promise<void> = Promise.resolve();

export async function runAntigravityNative(options: RunAntigravityNativeOptions): Promise<RunAntigravityNativeResult> {
  if (options.signal.aborted) throw new Error('cancelled');
  const promptTransport = await createPromptTransport(options.prompt);
  let toolStarted = false;
  let completedTools = 0;
  let failedTools = 0;
  let deniedTools = 0;
  let stopContinuations = 0;
  const pending = new Map<string, PendingAntigravityTool>();
  const lastPendingByConversation = new Map<string, PendingAntigravityTool>();
  const transcriptPaths = new Set<string>();
  const decisionServer = await startHookServer(async (event) => {
    if (event.transcriptPath) transcriptPaths.add(event.transcriptPath);
    const conversationId = String(event.conversationId || 'conversation');
    const stepIdx = Number.isFinite(event.stepIdx) ? Number(event.stepIdx) : -1;
    const key = `${conversationId}:${stepIdx}`;

    // De officiële Stop-hook is de enige betrouwbare plek om een vroegtijdige
    // exit ná tools nog binnen dezelfde Antigravity-beurt te laten herstellen.
    // Zonder deze gate kan printmodus met exitcode 0 sluiten terwijl er nog geen
    // eindantwoord (of zelfs geen PostToolUse voor de laatste tool) bestaat.
    if (typeof event.terminationReason === 'string' || typeof event.fullyIdle === 'boolean') {
      const hasFinalText = event.transcriptPath
        ? !!(await readAntigravityFinalText(new Set([event.transcriptPath])))
        : false;
      const unresolved = uniquePendingTools(pending, lastPendingByConversation).length;
      if (stopContinuations < 2 && (unresolved > 0 || (toolStarted && !hasFinalText))) {
        stopContinuations += 1;
        const reason = unresolved > 0
          ? `${unresolved} toolactie(s) hebben nog geen PostToolUse-resultaat. Controleer eerst of de actie echt is uitgevoerd; herstel of voer opnieuw uit als dat nodig is en geef daarna één kort eindantwoord.`
          : 'De tools zijn klaar, maar het eindantwoord ontbreekt. Geef nu één kort eindantwoord zonder nieuwe tools, tenzij een concrete controle nog noodzakelijk is.';
        options.onStatus?.('Antigravity rondt de toolbeurt af...');
        return { decision: 'continue', reason };
      }
      return { decision: 'stop' };
    }

    const isPostToolUse = Object.prototype.hasOwnProperty.call(event, 'error');
    if (event.toolCall && !isPostToolUse) {
      toolStarted = true;
      const name = String(event.toolCall.name || 'onbekende_tool');
      const input = event.toolCall.args && typeof event.toolCall.args === 'object' ? event.toolCall.args : {};
      if (promptTransport.file && isInternalPromptRead(name, input, promptTransport.file)) {
        return { decision: 'allow', reason: 'Interne promptoverdracht van LLMelt.' };
      }
      const tool = { id: `agy-${conversationId}-${stepIdx}-${crypto.randomBytes(3).toString('hex')}`, name, input };
      pending.set(key, tool);
      lastPendingByConversation.set(conversationId, tool);
      options.onToolActivity?.({ provider: 'antigravity', toolName: name, input, toolUseId: tool.id, phase: 'requested' });
      options.onStatus?.(`Antigravity gebruikt ${name}`);
      const verdict = await options.requestPermission(name, input);
      options.onToolActivity?.({ provider: 'antigravity', toolName: name, input, toolUseId: tool.id, phase: verdict.allow ? 'approved' : 'denied' });
      if (!verdict.allow) {
        deniedTools += 1;
        pending.delete(key);
        if (lastPendingByConversation.get(conversationId)?.id === tool.id) lastPendingByConversation.delete(conversationId);
      }
      return { decision: verdict.allow ? 'allow' : 'deny', reason: verdict.message || (verdict.allow ? 'Goedgekeurd door LLMelt.' : 'Geweigerd door gebruiker.') };
    }

    const tool = pending.get(key) || lastPendingByConversation.get(conversationId);
    if (tool) {
      pending.delete(key);
      if (lastPendingByConversation.get(conversationId)?.id === tool.id) lastPendingByConversation.delete(conversationId);
      const output = await antigravityToolOutput(event.transcriptPath, stepIdx, event.error);
      completedTools += 1;
      if (event.error) failedTools += 1;
      options.onToolActivity?.({
        provider: 'antigravity',
        toolName: tool.name,
        input: tool.input,
        toolUseId: tool.id,
        phase: 'result',
        ok: !event.error,
        output: clipNativeOutput(output),
      });
    }
    return {};
  }).catch(async (error) => {
    await promptTransport.cleanup();
    throw error;
  });

  const logPath = path.join(app.getPath('temp'), `ai-superapp-agy-${crypto.randomBytes(6).toString('hex')}.log`);
  let plugin: Awaited<ReturnType<typeof createHookPlugin>> | undefined;
  try {
    const bridge = ensureBridgeScript();
    plugin = await createHookPlugin(options.cwd);
    const args = [
      // Printmodus heeft geen interactieve TUI om een tweede CLI-permissionprompt
      // af te handelen. De tijdelijke PreToolUse-hook hierboven blijft de
      // autoritatieve app-goedkeuring voor iedere toolactie.
      '--dangerously-skip-permissions',
      '--mode', 'accept-edits',
      '--add-dir', options.cwd,
      ...(promptTransport.file ? ['--add-dir', path.dirname(promptTransport.file)] : []),
      '--log-file', logPath,
      '--print-timeout', '180s',
      '--model', options.modelId,
      '-p', promptTransport.prompt,
    ];
    if (options.agentMode === 'auto-project') args.unshift('--sandbox');
    const env = agentCommandEnvironment({
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AI_SUPERAPP_AGY_NODE: `"${process.execPath}"`,
      AI_SUPERAPP_AGY_BRIDGE: `"${bridge}"`,
      AI_SUPERAPP_AGY_HOOK_URL: decisionServer.url,
      AI_SUPERAPP_AGY_HOOK_TOKEN: decisionServer.token,
    });
    const text = await spawnAgy(options.exe, args, options.cwd, env, options.signal, options.onDelta);
    const unreportedTools = uniquePendingTools(pending, lastPendingByConversation);
    for (const tool of unreportedTools) {
      failedTools += 1;
      options.onToolActivity?.({
        provider: 'antigravity',
        toolName: tool.name,
        input: tool.input,
        toolUseId: tool.id,
        phase: 'result',
        ok: false,
        output: 'Antigravity sloot voordat de CLI een toolresultaat bevestigde.',
      });
    }
    const cleanText = text.trim();
    if (!cleanText) {
      const recoveredText = await readAntigravityFinalText(transcriptPaths);
      if (recoveredText) {
        options.onDelta(recoveredText);
        return { text: recoveredText };
      }
      if (toolStarted) {
        const summary = antigravityPartialSummary(completedTools, failedTools, deniedTools, unreportedTools.length);
        options.onDelta(summary);
        return { text: summary };
      }
      throw new Error('Antigravity sloot zonder eindantwoord.');
    }
    return { text: cleanText };
  } catch (error) {
    if (toolStarted && error && typeof error === 'object') {
      (error as Error & { partialExecution?: boolean }).partialExecution = true;
    }
    throw error;
  } finally {
    decisionServer.stop();
    await plugin?.cleanup();
    await promptTransport.cleanup();
    await fs.promises.rm(logPath, { force: true }).catch(() => { });
  }
}

function uniquePendingTools(
  pending: Map<string, PendingAntigravityTool>,
  lastPendingByConversation: Map<string, PendingAntigravityTool>,
) {
  return [...new Map(
    [...pending.values(), ...lastPendingByConversation.values()].map((tool) => [tool.id, tool]),
  ).values()];
}

async function readAntigravityFinalText(transcriptPaths: Set<string>) {
  for (const transcriptPath of [...transcriptPaths].reverse()) {
    try {
      const final = antigravityFinalTranscriptText(await fs.promises.readFile(transcriptPath, 'utf8'));
      if (final) return final;
    } catch { /* probeer het volgende transcript */ }
  }
  return '';
}

async function createPromptTransport(prompt: string) {
  if (process.platform !== 'win32' || prompt.length <= 20_000) {
    return { prompt, file: undefined as string | undefined, cleanup: async () => { } };
  }
  const file = path.join(app.getPath('temp'), `ai-superapp-agy-prompt-${crypto.randomBytes(8).toString('hex')}.txt`);
  await fs.promises.writeFile(file, prompt, { encoding: 'utf8', flag: 'wx' });
  return {
    prompt: `Lees de volledige gebruikersopdracht uit dit UTF-8-bestand en voer die exact uit: ${file}`,
    file,
    cleanup: () => fs.promises.rm(file, { force: true }).then(() => undefined),
  };
}

function isInternalPromptRead(toolName: string, input: Record<string, unknown>, promptFile: string) {
  if (!/read/i.test(toolName)) return false;
  return Object.values(input).some((value) => typeof value === 'string' && path.resolve(value) === path.resolve(promptFile));
}

function ensureBridgeScript(): string {
  if (bridgePath && fs.existsSync(bridgePath)) return bridgePath;
  const file = path.join(app.getPath('userData'), 'antigravity-hook-bridge.cjs');
  fs.writeFileSync(file, BRIDGE_SCRIPT, 'utf8');
  bridgePath = file;
  return file;
}

async function createHookPlugin(cwd: string) {
  const releaseMutation = await acquireHookMutation();
  const agentsDir = path.join(cwd, '.agents');
  const agentsExisted = fs.existsSync(agentsDir);
  const hooksPath = path.join(agentsDir, 'hooks.json');
  let previous: Buffer | null = null;
  try { previous = await fs.promises.readFile(hooksPath); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') {
      releaseMutation();
      throw error;
    }
  }
  let hooks: Record<string, unknown> = {};
  if (previous) {
    try { hooks = JSON.parse(previous.toString('utf8')); }
    catch {
      releaseMutation();
      throw new Error(`Bestaande Antigravity-hooks zijn geen geldige JSON: ${hooksPath}`);
    }
  }
  const name = `ai-superapp-native-${crypto.randomBytes(6).toString('hex')}`;
  const command = '%AI_SUPERAPP_AGY_NODE% %AI_SUPERAPP_AGY_BRIDGE%';
  hooks[name] = {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 130 }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }],
    Stop: [{ type: 'command', command, timeout: 30 }],
  };
  try {
    await fs.promises.mkdir(agentsDir, { recursive: true });
    await fs.promises.writeFile(recoveryPath(), JSON.stringify({
      hooksPath,
      name,
      agentsDir,
      agentsExisted,
      previous: previous?.toString('base64') || null,
    }), { encoding: 'utf8', flag: 'w' });
    await fs.promises.writeFile(hooksPath, JSON.stringify(hooks, null, 2), 'utf8');
  } catch (error) {
    releaseMutation();
    throw error;
  }
  return {
    cleanup: async () => {
      if (previous) await fs.promises.writeFile(hooksPath, previous).catch(() => { });
      else await fs.promises.rm(hooksPath, { force: true }).catch(() => { });
      if (!agentsExisted) await removeIfEmpty(agentsDir);
      await fs.promises.rm(recoveryPath(), { force: true }).catch(() => { });
      releaseMutation();
    },
  };
}

function recoveryPath() {
  return path.join(app.getPath('userData'), 'antigravity-hook-recovery.json');
}

export async function recoverAntigravityHookMutation() {
  let recovery: any;
  try { recovery = JSON.parse(await fs.promises.readFile(recoveryPath(), 'utf8')); }
  catch { return; }
  if (!recovery?.hooksPath || !recovery?.name) return;

  try {
    const currentText = await fs.promises.readFile(recovery.hooksPath, 'utf8').catch(() => '');
    let current: Record<string, unknown> = {};
    try { current = currentText ? JSON.parse(currentText) : {}; }
    catch {
      if (recovery.previous) await fs.promises.writeFile(recovery.hooksPath, Buffer.from(recovery.previous, 'base64'));
      return;
    }
    delete current[recovery.name];
    if (Object.keys(current).length) await fs.promises.writeFile(recovery.hooksPath, JSON.stringify(current, null, 2), 'utf8');
    else if (recovery.previous) await fs.promises.writeFile(recovery.hooksPath, Buffer.from(recovery.previous, 'base64'));
    else await fs.promises.rm(recovery.hooksPath, { force: true });
    if (!recovery.agentsExisted && recovery.agentsDir) await removeIfEmpty(recovery.agentsDir);
  } finally {
    await fs.promises.rm(recoveryPath(), { force: true }).catch(() => { });
  }
}

async function acquireHookMutation(): Promise<() => void> {
  const previous = hookMutationTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  hookMutationTail = previous.then(() => gate);
  await previous;
  return release;
}

async function removeIfEmpty(dir: string) {
  try {
    if ((await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir);
  } catch { /* map bestond al of is niet leeg */ }
}

function startHookServer(handler: (event: AntigravityHookEvent) => Promise<Record<string, unknown>>) {
  const token = crypto.randomBytes(24).toString('hex');
  return new Promise<{ url: string; token: string; stop: () => void }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401); res.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > 1_000_000) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', async () => {
        if (tooLarge) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason: 'Hook-payload is te groot.' }));
          return;
        }
        let event: AntigravityHookEvent = {};
        try { event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* leeg event */ }
        let result: Record<string, unknown>;
        try { result = await handler(event); }
        catch (error) { result = { decision: 'deny', reason: error instanceof Error ? error.message : String(error) }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/hook`, token, stop: () => { try { server.close(); } catch { /* al dicht */ } } });
    });
  });
}

function spawnAgy(
  exe: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnSpec = cliSpawnSpec(exe, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(stdout);
    };
    const abort = () => { terminateProcessTree(child); finish(new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    child.stdout.on('data', (chunk) => {
      const delta = chunk.toString();
      if (stdoutTruncated) return;
      const accepted = delta.slice(0, 100_000 - stdout.length);
      stdout += accepted;
      if (accepted) onDelta(accepted);
      if (accepted.length < delta.length) {
        stdoutTruncated = true;
        const marker = '\n[Antigravity-uitvoer afgekapt na 100.000 tekens]';
        stdout += marker;
        onDelta(marker);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (error) => finish(new Error(`Antigravity native kon niet starten: ${error.message}`)));
    child.on('close', (code) => {
      if (code && code !== 0) finish(new Error(cleanTail(stderr) || `Antigravity eindigde met code ${code}.`));
      else finish();
    });
  });
}

async function antigravityToolOutput(transcriptPath: string | undefined, stepIdx: number, error?: string): Promise<string> {
  if (error) return error;
  if (!transcriptPath) return 'Uitgevoerd.';
  try {
    const text = await fs.promises.readFile(transcriptPath, 'utf8');
    const rows = text.split(/\r?\n/).filter(Boolean).slice(-160).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const match = rows.find((row: any) => Number(row.step_index) >= stepIdx && row.content && row.type !== 'PLANNER_RESPONSE');
    return String(match?.content || 'Uitgevoerd.').slice(0, 20000);
  } catch {
    return 'Uitgevoerd.';
  }
}

function cleanTail(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(' ').slice(0, 500);
}
