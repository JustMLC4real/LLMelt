import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { AgentApprovalMode, ModelRunConfig, UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import { agentCommandEnvironment } from './agent-command-environment';
import type { NativePermissionHandler, NativeToolActivity } from './native-tools';
import { cliSpawnSpec, clipNativeOutput, terminateProcessTree } from './process-utils';
import { codexPolicyFor } from './codex-native';

type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CodexThreadState = {
  threadId: string;
  signature: string;
};

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  language: UiLanguage;
  requestPermission?: NativePermissionHandler;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  text: string;
  planText: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  contextWindow?: number;
  items: Map<string, any>;
  completedItems: Set<string>;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
};

export type CodexCollaborationMode = {
  name: string;
  mode: string;
  model?: string;
  reasoningEffort?: string;
};

export type CodexSkill = {
  name: string;
  description: string;
  path: string;
};

export type CodexNativeCapabilities = {
  collaborationModes: CodexCollaborationMode[];
  skills: CodexSkill[];
  goal: boolean;
  review: boolean;
};

export type CodexAppServerTurnOptions = {
  executable: string;
  chatId: string;
  model: string;
  serviceTier?: string;
  reasoningEffort?: string;
  prompt: string;
  latestPrompt: string;
  systemPrompt?: string;
  cwd: string;
  agentMode: AgentApprovalMode;
  timeoutSeconds?: number;
  signal: AbortSignal;
  runConfig?: ModelRunConfig;
  requestPermission?: NativePermissionHandler;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  language?: UiLanguage;
};

export type CodexAppServerTurnResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  contextWindow?: number;
};

/**
 * Een kleine JSONL-client voor Codex App Server. De server blijft leven zodat
 * goals, collaboration modes, skills en vervolgbeurten echt dezelfde native
 * Codex-thread gebruiken.
 */
