// Native Codex tool-execution via `codex mcp-server`.
//
// Codex is al een agent. In `exec`-modus kan 'ie geen per-actie-goedkeuring; via
// `codex mcp-server` (Codex draait ALS MCP-server over stdio) wél: de app is de
// MCP-CLIENT, roept de `codex`-tool aan, en Codex vraagt per actie goedkeuring met een
// `elicitation/create`-verzoek dat wij naar de bestaande approval-popup routeren.
//
// Empirisch bevestigd tegen codex 0.144:
// - tools/call `codex` { prompt, cwd, sandbox, approval-policy, model } → {threadId, content}
// - stream: `codex/event`-notificaties: agent_message_content_delta (tekst, token-voor-token),
//   item_started/item_completed (FileChange/CommandExecution), patch_apply_*/exec_command_* (stdout),
//   token_count (usage), task_complete.
// - approval: `elicitation/create` (server→client request) → antwoord result {decision:"approved"|"denied"}
//   (NIET het standaard MCP {action}; Codex verwacht een `decision`-veld).

import { spawn } from 'child_process';
import path from 'path';
import type { AgentApprovalMode } from '../src/providers/types';
import type { NativePermissionHandler, NativeToolActivity } from './native-tools';
import { cliSpawnSpec, clipNativeOutput, terminateProcessTree } from './process-utils';
import { agentCommandEnvironment } from './agent-command-environment';

export interface RunCodexNativeOptions {
  exe: string;
  model?: string;            // base model-id (zonder codex:-prefix)
  prompt: string;
  cwd: string;               // projectmap
  agentMode: AgentApprovalMode;
  reasoningEffort?: string;
  serviceTier?: string;
  timeoutSeconds?: number;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  requestPermission: NativePermissionHandler;
}

export interface RunCodexNativeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// Codex' sandbox/approval per app-modus (bewezen mapping).
// Let op (Windows): de `workspace-write`-sandbox strip't de PATH → systeem-tools als
// `python` werken er niet. Daarom gebruikt `ask` — net als Claude — GEEN sandbox maar de
// per-actie-popup als beveiliging (niks draait zonder jouw goedkeuring), zodat python wél werkt.
export function codexPolicyFor(mode: AgentApprovalMode): { sandbox: string; approval: string } {
  if (mode === 'full') return { sandbox: 'danger-full-access', approval: 'never' };
  if (mode === 'auto-project') return { sandbox: 'workspace-write', approval: 'untrusted' };
  return { sandbox: 'danger-full-access', approval: 'untrusted' }; // ask: popup per actie + volle omgeving
}

export function codexApprovalRequest(params: any, fallbackCwd: string) {
  const kind = String(params?.codex_elicitation || '');
  const filePaths = params?.codex_changes && typeof params.codex_changes === 'object'
    ? Object.keys(params.codex_changes)
    : [];
  const commandParts = Array.isArray(params?.codex_command)
    ? params.codex_command.map((part: unknown) => String(part))
    : [];
  return kind === 'exec-approval'
    ? {
      toolName: 'Bash',
      input: {
        command: commandParts.length ? commandParts.join(' ') : String(params?.message || 'Codex vraagt goedkeuring'),
        cwd: typeof params?.codex_cwd === 'string' ? params.codex_cwd : fallbackCwd,
      } as Record<string, unknown>,
    }
    : {
      toolName: 'Write',
      input: {
        file_path: filePaths[0] || '',
        file_paths: filePaths,
        changes: params?.codex_changes || {},
      } as Record<string, unknown>,
    };
}

