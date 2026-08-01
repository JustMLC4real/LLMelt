// Native Claude Code CLI tool-execution.
//
// In plaats van het tag-systeem (waarbij het model <file-edit>-tags emit die de app
// uitvoert) laat dit Claude Code ZELF z'n tools draaien (Read/Write/Edit/Bash/…) in de
// projectmap van de chat. Vóór elke tool vraagt Claude om goedkeuring via het
// --permission-prompt-tool-mechanisme; wij routeren die naar de bestaande approval-popup.
//
// Bewezen mechanisme (zie docs/06-agent-tools.md §6.8): claude v2.1.x accepteert
// `--permission-prompt-tool mcp__<srv>__approval_prompt`. De MCP-tool krijgt
// { tool_name, input, tool_use_id } en moet text-content teruggeven met JSON
// { behavior: "allow", updatedInput } of { behavior: "deny", message }.
//
// Hosting: we draaien een piepklein stdio-MCP-brugscriptje (geschreven naar temp,
// uitgevoerd via ELECTRON_RUN_AS_NODE) dat per permissie-verzoek een localhost-HTTP-call
// doet naar een in-proces beslis-endpoint. Zo blijft de beslissing IN het main-proces en
// kan die direct de bestaande popup gebruiken — zonder losse gebundelde bestanden.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import type { AgentApprovalMode } from '../src/providers/types';
import type { NativePermissionHandler, NativeToolActivity } from './native-tools';
import { cliSpawnSpec, clipNativeOutput, terminateProcessTree } from './process-utils';
import { claudeResultFailure, claudeTextDeltasForEvent, createClaudeTextStreamState } from './claude-stream';
import { agentCommandEnvironment } from './agent-command-environment';

const PERMISSION_TOOL = 'approval_prompt';
const MCP_SERVER_NAME = 'appperm';

// tool_result-content kan een string zijn of een array van {type:'text',text}.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && (part as any).type === 'text' ? String((part as any).text || '') : '')))
      .join('');
  }
  return '';
}

export interface RunClaudeNativeOptions {
  exe: string;
  modelId: string;      // zonder de claude-cli: prefix
  prompt: string;       // volledige prompt (geschiedenis + system) via stdin
  cwd: string;          // projectmap
  effort?: string;
  agentMode: AgentApprovalMode;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  timeoutSeconds?: number;
  // Vraag de gebruiker (of auto-project-logica) om goedkeuring. Resolvt allow/deny.
  requestPermission: NativePermissionHandler;
}

export interface RunClaudeNativeResult {
  text: string;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
}

// Env-vars die een child-claude herconfigureren tot "SDK child session" en daardoor het
// --permission-prompt-tool NIET honoreren (bewezen tijdens de probe), plus de API-proxy.
// In de losse Electron-app staan die normaal niet, maar we schonen defensief.
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_EFFORT',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'MCP_CONNECTION_NONBLOCKING',
];

export function claudeCliEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIP_ENV) delete env[key];
  return agentCommandEnvironment(env);
}

// Het brugscript: een minimale stdio-MCP-server (raw JSON-RPC, alleen Node-builtins) die
// per tools/call een HTTP-POST naar het beslis-endpoint doet en het behavior teruggeeft.
const BRIDGE_SCRIPT = String.raw`
const http = require('http');
const readline = require('readline');
const DECIDE_URL = process.env.APPPERM_URL;
const TOKEN = process.env.APPPERM_TOKEN;
function send(m){ process.stdout.write(JSON.stringify(m) + '\n'); }
function decide(args){
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(args || {}), 'utf8');
    const u = new URL(DECIDE_URL);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'authorization': 'Bearer ' + TOKEN } },
      (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch{ resolve({ behavior:'deny', message:'bridge parse error' }); } }); });
    req.on('error', () => resolve({ behavior: 'deny', message: 'bridge connect error' }));
    req.write(body); req.end();
  });
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = (line||'').trim(); if(!line) return;
  let msg; try{ msg = JSON.parse(line); }catch{ return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result: { protocolVersion: (params&&params.protocolVersion)||'2025-06-18', capabilities: { tools: {} }, serverInfo: { name: '` + MCP_SERVER_NAME + String.raw`', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc:'2.0', id, result: { tools: [{ name: '` + PERMISSION_TOOL + String.raw`', description: 'Permission prompt for Claude Code tools.', inputSchema: { type:'object', properties: { tool_name:{type:'string'}, input:{type:'object'}, tool_use_id:{type:'string'} }, required:['tool_name','input'] } }] } });
  } else if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const verdict = await decide(args);
    send({ jsonrpc:'2.0', id, result: { content: [{ type:'text', text: JSON.stringify(verdict) }] } });
  } else if (method && method.indexOf('notifications/') === 0) {
    // geen antwoord
  } else if (id !== undefined) {
    send({ jsonrpc:'2.0', id, error: { code:-32601, message: 'Method not found: ' + method } });
  }
});
`;