class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private executable = '';
  private stdoutBuffer = '';
  private stderrTail = '';
  private requestSequence = 0;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private threads = new Map<string, CodexThreadState>();
  private activeTurns = new Map<string, ActiveTurn>();
  private startPromise: Promise<void> | null = null;

  shutdown() {
    this.stop(new Error('Codex App Server is afgesloten.'));
  }

  async capabilities(executable: string, cwd?: string): Promise<CodexNativeCapabilities> {
    await this.ensureStarted(executable, cwd);
    const [modesResult, skillsResult] = await Promise.allSettled([
      this.request('collaborationMode/list', {}, 12_000),
      this.request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false }, 20_000),
    ]);
    const modes = modesResult.status === 'fulfilled'
      ? collaborationModesFromResponse(modesResult.value)
      : [];
    const skills = skillsResult.status === 'fulfilled'
      ? skillsFromResponse(skillsResult.value)
      : [];
    return { collaborationModes: modes, skills, goal: true, review: true };
  }

  async models(executable: string, cwd?: string): Promise<any[]> {
    await this.ensureStarted(executable, cwd);
    const response = await this.request('model/list', { includeHidden: false }, 20_000);
    return Array.isArray(response?.data) ? response.data : [];
  }

  async setGoal(options: {
    executable: string;
    chatId: string;
    model: string;
    cwd: string;
    objective: string;
    systemPrompt?: string;
    agentMode: AgentApprovalMode;
  }) {
    const thread = await this.ensureThread(options);
    const response = await this.request('thread/goal/set', {
      threadId: thread.threadId,
      objective: options.objective,
      status: 'active',
    }, 15_000);
    return response?.goal || null;
  }

  async clearGoal(options: {
    executable: string;
    chatId: string;
    model: string;
    cwd: string;
    systemPrompt?: string;
    agentMode: AgentApprovalMode;
  }) {
    const thread = await this.ensureThread(options);
    return this.request('thread/goal/clear', { threadId: thread.threadId }, 15_000);
  }

  async runTurn(options: CodexAppServerTurnOptions): Promise<CodexAppServerTurnResult> {
    const language = options.language || 'nl';
    if (options.signal.aborted) throw new Error('cancelled');
    const thread = await this.ensureThread(options);
    if (this.activeTurns.has(thread.threadId)) {
      throw new Error(localizedText(language, 'Deze Codex-chat heeft al een actieve beurt.', 'This Codex chat already has an active turn.'));
    }

    const input: any[] = [];
    const nativeCommand = options.runConfig?.nativeProviderCommand;
    if (nativeCommand?.kind === 'skill' && nativeCommand.name && nativeCommand.path) {
      input.push({ type: 'skill', name: nativeCommand.name, path: nativeCommand.path });
    }
    const prompt = thread.fresh ? options.prompt : options.latestPrompt;
    if (prompt.trim()) input.push({ type: 'text', text: prompt, text_elements: [] });
    if (!input.length) input.push({ type: 'text', text: localizedText(language, 'Voer de gekozen native actie uit.', 'Run the selected native action.'), text_elements: [] });

    return new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      const timeoutSeconds = Math.max(30, Number(options.timeoutSeconds || 180));
      const active: ActiveTurn = {
        threadId: thread.threadId,
        language,
        requestPermission: options.requestPermission,
        onDelta: options.onDelta,
        onStatus: options.onStatus,
        onToolActivity: options.onToolActivity,
        text: '',
        planText: '',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        items: new Map(),
        completedItems: new Set(),
        resolve,
        reject,
        timer: setTimeout(() => {
          if (active.turnId) void this.request('turn/interrupt', { threadId: thread.threadId, turnId: active.turnId }, 5_000).catch(() => {});
          this.finishTurn(active, undefined, new Error(localizedText(language, `Codex App Server timeout na ${timeoutSeconds} seconden.`, `Codex App Server timed out after ${timeoutSeconds} seconds.`)));
        }, timeoutSeconds * 1000),
      };
      this.activeTurns.set(thread.threadId, active);
      const onAbort = () => {
        if (active.turnId) void this.request('turn/interrupt', { threadId: thread.threadId, turnId: active.turnId }, 5_000).catch(() => {});
        this.finishTurn(active, undefined, new Error('cancelled'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      active.abortCleanup = () => options.signal.removeEventListener('abort', onAbort);

      const collaborationMode = nativeCommand?.kind === 'collaboration-mode' && nativeCommand.mode
        ? {
          mode: nativeCommand.mode,
          settings: {
            model: nativeCommand.model || options.model,
            reasoning_effort: nativeCommand.reasoningEffort || options.reasoningEffort || null,
            developer_instructions: null,
          },
        }
        : undefined;
      const startMethod = nativeCommand?.kind === 'review' ? 'review/start' : 'turn/start';
      const params = nativeCommand?.kind === 'review'
        ? {
          threadId: thread.threadId,
          target: nativeCommand.args?.trim()
            ? { type: 'custom', instructions: nativeCommand.args.trim() }
            : { type: 'uncommittedChanges' },
          delivery: 'inline',
        }
        : {
          threadId: thread.threadId,
          input,
          cwd: options.cwd,
          model: options.model,
          serviceTier: options.serviceTier || null,
          effort: options.reasoningEffort || null,
          collaborationMode,
        };

      active.onStatus?.(nativeCommand?.kind === 'review'
        ? localizedText(language, 'Codex start native review', 'Codex is starting a native review')
        : localizedText(language, 'Codex denkt', 'Codex is thinking'));
      void this.request(startMethod, params, 30_000)
        .then((response) => {
          const turn = response?.turn;
          if (!turn?.id) throw new Error(localizedText(language, 'Codex gaf geen beurt-ID terug.', 'Codex did not return a turn ID.'));
          active.turnId = String(turn.id);
          if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
            this.completeFromTurn(active, turn);
          }
        })
        .catch((error) => this.finishTurn(active, undefined, asError(error)));
    });
  }

  private async ensureThread(options: {
    executable: string;
    chatId: string;
    model: string;
    cwd: string;
    systemPrompt?: string;
    agentMode: AgentApprovalMode;
    serviceTier?: string;
  }): Promise<CodexThreadState & { fresh: boolean }> {
    await this.ensureStarted(options.executable, options.cwd);
    const signature = JSON.stringify({ cwd: options.cwd, systemPrompt: options.systemPrompt || '' });
    const existing = this.threads.get(options.chatId);
    if (existing && existing.signature === signature) return { ...existing, fresh: false };

    const policy = appServerPolicyFor(options.agentMode);
    const response = await this.request('thread/start', {
      model: options.model,
      serviceTier: options.serviceTier || null,
      cwd: options.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: options.systemPrompt || null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: false,
    }, 30_000);
    const threadId = String(response?.thread?.id || '');
    if (!threadId) throw new Error('Codex App Server gaf geen thread-ID terug.');
    const state = { threadId, signature };
    this.threads.set(options.chatId, state);
    return { ...state, fresh: true };
  }

  private async ensureStarted(executable: string, cwd?: string) {
    if (this.child && !this.child.killed && this.executable === executable) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(executable, cwd).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async start(executable: string, cwd?: string) {
    this.stop(new Error('Codex App Server is opnieuw gestart.'));
    const spec = cliSpawnSpec(executable, ['app-server', '--listen', 'stdio://']);
    const child = spawn(spec.command, spec.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      env: agentCommandEnvironment(),
    });
    this.child = child;
    this.executable = executable;
    child.stdout.on('data', (chunk) => this.handleStdout(String(chunk)));
    child.stderr.on('data', (chunk) => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-20_000); });
    child.stdin.on('error', () => {});
    child.once('error', (error) => this.stop(error));
    child.once('exit', (code) => this.stop(new Error(this.stderrTail.trim() || `Codex App Server stopte met code ${code}.`)));
    await this.request('initialize', {
      clientInfo: { name: 'llmelt', title: 'LLMelt', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 15_000);
    this.notify('initialized', {});
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.child || this.child.killed) return Promise.reject(new Error('Codex App Server draait niet.'));
    const id = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timeout.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown) {
    try { this.child?.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* proces wordt door exit afgehandeld */ }
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try { this.handleMessage(JSON.parse(line)); } catch { /* diagnostiek naast JSON negeren */ }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(message: any) {
    if (message && message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex App Server-fout.'));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }
    if (message?.method) this.handleNotification(message.method, message.params || {});
  }

  private async handleServerRequest(message: any) {
    const method = String(message.method || '');
    const params = message.params || {};
    const active = this.activeTurns.get(String(params.threadId || ''));
    if (!active) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Geen actieve LLMelt-beurt voor deze aanvraag.' } });
      return;
    }

    if (method === 'item/commandExecution/requestApproval') {
      const input = { command: String(params.command || ''), cwd: String(params.cwd || '') };
      const allow = await this.ask(active, 'Bash', input);
      active.onToolActivity?.({ provider: 'codex', toolName: 'Bash', input, toolUseId: String(params.itemId || ''), phase: allow ? 'approved' : 'denied' });
      this.write({ jsonrpc: '2.0', id: message.id, result: { decision: allow ? 'accept' : 'decline' } });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const item = active.items.get(String(params.itemId || ''));
      const input = fileChangeInput(item);
      const allow = await this.ask(active, 'Write', input);
      active.onToolActivity?.({ provider: 'codex', toolName: 'Write', input, toolUseId: String(params.itemId || ''), phase: allow ? 'approved' : 'denied' });
      this.write({ jsonrpc: '2.0', id: message.id, result: { decision: allow ? 'accept' : 'decline' } });
      return;
    }
    this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Niet-ondersteunde Codex-aanvraag: ${method}` } });
  }

  private async ask(active: ActiveTurn, toolName: string, input: Record<string, unknown>) {
    if (!active.requestPermission) return false;
    try { return !!(await active.requestPermission(toolName, input)).allow; } catch { return false; }
  }

  private handleNotification(method: string, params: any) {
    const active = this.activeTurns.get(String(params.threadId || ''));
    if (!active) return;
    if (method === 'item/agentMessage/delta') {
      const delta = String(params.delta || '');
      active.text += delta;
      active.onDelta(delta);
      return;
    }
    if (method === 'item/started') {
      const item = params.item;
      if (!item?.id) return;
      active.items.set(String(item.id), item);
      this.emitToolStarted(active, item);
      return;
    }
    if (method === 'item/completed') {
      const item = params.item;
      if (!item?.id) return;
      active.items.set(String(item.id), item);
      if (item.type === 'agentMessage' && !active.text && item.text) {
        active.text = String(item.text);
        active.onDelta(active.text);
      }
      if (item.type === 'plan' && item.text) {
        active.planText = String(item.text);
      }
      this.emitToolCompleted(active, item);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last || params.tokenUsage?.total;
      if (usage) {
        active.inputTokens = Number(usage.inputTokens || 0);
        active.outputTokens = Number(usage.outputTokens || 0);
        active.cachedTokens = Number(usage.cachedInputTokens || 0);
        active.reasoningTokens = Number(usage.reasoningOutputTokens || 0);
        active.contextWindow = Number(params.tokenUsage?.modelContextWindow || 0) || undefined;
      }
      return;
    }
    if (method === 'turn/plan/updated') {
      active.planText = formatPlanUpdate(params);
      return;
    }
    if (method === 'turn/completed') this.completeFromTurn(active, params.turn || {});
  }

  private emitToolStarted(active: ActiveTurn, item: any) {
    if (item.type === 'commandExecution') {
      const input = { command: String(item.command || ''), cwd: String(item.cwd || '') };
      active.onStatus?.(localizedText(active.language, 'Codex draait een commando', 'Codex is running a command'));
      active.onToolActivity?.({ provider: 'codex', toolName: 'Bash', input, toolUseId: String(item.id), phase: 'requested' });
    } else if (item.type === 'fileChange') {
      const input = fileChangeInput(item);
      active.onStatus?.(localizedText(active.language, 'Codex wijzigt bestanden', 'Codex is changing files'));
      active.onToolActivity?.({ provider: 'codex', toolName: 'Write', input, toolUseId: String(item.id), phase: 'requested' });
    }
  }

  private emitToolCompleted(active: ActiveTurn, item: any) {
    const id = String(item.id || '');
    if (!id || active.completedItems.has(id)) return;
    if (item.type === 'commandExecution') {
      active.completedItems.add(id);
      const input = { command: String(item.command || ''), cwd: String(item.cwd || '') };
      active.onToolActivity?.({
        provider: 'codex', toolName: 'Bash', input, toolUseId: id, phase: 'result',
        ok: item.status === 'completed' && Number(item.exitCode || 0) === 0,
        output: clipNativeOutput(item.aggregatedOutput || ''),
      });
    } else if (item.type === 'fileChange') {
      active.completedItems.add(id);
      active.onToolActivity?.({
        provider: 'codex', toolName: 'Write', input: fileChangeInput(item), toolUseId: id,
        phase: 'result', ok: item.status === 'completed', output: fileChangeSummary(item, active.language),
      });
    }
  }

  private completeFromTurn(active: ActiveTurn, turn: any) {
    if (turn.status === 'failed') {
      this.finishTurn(active, undefined, new Error(turn.error?.message || 'Codex-beurt mislukt.'));
      return;
    }
    if (turn.status === 'interrupted') {
      this.finishTurn(active, undefined, new Error('cancelled'));
      return;
    }
    const completedText = Array.isArray(turn.items)
      ? turn.items.filter((item: any) => item?.type === 'agentMessage').map((item: any) => String(item.text || '')).filter(Boolean).at(-1)
      : '';
    const completedPlan = Array.isArray(turn.items)
      ? turn.items.filter((item: any) => item?.type === 'plan').map((item: any) => String(item.text || '')).filter(Boolean).at(-1)
      : '';
    const finalText = active.text || completedText || active.planText || completedPlan || '';
    if (!active.text && finalText) {
      active.text = finalText;
      active.onDelta(finalText);
    }
    this.finishTurn(active, {
      text: finalText,
      inputTokens: active.inputTokens,
      outputTokens: active.outputTokens,
      cachedTokens: active.cachedTokens,
      reasoningTokens: active.reasoningTokens,
      contextWindow: active.contextWindow,
    });
  }

  private finishTurn(active: ActiveTurn, result?: CodexAppServerTurnResult, error?: Error) {
    if (this.activeTurns.get(active.threadId) !== active) return;
    this.activeTurns.delete(active.threadId);
    clearTimeout(active.timer);
    active.abortCleanup?.();
    if (error) active.reject(error);
    else active.resolve(result!);
  }

  private stop(error: Error) {
    const child = this.child;
    this.child = null;
    this.executable = '';
    this.stdoutBuffer = '';
    this.threads.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const active of this.activeTurns.values()) this.finishTurn(active, undefined, error);
    if (child && !child.killed) terminateProcessTree(child);
  }
}

export function collaborationModesFromResponse(value: any): CodexCollaborationMode[] {
  const data = Array.isArray(value?.data) ? value.data : [];
  return data
    .map((mode: any) => ({
      name: String(mode?.name || mode?.mode || '').trim(),
      mode: String(mode?.mode || '').trim(),
      model: String(mode?.model || '').trim() || undefined,
      reasoningEffort: String(mode?.reasoning_effort || '').trim() || undefined,
    }))
    .filter((mode: CodexCollaborationMode) => !!mode.name && !!mode.mode);
}

export function skillsFromResponse(value: any): CodexSkill[] {
  const entries = Array.isArray(value?.data) ? value.data : [];
  return entries.flatMap((entry: any) => Array.isArray(entry?.skills) ? entry.skills : [])
    .filter((skill: any) => skill?.enabled !== false && skill?.name && skill?.path)
    .map((skill: any) => ({
      name: String(skill.name),
      description: String(skill.description || skill.shortDescription || ''),
      path: String(skill.path),
    }));
}

export function formatPlanUpdate(value: any) {
  const explanation = String(value?.explanation || '').trim();
  const steps = Array.isArray(value?.plan) ? value.plan : [];
  const renderedSteps = steps
    .map((entry: any, index: number) => `${index + 1}. ${String(entry?.step || '').trim()}`)
    .filter((entry: string) => !/\.\s*$/.test(entry));
  return [explanation, ...renderedSteps].filter(Boolean).join('\n\n');
}

export function appServerPolicyFor(mode: AgentApprovalMode) {
  const policy = codexPolicyFor(mode);
  return {
    sandbox: policy.sandbox,
    approvalPolicy: policy.approval === 'never' ? 'never' : 'on-request',
  };
}

function fileChangeInput(item: any): Record<string, unknown> {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes.map((change: any) => String(change?.path || '')).filter(Boolean);
  return { file_path: paths[0] || '', file_paths: paths, changes };
}

function fileChangeSummary(item: any, language: UiLanguage) {
  const paths = Array.isArray(item?.changes)
    ? item.changes.map((change: any) => String(change?.path || '')).filter(Boolean)
    : [];
  return paths.length
    ? localizedText(language, `Gewijzigd: ${paths.join(', ')}`, `Changed: ${paths.join(', ')}`)
    : localizedText(language, 'Bestandswijziging voltooid.', 'File change completed.');
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value || 'Onbekende Codex App Server-fout.'));
}

export const codexAppServer = new CodexAppServerClient();