export async function runCodexNative(options: RunCodexNativeOptions): Promise<RunCodexNativeResult> {
  if (options.signal.aborted) throw new Error('cancelled');
  const { sandbox, approval } = codexPolicyFor(options.agentMode);

  const baseArgs = ['mcp-server'];
  const spawnSpec = cliSpawnSpec(options.exe, baseArgs);

  return await new Promise<RunCodexNativeResult>((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd,
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      env: agentCommandEnvironment(),
    });

    let stdoutBuf = '';
    let stderrTail = '';
    let assistantText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let settled = false;
    const pendingTools = new Map<string, { toolName: string; input: Record<string, unknown> }>();
    const completedTools = new Set<string>();
    let toolStarted = false;

    // Dicht de kleine race tussen de controle hierboven en spawn.
    if (options.signal.aborted) {
      terminateProcessTree(child);
      reject(new Error('cancelled'));
      return;
    }

    child.stdin.on('error', () => {
      // Een vroeg gesloten CLI kan anders via EPIPE het Electron-mainproces laten crashen.
    });

    const send = (msg: unknown) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* dicht */ } };

    const cleanup = () => { options.signal.removeEventListener('abort', onAbort); clearTimeout(timeout); };
    const onAbort = () => terminateProcessTree(child);
    options.signal.addEventListener('abort', onAbort);

    const finish = (result?: RunCodexNativeResult, error?: Error) => {
      if (settled) return; settled = true; cleanup();
      if (error && toolStarted) (error as Error & { partialExecution?: boolean }).partialExecution = true;
      terminateProcessTree(child);
      if (error) reject(error); else resolve(result!);
    };
    const timeout = setTimeout(
      () => finish(undefined, new Error(`Codex native timeout na ${Math.max(30, options.timeoutSeconds || 180)} seconden.`)),
      Math.max(30, options.timeoutSeconds || 180) * 1000,
    );

    // Codex' elicitatie → onze popup → { decision }.
    const handleElicitation = async (id: number | string, params: any) => {
      toolStarted = true;
      const { toolName, input } = codexApprovalRequest(params, options.cwd);
      let decision = 'denied';
      try {
        const verdict = await options.requestPermission(toolName, input);
        decision = verdict.allow ? 'approved' : 'denied';
      } catch { decision = 'denied'; }
      send({ jsonrpc: '2.0', id, result: { decision } });
    };

    const handleEvent = (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'agent_message_content_delta':
          if (typeof msg.delta === 'string') { assistantText += msg.delta; options.onDelta(msg.delta); }
          break;
        // Het echte commando/bestand + output zit in de *_begin/*_end-events (niet in `item`).
        case 'exec_command_begin': {
          toolStarted = true;
          const id = String(msg.call_id || '');
          const cmd = Array.isArray(msg.command) ? msg.command.join(' ')
            : (typeof msg.command === 'string' ? msg.command : 'commando');
          const input = { command: cmd };
          pendingTools.set(id, { toolName: 'Bash', input });
          options.onToolActivity?.({ provider: 'codex', toolName: 'Bash', input, toolUseId: id, phase: 'requested' });
          options.onStatus?.('Codex draait een commando');
          break;
        }
        case 'patch_apply_begin': {
          toolStarted = true;
          const id = String(msg.call_id || '');
          const paths = msg.changes && typeof msg.changes === 'object' ? Object.keys(msg.changes) : [];
          const input = { file_path: paths[0] || '', changes: msg.changes || undefined };
          pendingTools.set(id, { toolName: 'Write', input });
          options.onToolActivity?.({ provider: 'codex', toolName: 'Write', input, toolUseId: id, phase: 'requested' });
          options.onStatus?.('Codex wijzigt een bestand');
          break;
        }
        case 'item_started': {
          const item = msg.item || {};
          const id = String(item.id || msg.call_id || '');
          if (!id || pendingTools.has(id) || completedTools.has(id)) break;
          const type = String(item.type || item.kind || '').toLowerCase();
          if (type.includes('command')) {
            toolStarted = true;
            const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || item.cmd || 'commando');
            const input = { command };
            pendingTools.set(id, { toolName: 'Bash', input });
            options.onToolActivity?.({ provider: 'codex', toolName: 'Bash', input, toolUseId: id, phase: 'requested' });
          } else if (type.includes('file') || type.includes('patch')) {
            toolStarted = true;
            const paths = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [item.path || item.file_path].filter(Boolean);
            const input = { file_path: String(paths[0] || '') };
            pendingTools.set(id, { toolName: 'Write', input });
            options.onToolActivity?.({ provider: 'codex', toolName: 'Write', input, toolUseId: id, phase: 'requested' });
          }
          break;
        }
        case 'exec_command_end':
        case 'patch_apply_end': {
          const id = String(msg.call_id || '');
          if (completedTools.has(id)) break;
          const pend = pendingTools.get(id);
          pendingTools.delete(id);
          const output = typeof msg.aggregated_output === 'string' ? msg.aggregated_output
            : [msg.stdout, msg.stderr].filter((x: unknown) => typeof x === 'string' && x).join('\n');
          options.onToolActivity?.({
            provider: 'codex',
            toolName: pend?.toolName || (msg.type === 'exec_command_end' ? 'Bash' : 'Write'),
            input: pend?.input || {},
            toolUseId: id,
            phase: 'result',
            ok: typeof msg.exit_code === 'number' ? msg.exit_code === 0 : msg.success !== false,
            output: clipNativeOutput(output),
          });
          if (id) completedTools.add(id);
          break;
        }
        case 'item_completed': {
          const item = msg.item || {};
          const id = String(item.id || msg.call_id || '');
          if (!id || completedTools.has(id)) break;
          const pend = pendingTools.get(id);
          if (!pend) break;
          pendingTools.delete(id);
          const output = item.aggregated_output ?? item.output ?? item.result ?? '';
          options.onToolActivity?.({
            provider: 'codex',
            toolName: pend.toolName,
            input: pend.input,
            toolUseId: id,
            phase: 'result',
            ok: typeof item.exit_code === 'number' ? item.exit_code === 0 : item.status !== 'failed' && item.success !== false,
            output: clipNativeOutput(output),
          });
          completedTools.add(id);
          break;
        }
        case 'token_count': {
          const u = msg.info?.total_token_usage;
          if (u) { inputTokens = (u.input_tokens || 0); outputTokens = (u.output_tokens || 0); }
          break;
        }
        case 'task_started':
          options.onStatus?.('Codex denkt');
          break;
        case 'agent_message':
          if (typeof msg.message === 'string' && !assistantText) assistantText = msg.message;
          break;
        default:
          break;
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > 1_000_000 && !stdoutBuf.includes('\n')) {
        finish(undefined, new Error('Codex gaf een ongeldige, te grote MCP-streamregel terug.'));
        return;
      }
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const rawLine = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (rawLine.length > 1_000_000) {
          finish(undefined, new Error('Codex gaf een ongeldige, te grote MCP-streamregel terug.'));
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        // server→client REQUEST (elicitation)
        if (o.method === 'elicitation/create' && o.id !== undefined) { void handleElicitation(o.id, o.params); continue; }
        // Codex-events
        if (o.method === 'codex/event' && o.params?.msg) { handleEvent(o.params.msg); continue; }
        // resultaat van onze tools/call (id 1) → beurt klaar
        if (o.id === 1 && (o.result || o.error)) {
          if (o.error) { finish(undefined, new Error(o.error?.message || 'Codex mcp-tool faalde.')); return; }
          const content = o.result?.structuredContent?.content
            || (Array.isArray(o.result?.content) ? o.result.content.map((c: any) => c?.text || '').join('') : '');
          const text = (assistantText || content || '').trim();
          const inTok = inputTokens || 0;
          const outTok = outputTokens || 0;
          finish({ text, inputTokens: inTok, outputTokens: outTok });
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-800); });

    child.on('error', (error) => finish(undefined, new Error(`Codex mcp-server kon niet starten: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (options.signal.aborted) { finish(undefined, new Error('cancelled')); return; }
      if (code !== 0) {
        const error = new Error(cleanTail(stderrTail) || `Codex mcp-server eindigde met code ${code ?? 'onbekend'}.`);
        finish(undefined, error);
        return;
      }
      const text = assistantText.trim();
      if (text) { finish({ text, inputTokens, outputTokens }); return; }
      finish(undefined, new Error('Codex mcp-server sloot zonder eindantwoord.'));
    });

    // MCP-handshake → codex-tool starten.
    const config: Record<string, unknown> = {
      // Erf de VOLLEDIGE omgeving (incl. PATH) in Codex' shell, zodat tools als python/py
      // beschikbaar zijn — standaard erft Codex maar een beperkte set.
      shell_environment_policy: { inherit: 'all' },
    };
    if (options.reasoningEffort) config['model_reasoning_effort'] = options.reasoningEffort;
    if (options.serviceTier) config['service_tier'] = options.serviceTier;
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'LLMelt', version: '1.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'codex',
        arguments: {
          prompt: options.prompt,
          cwd: options.cwd,
          sandbox,
          'approval-policy': approval,
          ...(options.model ? { model: options.model } : {}),
          ...(Object.keys(config).length ? { config } : {}),
        },
      },
    });
  });
}

function cleanTail(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