let bridgeScriptPath: string | null = null;
function ensureBridgeScript(): string {
  if (bridgeScriptPath && fs.existsSync(bridgeScriptPath)) return bridgeScriptPath;
  const dir = app?.getPath ? app.getPath('userData') : os.tmpdir();
  const file = path.join(dir, 'claude-permission-bridge.cjs');
  fs.writeFileSync(file, BRIDGE_SCRIPT, 'utf8');
  bridgeScriptPath = file;
  return file;
}

// Start het in-proces beslis-endpoint. Retourneert url + token + een stop().
function startDecisionServer(
  handler: (toolName: string, input: Record<string, unknown>, toolUseId?: string) => Promise<{ allow: boolean; message?: string }>,
): Promise<{ url: string; token: string; stop: () => void }> {
  const token = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || (req.headers.authorization || '') !== `Bearer ${token}`) {
        res.writeHead(401); res.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', async () => {
        let args: any = {};
        try { args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* leeg */ }
        const toolName = String(args.tool_name || 'onbekend');
        const input = (args.input && typeof args.input === 'object') ? args.input : {};
        let verdict: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string };
        try {
          const decision = await handler(toolName, input, typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined);
          verdict = decision.allow
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: decision.message || 'Geweigerd door gebruiker.' };
        } catch (error) {
          verdict = { behavior: 'deny', message: error instanceof Error ? error.message : 'Goedkeuring mislukt.' };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(verdict));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/decide`,
        token,
        stop: () => { try { server.close(); } catch { /* al dicht */ } },
      });
    });
  });
}

function permissionModeFor(agentMode: AgentApprovalMode): string {
  // full = geen popups (bridge wordt niet geraadpleegd); ask/auto-project = default,
  // zodat élke tool via het permission-prompt-tool (en dus onze bridge) loopt.
  return agentMode === 'full' ? 'bypassPermissions' : 'default';
}

export async function runClaudeNative(options: RunClaudeNativeOptions): Promise<RunClaudeNativeResult> {
  if (options.signal.aborted) throw new Error('cancelled');
  let toolStarted = false;
  const decision = await startDecisionServer(async (toolName, input, toolUseId) => {
    toolStarted = true;
    const verdict = await options.requestPermission(toolName, input);
    options.onToolActivity?.({ provider: 'anthropic', toolName, input, toolUseId, phase: verdict.allow ? 'approved' : 'denied' });
    return verdict;
  });

  let bridge: string;
  // De mcp-config als BESTAND doorgeven (niet als inline-JSON-arg): via cmd.exe zouden
  // de accolades/quotes van de JSON anders vermangeld worden.
  const configDir = app?.getPath ? app.getPath('temp') : os.tmpdir();
  const mcpConfigPath = path.join(configDir, `claude-mcp-${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    bridge = ensureBridgeScript();
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [bridge],
          env: { ELECTRON_RUN_AS_NODE: '1', APPPERM_URL: decision.url, APPPERM_TOKEN: decision.token },
        },
      },
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    decision.stop();
    try { fs.unlinkSync(mcpConfigPath); } catch { /* nog niet geschreven */ }
    throw error;
  }

  const args = [
    '-p',
    '--model', options.modelId,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-prompt-tool', `mcp__${MCP_SERVER_NAME}__${PERMISSION_TOOL}`,
    '--permission-mode', permissionModeFor(options.agentMode),
  ];
  if (options.effort) args.push('--effort', options.effort);

  const spawnSpec = cliSpawnSpec(options.exe, args);

  return await new Promise<RunClaudeNativeResult>((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd,
      env: claudeCliEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let assistantText = '';
    let resultText = '';
    let costUsd: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let resultError = '';
    let settled = false;
    // Onthoud elke tool_use (per id) zodat we bij het bijbehorende tool_result de
    // tool-naam + input weer aan de uitvoer kunnen koppelen.
    const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();
    const textStreamState = createClaudeTextStreamState();

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      decision.stop();
      options.signal.removeEventListener('abort', onAbort);
      try { fs.unlinkSync(mcpConfigPath); } catch { /* al weg */ }
    };
    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      if (toolStarted) (error as Error & { partialExecution?: boolean }).partialExecution = true;
      terminateProcessTree(child);
      cleanup();
      reject(error);
    };
    const onAbort = () => finishWithError(new Error('cancelled'));
    const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 600);
    const timeoutTimer = setTimeout(() => {
      finishWithError(new Error(`Claude stopte niet binnen ${timeoutSeconds} seconden.`));
    }, timeoutSeconds * 1000);
    options.signal.addEventListener('abort', onAbort);
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.stdin.on('error', () => {
      // Een vroeg gesloten npm-shim mag geen onbehandelde EPIPE veroorzaken.
    });

    const handleEvent = (evt: any) => {
      if (!evt || typeof evt !== 'object') return;
      for (const delta of claudeTextDeltasForEvent(evt, textStreamState)) {
        assistantText += delta;
        options.onDelta(delta);
      }
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const part of evt.message.content) {
          if (part.type === 'tool_use') {
            toolStarted = true;
            pendingTools.set(part.id, { name: part.name, input: part.input || {} });
            options.onToolActivity?.({ provider: 'anthropic', toolName: part.name, input: part.input || {}, toolUseId: part.id, phase: 'requested' });
            options.onStatus?.(`Claude gebruikt ${part.name}`);
          }
        }
      } else if (evt.type === 'user' && evt.message?.content) {
        for (const part of evt.message.content) {
          if (part.type === 'tool_result') {
            const pending = pendingTools.get(part.tool_use_id);
            pendingTools.delete(part.tool_use_id);
            options.onToolActivity?.({
              provider: 'anthropic',
              toolName: pending?.name || '',
              input: pending?.input || {},
              toolUseId: part.tool_use_id,
              phase: 'result',
              ok: !part.is_error,
              output: clipNativeOutput(toolResultText(part.content)),
            });
          }
        }
      } else if (evt.type === 'result') {
        if (typeof evt.result === 'string') resultText = evt.result;
        resultError = claudeResultFailure(evt) || resultError;
        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
        if (evt.usage) {
          inputTokens = (evt.usage.input_tokens || 0) + (evt.usage.cache_read_input_tokens || 0) + (evt.usage.cache_creation_input_tokens || 0);
          outputTokens = evt.usage.output_tokens || 0;
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf = `${stdoutBuf}${chunk.toString()}`;
      // stream-json hoort per regel te komen; voorkom onbeperkt geheugen als een
      // kapotte CLI toch een eindeloze regel schrijft.
      if (stdoutBuf.length > 1_000_000 && !stdoutBuf.includes('\n')) {
        finishWithError(new Error('Claude gaf een ongeldige, te grote streamregel terug.'));
        return;
      }
      let newline: number;
      while ((newline = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, newline).trim();
        stdoutBuf = stdoutBuf.slice(newline + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch { /* niet-JSON regel negeren */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf = `${stderrBuf}${chunk.toString()}`.slice(-100_000);
    });

    child.on('error', (error) => {
      finishWithError(new Error(`Claude native kon niet starten: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; cleanup();
      if (options.signal.aborted) { reject(new Error('cancelled')); return; }
      const text = (resultText || assistantText).trim();
      if (code !== 0 || resultError) {
        const error = new Error(resultError || cleanStderr(stderrBuf) || `Claude eindigde met code ${code ?? 'onbekend'}.`);
        if (toolStarted) (error as Error & { partialExecution?: boolean }).partialExecution = true;
        reject(error);
        return;
      }
      if (!text) {
        reject(new Error('Claude sloot zonder eindantwoord.'));
        return;
      }
      resolve({ text, costUsd, inputTokens, outputTokens });
    });

    // Prompt via stdin (vermijdt Windows command-line lengtelimieten).
    child.stdin.write(options.prompt);
    child.stdin.end();
  });
}

function cleanStderr(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' ').slice(0, 400);
}
