import { type IpcMain, BrowserWindow, app, clipboard, dialog, shell } from 'electron';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selectDefaultWorkspacePath } from './default-workspace';

const AGENT_DIAGNOSTICS_ENABLED = process.env.AI_SUPERAPP_DIAGNOSTICS === '1';

// Diagnostiek is expliciet opt-in en staat in Electron's logmap.
function agentLog(label: string, data?: unknown) {
  if (!AGENT_DIAGNOSTICS_ENABLED) return;
  try {
    const p = path.join(app.getPath('logs'), 'agent-debug.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = data === undefined ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
    fs.appendFileSync(p, `${new Date().toISOString()} ${label} ${body}\n`);
  } catch { /* best-effort */ }
}
import { getDb } from './database';
import { appEvents, notifyChatsChanged } from './app-events';
import { getStore } from './settings-store';
import type { NativeToolActivity } from './native-tools';
import {
  getCredential,
  getCredentialStatuses,
  removeCredential,
  saveCredential,
} from './credential-store';
import {
  agentRoundSignature,
  buildToolFailureRepairPrompt,
  buildToolRepairPrompt,
  buildToolSuccessSummaryPrompt,
  compactToolSummaryForDisplay,
  buildToolSyntaxRepairPrompt,
  decideAgentToolLoopContinuation,
  detectDirectCommandSpec,
  detectToolIntentRequest,
  fileToolPathFromResult,
  hasFailedToolResult,
  hasSuccessfulCommandRun,
  hasUnparsedToolMarkup,
  isFailedFileToolResult,
  isNoProgressRepeat,
  isNoFixReply,
  isRepeatFailure,
  needsToolComplianceRepair,
  normalizeAgentCommand,
  normalizeFileToolPayload,
  missingRequestedFileExecutions,
  requestRequiresEveryFileExecution,
  parseAgentToolCalls,
  shouldSkipCommandForFailedFileTool,
  stripAgentToolMarkup,
  type AgentToolCall,
  toolFailureFingerprint,
  validateFileToolPayload,
  validateModelCommand,
} from '../src/components/agent-commands';
import { makeToolSummaryErrorContent } from '../src/components/command-run-utils';
import { changedLineDiff } from '../src/components/line-diff';
import {
  fileCreatedDetail,
  fileEditedDetail,
  fileReadDetail,
  fileUnchangedDetail,
} from './file-tool-language';
import { autoModePromptPreview, mergeAutoModeState, validateAutoModeConfig } from '../src/components/auto-mode-utils';
import {
  type AdapterChatResult,
  type AttachmentRecord,
  classifyProviderError,
  createAdapters,
  getClaudeCliRuntimeStatus,
  ProviderRuntimeError,
  rateLimitKey,
} from './provider-adapters';
import {
  antigravityExecutableCandidates,
  claudeExecutableCandidates,
  codexExecutableCandidates,
  findCliExecutable as findExecutablePath,
} from './cli-discovery';
import { chatgptScraper } from './chatgpt-scraper';
import { getMcpServerManager } from './mcp-server';
import { registerTerminalIpcHandlers } from './pty-terminal';
import { configuredExecutable, listNativeProviderCommands } from './provider-native-commands';
import { codexAppServer } from './codex-app-server';
import { agentShellSpawnSpec, terminateProcessTree } from './process-utils';
import {
  interactiveCliInstallPowerShell,
  interactiveCliName,
  interactiveCliTerminalLauncherPowerShell,
  parseInteractiveCliInstallerProgress,
  type InteractiveCliKind,
} from './interactive-cli-setup';
import { agentCommandEnvironment } from './agent-command-environment';
import {
  activatePythonRuntime,
  getPythonRuntimeStatus,
  parsePythonInstallerProgress,
  PYTHON_INSTALL_MANAGER_PACKAGE_ID,
  pythonInstallManagerCommands,
  type PythonRuntimeStatus,
} from './python-runtime';
import { boundedString, buildRendererSettingsSnapshot, sanitizeRendererSettingValue } from './settings-security';
import { assertRealPathInsideRoot, canAutoApproveAgentAction, isRealPathInsideRoot } from './path-security';
import { credentialPreflightFallbackReason, normalizeFallbackSwitchState } from './fallback-policy';
import { linkedTimeoutSignal, shouldPersistProviderFailure } from './request-lifecycle';
import { finalNativeAssistantText, nativeToolLedgerSignature } from './native-tool-loop-utils';
import { nativeToolResponseInstructions } from './native-response-instructions';
import { agentToolEnvironmentInstructions, agentToolInstructions } from './agent-tool-instructions';
import { localizedText, normalizeUiLanguage } from '../src/i18n/language';
import { normalizePowerShell5ConditionalChain } from './windows-command-normalization';
import {
  conciseOllamaStartupDiagnostic,
  ollamaProbeBaseUrls,
  ollamaWindowsStartCandidates,
} from './ollama-runtime-start';
import { isChatGptSubscriptionModel, providerPreflightSurface } from './provider-routing';
import { providerLimitUpdateBindings } from './sqlite-bindings';
import { blockingQuotaForModel, makeUnknownQuota } from './provider-quota';
import { collectProviderQuotaSnapshots } from './quota-collectors';
import { hasRecordableUsage, mergeUsageSources, normalizeUsageSource, usageSourceFromRows } from '../src/providers/token-usage';
import { normalizeLegacyModelId } from '../src/providers/model-ref-normalization';
import {
  configureGeminiQuota,
  disconnectGeminiQuotaOAuth,
  getGeminiQuotaAuthStatus,
  invalidateGeminiQuotaValidation,
  startGeminiQuotaOAuth,
} from './gemini-quota-auth';
import { ensureStatuslineBridge, restoreStatuslineBridge } from './statusline-bridge';
import {
  isGeneratedTitleDistinct,
  isLikelyLegacyPromptTitle,
  isUsableGeneratedChatTitle,
  resolveConfiguredChatTitleMode,
  sanitizeGeneratedChatTitle,
  simpleChatTitleFrom,
  type ChatTitleMode,
} from './chat-title-mode';
import {
  DEFAULT_OLLAMA_TITLE_MODEL,
  resolveOllamaTitleSetup,
  selectOllamaTitleModel,
  type OllamaTitleModel,
  type OllamaTitleSetupStatus,
} from './chat-title-ollama';
import { downloadHttpFile } from './http-file-download';
import {
  OLLAMA_WINDOWS_INSTALLER_ARGS,
  OLLAMA_WINDOWS_INSTALLER_URL,
  ollamaAuthenticodeVerificationPowerShell,
} from './ollama-windows-installer';
import {
  assertOllamaModelName,
  deleteOllamaModel,
  listInstalledOllamaModels,
  listOllamaLibraryTags,
  pullOllamaModel,
  searchOllamaLibrary,
} from './ollama-model-manager';
import { diagnoseOllamaClockSkew } from './ollama-clock-skew';
import { shouldStartNativeToolTurn, shouldUseTagToolProtocol } from './native-tool-policy';
import { toolFollowupRouting } from '../src/components/tool-followup-routing';
import type {
  AIModel,
  AgentApprovalMode,
  AgentShell,
  AttachmentKind,
  AttachmentRef,
  AutoModeConfig,
  AutoModeState,
  Chat,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  CommandRun,
  CredentialStatus,
  FallbackConfig,
  FallbackReason,
  Folder,
  Message,
  ModelRunConfig,
  ModelRef,
  OllamaModelManagerStatus,
  OllamaModelPullProgress,
  OllamaTitleSetupProgress,
  ProviderAccountId,
  ProviderAccountStatus,
  ProviderType,
  RateLimitSnapshot,
  ReasoningEffort,
  RuntimeSetupId,
  RuntimeSetupProgress,
  RuntimeStatus,
  ServiceTier,
  TokenDashboard,
  TokenUsage,
  UiLanguage,
  ValidationResult,
} from '../src/providers/types';

const adapters = createAdapters();
const activeRequests = new Map<string, AbortController>();
// Elk stream-event krijgt via requestId zijn oorspronkelijke chatId. Zonder deze
// routing kan een renderer die intussen van chat wisselt een late delta verkeerd tonen.
const activeRequestChatIds = new Map<string, string>();
const importedAttachmentIds = new Set<string>();
const ollamaModelPullControllers = new Map<string, AbortController>();
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
const MAX_COMMAND_OUTPUT_CHARS = 100_000;
const RENDERER_SETTING_KEYS = new Set([
  'profile.avatarDataUrl',
  'ui.language',
  'onboarding.completedAt',
  'onboarding.services',
  'ollama.url',
  'codex.executable',
  'codex.timeoutSeconds',
  'claude.executable',
  'antigravity.executable',
  'antigravity.models',
  'antigravity.statusJsonPath',
  'chat.autoTitleMode',
  'runtime.pythonExecutable',
  'sshConfig',
]);

let cachedModels: AIModel[] = [];
let providerCredentialStatusesInFlight: { language: UiLanguage; promise: Promise<Record<ProviderType, CredentialStatus>> } | null = null;
let providerCredentialStatusesCache: { language: UiLanguage; expiresAt: number; value: Record<ProviderType, CredentialStatus> } | null = null;
let providerQuotaRefreshInFlight: Promise<import('../src/providers/types').ProviderQuotaSnapshot[]> | null = null;

function invalidateProviderStatusCaches() {
  providerCredentialStatusesCache = null;
  providerCredentialStatusesInFlight = null;
}
let autoModeState: AutoModeState = {
  status: 'idle',
  phase: 'idle',
  iteration: 0,
  totalTokens: 0,
  maxIterations: 0,
  detail: '',
};
let autoModeStopRequested = false;
let autoModeRunId: string | null = null;
const autoModeRequestIds = new Set<string>();

function publishAutoModeState(win: BrowserWindow | null, patch: Partial<AutoModeState>) {
  autoModeState = mergeAutoModeState(autoModeState, patch);
  win?.webContents.send('auto:iteration', { ...autoModeState });
  return autoModeState;
}

type AgentApprovalKind = 'file-read' | 'file-create' | 'file-edit' | 'command';
const AGENT_APPROVAL_MODES: AgentApprovalMode[] = ['ask', 'auto-project', 'full'];
const AGENT_SHELLS: AgentShell[] = ['powershell', 'cmd', 'pwsh'];
const AGENT_COMMAND_TIMEOUT_MS = 120000;
const FILE_READ_TOOL_MAX_BYTES = 2 * 1024 * 1024;
type PendingAgentApproval = {
  ownerId: number;
  requestId?: string;
  chatId?: string;
  request: {
    id: string;
    command: string;
    cwd: string;
    shell?: AgentShell;
    kind: AgentApprovalKind;
    label: string;
    path?: string;
    chatId?: string;
    requestId?: string;
  };
  resolve: (approved: boolean, reason?: 'answered' | 'cancelled' | 'window_closed') => void;
};
const pendingAgentApprovals = new Map<string, PendingAgentApproval>();
type AgentCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  cwd: string;
  shell: AgentShell;
  run?: CommandRun;
  denied?: boolean;
  error?: string;
};
type AgentCommandCallbacks = {
  onStart?: (run: CommandRun) => void;
  onOutput?: (runId: string, stream: 'stdout' | 'stderr', delta: string) => void;
  onFinish?: (run: CommandRun) => void;
};
type AgentToolRunContext = {
  chatId: string;
  requestId: string;
  anchorMessageId?: string;
  attempt?: number;
  agentMode?: AgentApprovalMode;
  silentApproval?: boolean;
  language?: UiLanguage;
  onFileMutationApproved?: (
    call: Extract<AgentToolCall, { type: 'file-create' | 'file-edit' }>,
    root: string,
  ) => void;
};

const PROVIDERS: ProviderType[] = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'codex',
  'antigravity',
  'remote',
];

const PROVIDER_STATUS: Record<ProviderType, { category: CredentialStatus['category']; valid: string; invalid: string; canChat: boolean }> = {
  openai: { category: 'api', valid: 'OpenAI API verbonden', invalid: 'OpenAI API-key nodig', canChat: true },
  anthropic: { category: 'api', valid: 'Verbonden', invalid: 'API key of Claude CLI nodig', canChat: true },
  google: { category: 'api', valid: 'Gemini API verbonden', invalid: 'Gemini API-key nodig', canChat: true },
  ollama: { category: 'local', valid: 'Ollama online', invalid: 'Ollama offline', canChat: true },
  codex: { category: 'agent', valid: 'CLI gevonden en ingelogd', invalid: 'CLI auth nodig', canChat: true },
  antigravity: { category: 'agent', valid: 'Antigravity CLI', invalid: 'CLI niet gevonden', canChat: true },
  remote: { category: 'local', valid: 'SSH ingesteld', invalid: 'SSH niet ingesteld', canChat: true },
};

const PROVIDER_STATUS_EN: Record<ProviderType, { valid: string; invalid: string }> = {
  openai: { valid: 'OpenAI API connected', invalid: 'OpenAI API key required' },
  anthropic: { valid: 'Connected', invalid: 'API key or Claude CLI required' },
  google: { valid: 'Gemini API connected', invalid: 'Gemini API key required' },
  ollama: { valid: 'Ollama online', invalid: 'Ollama offline' },
  codex: { valid: 'CLI found and signed in', invalid: 'CLI authentication required' },
  antigravity: { valid: 'Antigravity CLI', invalid: 'CLI not found' },
  remote: { valid: 'SSH configured', invalid: 'SSH not configured' },
};

export function registerIpcHandlers(ipcMain: IpcMain) {
  void cleanupStalePendingAttachments().catch((error) => {
    agentLog('attachment-cleanup-failed', error instanceof Error ? error.message : String(error));
  });
  registerTerminalIpcHandlers(ipcMain, ensureDefaultWorkspacePath);
  const mcpManager = getMcpServerManager({
    getWindow: () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null,
    runShell: (command, cwd) => runAgentCommand(BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null, command, { cwd }),
  });
  mcpManager.registerIpcHandlers(ipcMain);
  void mcpManager.startIfEnabled().catch((error) => {
    agentLog('mcp-start-failed', error instanceof Error ? error.message : String(error));
  });

  ipcMain.handle('clipboard:writeText', (_event, value: unknown) => {
    clipboard.writeText(boundedString(value, 2_000_000, 'Kopieertekst'));
    return true;
  });

  ipcMain.handle('providers:listAll', async () => listProviders());
  ipcMain.handle('provider:listAll', async () => listProviders());
  ipcMain.handle('providers:refreshModels', async (_event, providerId?: ProviderType) => refreshModels(providerId));
  ipcMain.handle('providers:listModels', async (_event, providerId?: ProviderType) => listModels(providerId));
  ipcMain.handle('provider:listModels', async (_event, providerId?: ProviderType) => listModels(providerId));
  ipcMain.handle('provider:getHealth', async () => getProviderHealth());
  ipcMain.handle('providers:getHealth', async () => getProviderHealth());
  ipcMain.handle('providers:getAccountStatuses', async () => getProviderAccountStatuses());
  ipcMain.handle('providers:openAccountSurface', async (_event, provider: ProviderAccountId) => openAccountSurface(provider));
  ipcMain.handle('providers:listNativeCommands', async (_event, input: { chatId?: string; modelRef: ModelRef; language?: UiLanguage }) => {
    const language = normalizeUiLanguage(input?.language);
    const chat = input?.chatId ? getChatById(String(input.chatId)) : null;
    const cwd = chat ? await getEffectiveProjectPath(chat) : ensureDefaultWorkspacePath();
    return listNativeProviderCommands(input.modelRef, cwd, language);
  });
  ipcMain.handle('providers:setNativeGoal', async (_event, input: { chatId: string; modelRef: ModelRef; objective: string; language?: UiLanguage }) => {
    if (input?.modelRef?.provider !== 'codex') throw new Error('Native goals zijn alleen beschikbaar via Codex App Server.');
    const chat = getChatById(String(input.chatId || ''));
    if (!chat) throw new Error('Chat niet gevonden.');
    const cwd = await getEffectiveProjectPath(chat);
    if (!cwd) throw new Error('Projectmap niet gevonden.');
    const executable = await configuredExecutable('codex');
    if (!executable) throw new Error('Codex CLI niet gevonden.');
    const agent = await getAgentConfig(chat);
    const assembled = await assemblePromptContext(chat, undefined);
    return codexAppServer.setGoal({
      executable,
      chatId: chat.id,
      model: String(input.modelRef.modelId || ''),
      cwd,
      objective: boundedString(input.objective, 8_000, 'Doel'),
      systemPrompt: assembled.systemPrompt,
      agentMode: agent.mode,
    });
  });
  ipcMain.handle('chat:getTitleOllamaStatus', async () => getOllamaTitleSetupStatus());
  ipcMain.handle('chat:installTitleOllama', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return installOllamaTitleSetup(win);
  });
  ipcMain.handle('ollama:listInstalled', async (): Promise<OllamaModelManagerStatus> => {
    const baseUrl = await ollamaTitleBaseUrl();
    const language = await resolvedUiLanguage();
    try {
      return {
        online: true,
        baseUrl,
        models: await listInstalledOllamaModels(baseUrl, fetch, language),
      };
    } catch (error) {
      return {
        online: false,
        baseUrl,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle('ollama:searchLibrary', async (_event, query: string) => {
    const language = await resolvedUiLanguage();
    assertString(query, localizedText(language, 'zoekopdracht', 'search query'));
    return searchOllamaLibrary(query, fetch, language);
  });
  ipcMain.handle('ollama:listLibraryTags', async (_event, libraryPath: string) => {
    const language = await resolvedUiLanguage();
    assertString(libraryPath, localizedText(language, 'modelbibliotheekpad', 'model library path'));
    return listOllamaLibraryTags(libraryPath, fetch, language);
  });
  ipcMain.handle('ollama:pullModel', async (event, requestedModel: string) => {
    const language = await resolvedUiLanguage();
    const model = assertOllamaModelName(requestedModel, language);
    if (ollamaModelPullControllers.has(model.toLocaleLowerCase())) {
      throw new Error(localizedText(language, `${model} wordt al gedownload.`, `${model} is already being downloaded.`));
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const controller = new AbortController();
    ollamaModelPullControllers.set(model.toLocaleLowerCase(), controller);
    try {
      const baseUrl = await ollamaTitleBaseUrl();
      await pullOllamaModel(baseUrl, model, controller.signal, (progress) => {
        sendOllamaModelPullProgress(win, progress);
      }, fetch, undefined, language);
      invalidateOllamaProviderModels();
      return listInstalledOllamaModels(baseUrl, fetch, language);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled
        ? localizedText(language, `${model} downloaden is geannuleerd.`, `Downloading ${model} was cancelled.`)
        : error instanceof Error ? error.message : String(error);
      sendOllamaModelPullProgress(win, {
        model,
        phase: cancelled ? 'cancelled' : 'error',
        status: message,
      });
      throw new Error(message);
    } finally {
      ollamaModelPullControllers.delete(model.toLocaleLowerCase());
    }
  });
  ipcMain.handle('ollama:cancelPull', async (_event, requestedModel: string) => {
    const language = await resolvedUiLanguage();
    const model = assertOllamaModelName(requestedModel, language);
    const controller = ollamaModelPullControllers.get(model.toLocaleLowerCase());
    if (!controller) return false;
    controller.abort();
    return true;
  });
  ipcMain.handle('ollama:deleteModel', async (_event, requestedModel: string) => {
    const language = await resolvedUiLanguage();
    const model = assertOllamaModelName(requestedModel, language);
    if (ollamaModelPullControllers.has(model.toLocaleLowerCase())) {
      throw new Error(localizedText(
        language,
        'Annuleer de download voordat je dit model verwijdert.',
        'Cancel the download before removing this model.',
      ));
    }
    const baseUrl = await ollamaTitleBaseUrl();
    await deleteOllamaModel(baseUrl, model, fetch, language);
    const store = await getStore();
    const titleModel = String(store.get('chat.autoTitleOllamaModel') || '').replace(/^ollama:/, '');
    if (titleModel.toLocaleLowerCase() === model.toLocaleLowerCase()) {
      store.delete('chat.autoTitleOllamaModel');
    }
    invalidateOllamaProviderModels();
    return listInstalledOllamaModels(baseUrl, fetch, language);
  });
  ipcMain.handle('ollama:openLibrary', async (_event, query?: string) => {
    const url = new URL('/search', 'https://ollama.com');
    if (typeof query === 'string' && query.trim()) url.searchParams.set('q', query.trim().slice(0, 80));
    await shell.openExternal(url.toString());
    return true;
  });
  ipcMain.handle('runtime:getStatus', async (_event, runtime: RuntimeSetupId) => {
    assertRuntimeSetupId(runtime);
    return getRuntimeSetupStatus(runtime);
  });
  ipcMain.handle('runtime:install', async (event, runtime: RuntimeSetupId) => {
    assertRuntimeSetupId(runtime);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (runtime === 'ollama') {
      return ollamaRuntimeStatus(await installOllamaTitleSetup(win));
    }
    return installPythonRuntime(win);
  });

  ipcMain.handle('auth:saveCredential', async (_event, provider: ProviderType, secret: string, method = 'apikey') => {
    assertProvider(provider);
    assertString(secret, 'secret');
    const language = await resolvedUiLanguage();
    const validation = await adapters[provider].validateCredential(secret, { probeGeneration: true, language });
    if (validation.status === 'valid') {
      await saveCredential(provider, secret, method as any);
      if (provider === 'google') invalidateGeminiQuotaValidation();
      providerCredentialStatusesCache = null;
    }
    return validation;
  });
  ipcMain.handle('auth:setApiKey', async (_event, provider: ProviderType, key: string) => {
    assertProvider(provider);
    assertString(key, 'key');
    const language = await resolvedUiLanguage();
    const validation = await adapters[provider].validateCredential(key, { language });
    if (validation.status !== 'valid') throw new Error(validation.error || localizedText(language, 'API-key is niet geldig.', 'The API key is invalid.'));
    await saveCredential(provider, key, 'apikey');
    if (provider === 'google') invalidateGeminiQuotaValidation();
    providerCredentialStatusesCache = null;
    return true;
  });
  ipcMain.handle('auth:getApiKey', async () => null);
  ipcMain.handle('auth:removeApiKey', async (_event, provider: ProviderType) => {
    assertProvider(provider);
    if (provider === 'google') invalidateGeminiQuotaValidation();
    providerCredentialStatusesCache = null;
    return removeCredential(provider);
  });
  ipcMain.handle('auth:testCredential', async (_event, provider: ProviderType, secret?: string) => {
    assertProvider(provider);
    providerCredentialStatusesCache = null;
    const language = await resolvedUiLanguage();
    const result = await adapters[provider].validateCredential(secret, { probeGeneration: true, language });
    providerCredentialStatusesCache = null;
    return result;
  });
  ipcMain.handle('auth:testConnection', async (_event, provider: ProviderType) => {
    assertProvider(provider);
    providerCredentialStatusesCache = null;
    const language = await resolvedUiLanguage();
    const result = await adapters[provider].validateCredential(undefined, { probeGeneration: true, language });
    providerCredentialStatusesCache = null;
    return result.status === 'valid';
  });
  ipcMain.handle('auth:getStatus', async () => getProviderCredentialStatuses());
  ipcMain.handle('auth:getAuthStatus', async () => getProviderCredentialStatuses());
  ipcMain.handle('auth:browserLogin', async (_event, provider: ProviderType) => {
    const language = await resolvedUiLanguage();
    if (provider === 'openai') {
      return loginChatGptBrowser(language);
    }
    return { success: false, error: localizedText(language, 'Browserlogin is alleen beschikbaar voor ChatGPT.', 'Browser sign-in is only available for ChatGPT.') };
  });
  ipcMain.handle('auth:chatgptBrowserLogin', async () => loginChatGptBrowser(await resolvedUiLanguage()));
  ipcMain.handle('auth:chatgptBrowserLogout', async () => {
    await chatgptScraper.clearSession();
    return { success: true };
  });
  ipcMain.handle('auth:chatgptSessionStatus', async () => {
    return chatgptScraper.getSessionStatus();
  });
  ipcMain.handle('auth:chatgptEngineStatus', async () => {
    return chatgptScraper.getSessionStatus();
  });
  ipcMain.handle('auth:chatgptEngineReset', async () => {
    return chatgptScraper.resetEngine();
  });
  ipcMain.handle('auth:chatgptOpenWindow', async () => {
    return chatgptScraper.openChatGptWindow(await resolvedUiLanguage());
  });
  ipcMain.handle('auth:claudeCliLogin', async (event) => {
    const result = await openOrInstallInteractiveCli(
      'claude',
      BrowserWindow.fromWebContents(event.sender),
    );
    providerCredentialStatusesCache = null;
    cachedModels = cachedModels.filter((model) => !(model.provider === 'anthropic' && model.id.startsWith('claude-cli:')));
    return result;
  });
  ipcMain.handle('auth:codexCliLogin', async (event) => {
    const result = await openOrInstallInteractiveCli(
      'codex',
      BrowserWindow.fromWebContents(event.sender),
    );
    providerCredentialStatusesCache = null;
    cachedModels = cachedModels.filter((model) => model.provider !== 'codex');
    return result;
  });
  ipcMain.handle('auth:antigravityCliLogin', async (event) => {
    const result = await openOrInstallInteractiveCli(
      'antigravity',
      BrowserWindow.fromWebContents(event.sender),
    );
    providerCredentialStatusesCache = null;
    cachedModels = cachedModels.filter((model) => model.provider !== 'antigravity');
    return result;
  });

  ipcMain.handle('chat:sendMessage', async (event, request: ChatRequest) => {
    validateChatRequest(request);
    const win = BrowserWindow.fromWebContents(event.sender);
    activeRequestChatIds.set(request.requestId, request.chatId);
    try {
      return await sendUserMessageAndRunAssistant(win, request);
    } finally {
      activeRequestChatIds.delete(request.requestId);
      // De eerste titelpoging loopt parallel met het antwoord. Na de hoofdbeurt
      // krijgt een tijdelijk onbereikbaar lokaal Ollama-model nog één poging.
      void retryChatTitleAfterTurn(win, request.chatId, request.input, normalizeUiLanguage(request.language, 'nl')).catch(() => { });
    }
  });
  ipcMain.handle('chat:cancel', async (_event, requestId?: string) => cancelRequest(requestId));
  ipcMain.handle('chat:stopGeneration', async () => cancelRequest());

  registerDbHandlers(ipcMain);

  ipcMain.handle('tokens:getDashboard', async (_event, chatId?: string) => getTokenDashboard(chatId));
  ipcMain.handle('tokens:getUsage', async () => getTokenDashboard());
  ipcMain.handle('tokens:getContextUsage', async (_event, chatId: string, modelRef?: ModelRef) => getContextUsage(chatId, modelRef));
  ipcMain.handle('tokens:getRateLimits', async () => getStoredRateLimits());
  ipcMain.handle('tokens:getQuotas', async () => getStoredQuotaSnapshots());
  ipcMain.handle('tokens:refreshQuotas', async () => refreshProviderQuotas());

  ipcMain.handle('geminiQuota:getStatus', async (_event, validate = false) => getGeminiQuotaAuthStatus(!!validate, await resolvedUiLanguage()));
  ipcMain.handle('geminiQuota:configure', async (_event, projectId: string, oauthClientId: string) => configureGeminiQuota(projectId, oauthClientId, await resolvedUiLanguage()));
  ipcMain.handle('geminiQuota:connect', async () => {
    const status = await startGeminiQuotaOAuth(await resolvedUiLanguage());
    invalidateProviderStatusCaches();
    await refreshProviderQuotas().catch(() => []);
    return status;
  });
  ipcMain.handle('geminiQuota:disconnect', async () => {
    const status = await disconnectGeminiQuotaOAuth(await resolvedUiLanguage());
    invalidateProviderStatusCaches();
    return status;
  });
  ipcMain.handle('quotaBridge:ensure', async (_event, provider: 'claude' | 'antigravity') => ensureStatuslineBridge(provider));
  ipcMain.handle('quotaBridge:restore', async (_event, provider: 'claude' | 'antigravity') => restoreStatuslineBridge(provider));

  ipcMain.handle('fallback:getConfig', async () => getFallbackConfig());
  ipcMain.handle('fallback:setConfig', async (_event, config: FallbackConfig) => setFallbackConfig(config));
  ipcMain.handle('fallback:setOrder', async (_event, order: any[]) => {
    const config: FallbackConfig = {
      autoSwitchEnabled: true,
      order: order.map((item) => ({
        enabled: item.enabled !== false,
        allowPaidApi: item.allowPaidApi === true,
        modelRef: item.modelRef || { provider: item.provider, modelId: item.id || item.modelId },
      })),
    };
    return setFallbackConfig(config);
  });
  ipcMain.handle('fallback:setEnabled', async (_event, enabled: boolean) => {
    const config = await getFallbackConfig();
    config.autoSwitchEnabled = !!enabled;
    return setFallbackConfig(config);
  });


  ipcMain.handle('auto:start', async (event, config: AutoModeConfig) => {
    validateAutoModeConfig(config);
    assertProvider(config.prompterModelRef.provider);
    assertProvider(config.responderModelRef.provider);
    const language = await resolvedUiLanguage(config.language);
    if (autoModeRunId || autoModeState.status === 'running' || autoModeState.status === 'paused') {
      throw new Error(localizedText(language, 'Auto Mode draait al. Stop de huidige run voordat je opnieuw start.', 'Auto Mode is already running. Stop the current run before starting again.'));
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const cleanConfig: AutoModeConfig = {
      ...config,
      prompterModelRef: normalizeModelRef(config.prompterModelRef),
      responderModelRef: normalizeModelRef(config.responderModelRef),
      language,
    };
    const runId = crypto.randomUUID();
    autoModeRunId = runId;
    autoModeStopRequested = false;
    autoModeState = {
      chatId: cleanConfig.chatId,
      status: 'running',
      phase: 'starting',
      phaseStartedAt: new Date().toISOString(),
      iteration: 0,
      totalTokens: 0,
      maxIterations: cleanConfig.maxIterations,
      tokenBudget: cleanConfig.tokenBudget,
      detail: localizedText(language, 'Auto Mode gestart.', 'Auto Mode started.'),
      lastPromptPreview: '',
      error: undefined,
    };
    win?.webContents.send('auto:iteration', { ...autoModeState });
    // Het ingestelde doel is al genoeg context voor een goede titel. Start die
    // meteen bij Start; zonder doel probeert de eerste gegenereerde prompt het.
    if (cleanConfig.goal?.trim()) {
      void generateChatTitleIfNeeded(
        win,
        cleanConfig.chatId,
        cleanConfig.goal,
        cleanConfig.prompterModelRef,
        language,
      ).catch(() => { });
    }
    runAutoModeLoop(win, cleanConfig, runId)
      .catch((error) => {
        if (autoModeRunId !== runId) return;
        publishAutoModeState(win, {
          status: 'stopped',
          phase: 'error',
          detail: localizedText(language, 'Auto Mode is gestopt door een fout.', 'Auto Mode stopped because of an error.'),
          error: error?.message || String(error),
        });
      })
      .finally(() => {
        if (autoModeRunId === runId) autoModeRunId = null;
      });
    return autoModeState;
  });
  ipcMain.handle('auto:pause', async (event) => {
    const language = await resolvedUiLanguage();
    if (autoModeState.status === 'running') {
      publishAutoModeState(BrowserWindow.fromWebContents(event.sender), {
        status: 'paused',
        phase: 'paused',
        detail: localizedText(language, 'Auto Mode is gepauzeerd.', 'Auto Mode is paused.'),
      });
    }
    return autoModeState;
  });
  ipcMain.handle('auto:resume', async (event) => {
    const language = await resolvedUiLanguage();
    if (autoModeState.status === 'paused') {
      publishAutoModeState(BrowserWindow.fromWebContents(event.sender), {
        status: 'running',
        phase: 'starting',
        detail: localizedText(language, 'Auto Mode wordt hervat.', 'Auto Mode is resuming.'),
      });
    }
    return autoModeState;
  });
  ipcMain.handle('auto:stop', async (event) => {
    const language = await resolvedUiLanguage();
    autoModeStopRequested = true;
    for (const requestId of autoModeRequestIds) activeRequests.get(requestId)?.abort();
    autoModeRequestIds.clear();
    autoModeRunId = null;
    publishAutoModeState(BrowserWindow.fromWebContents(event.sender), {
      status: 'stopped',
      phase: 'stopped',
      detail: localizedText(language, 'Auto Mode is gestopt.', 'Auto Mode is stopped.'),
      error: undefined,
    });
    return autoModeState;
  });
  ipcMain.handle('auto:getStatus', async () => autoModeState);

  // ── Agent PC access (phase 1: command execution with approval modes) ──
  ipcMain.handle('agent:getConfig', async () => getAgentConfig());
  ipcMain.handle('agent:getPendingApprovals', async (event) => (
    [...pendingAgentApprovals.values()]
      .filter((pending) => pending.ownerId === event.sender.id)
      .map((pending) => pending.request)
  ));
  ipcMain.handle('agent:setConfig', async (_event, config: { mode?: AgentApprovalMode; workingDir?: string; toolsEnabled?: boolean; defaultShell?: AgentShell }) => setAgentConfig(config));
  ipcMain.handle('agent:runCommand', async (event, command: string, options?: { shell?: AgentShell; cwd?: string; source?: CommandRun['source'] }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return runAgentCommand(win, String(command || ''), options || {});
  });
  ipcMain.handle('agent:approvalResponse', async (event, id: string, approved: boolean) => {
    const pending = pendingAgentApprovals.get(id);
    if (pending && pending.ownerId === event.sender.id) {
      pendingAgentApprovals.delete(id);
      pending.resolve(!!approved, 'answered');
    }
    return { ok: true };
  });

  ipcMain.handle('keys:validateBatch', async (event, keys: Array<{ key: string; provider?: ProviderType }>) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return validateKeyBatch(win, keys);
  });
  ipcMain.handle('keys:validateKeys', async (event, keys: Array<{ key: string; provider?: ProviderType }>) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return validateKeyBatch(win, keys);
  });

  ipcMain.handle('files:selectAndImport', async (_event, chatId?: string) => selectAndImportFiles(chatId));
  ipcMain.handle('files:selectFiles', async (_event, chatId?: string) => selectAndImportFiles(chatId));
  // ChatGPT's eigen modelkiezer (versions + intelligence_presets), zodat de UI
  // exact toont wat de website toont i.p.v. modelnamen te parsen.
  ipcMain.handle('providers:chatgptVersions', async () => {
    try {
      return await chatgptScraper.listSessionVersions();
    } catch {
      return [];
    }
  });
  ipcMain.handle('files:selectDirectory', async () => selectDirectory());
  ipcMain.handle('files:getDefaultWorkspace', async () => ensureDefaultWorkspacePath());
  ipcMain.handle('files:readFile', async (_event, attachmentId: string) => getAttachmentById(attachmentId));
  ipcMain.handle('files:deletePending', async (_event, attachmentId: string) => {
    assertString(attachmentId, 'attachmentId');
    const pending = getDb().prepare('SELECT path FROM attachments WHERE id = ? AND messageId IS NULL').get(attachmentId) as { path?: string } | undefined;
    if (pending?.path) await removeManagedAttachmentPath(pending.path);
    const result = getDb().prepare('DELETE FROM attachments WHERE id = ? AND messageId IS NULL').run(attachmentId);
    importedAttachmentIds.delete(attachmentId);
    return result.changes > 0;
  });

  ipcMain.handle('settings:get', async (_event, key: string) => {
    assertRendererSettingKey(key);
    return (await getStore()).get(key);
  });
  ipcMain.handle('settings:set', async (_event, key: string, value: any) => {
    assertRendererSettingKey(key);
    const store = await getStore();
    if (key === 'sshConfig') {
      const config = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const password = boundedString(config.password, 4_096, 'SSH-wachtwoord');
      const privateKey = boundedString(config.privateKey, 1_000_000, 'SSH-privésleutel');
      const host = boundedString(config.host, 255, 'SSH-host').trim();
      const user = boundedString(config.user, 255, 'SSH-gebruiker').trim();
      const port = Number(config.port || 22);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SSH-poort moet tussen 1 en 65535 liggen.');
      if (password || privateKey) await saveCredential('remote', JSON.stringify({ password, privateKey }), 'apikey');
      store.set(key, {
        host,
        port: String(port),
        user,
      });
      return true;
    }
    const sanitized = sanitizeRendererSettingValue(key, value);
    store.set(key, sanitized);
    if (key === 'ui.language') {
      invalidateProviderStatusCaches();
      invalidateGeminiQuotaValidation();
      appEvents.emit('ui-language-changed', normalizeUiLanguage(sanitized, 'nl'));
    }
    return true;
  });
  ipcMain.handle('settings:getAll', async () => {
    const store = await getStore();
    // Expliciete allowlist: een toekomstig geheim in electron-store kan hierdoor
    // niet per ongeluk via een brede clone in de renderer belanden.
    return buildRendererSettingsSnapshot((key) => store.get(key));
  });
  ipcMain.handle('settings:resetSshFingerprint', async () => {
    const store = await getStore();
    const config = (store.get('sshConfig') || {}) as Record<string, unknown>;
    const host = String(config.host || '').trim().toLowerCase();
    if (!host) return false;
    const id = `${host}:${Number(config.port || 22)}`;
    const fingerprints = { ...((store.get('sshHostFingerprints') || {}) as Record<string, string>) };
    if (!(id in fingerprints)) return false;
    delete fingerprints[id];
    store.set('sshHostFingerprints', fingerprints);
    return true;
  });
}

function registerDbHandlers(ipcMain: IpcMain) {
  ipcMain.handle('db:getChats', async () => getDb().prepare('SELECT * FROM chats ORDER BY updatedAt DESC').all().map(mapChatRow));
  ipcMain.handle('db:getChat', async (_event, id: string) => getChatById(id));
  ipcMain.handle('db:createChat', async (_event, title: string, folderId?: string, id?: string) => {
    const chat = createChat(title, folderId, id);
    notifyChatsChanged();
    return chat;
  });
  ipcMain.handle('db:updateChat', async (_event, id: string, data: Partial<Chat>) => {
    const chat = updateChat(id, data);
    notifyChatsChanged();
    return chat;
  });
  ipcMain.handle('db:deleteChat', async (_event, id: string) => {
    await removeManagedAttachmentFilesForChat(id);
    getDb().prepare('DELETE FROM chats WHERE id = ?').run(id);
    notifyChatsChanged();
    return true;
  });

  ipcMain.handle('db:getMessages', async (_event, chatId: string) =>
    getDb().prepare('SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC').all(chatId),
  );
  ipcMain.handle('db:addMessage', async (_event, msg: Message) => insertMessage(msg));
  ipcMain.handle('db:deleteMessage', async (_event, id: string) => {
    await removeManagedAttachmentFilesForMessage(id);
    getDb().prepare('DELETE FROM attachments WHERE messageId = ?').run(id);
    getDb().prepare('DELETE FROM messages WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('db:getFolders', async () => getDb().prepare('SELECT * FROM folders ORDER BY sortOrder ASC').all());
  ipcMain.handle('db:createFolder', async (_event, name: string, parentId?: string) => {
    const folder = {
      id: crypto.randomUUID(),
      name: String(name || '').trim() || 'Nieuwe map',
      parentId: parentId || null,
      projectPath: null,
      sortOrder: (getDb().prepare('SELECT COUNT(*) as count FROM folders').get() as { count: number }).count,
      createdAt: new Date().toISOString(),
    };
    getDb()
      .prepare('INSERT INTO folders (id, name, parentId, projectPath, sortOrder, createdAt) VALUES (@id, @name, @parentId, @projectPath, @sortOrder, @createdAt)')
      .run(folder);
    return folder;
  });
  ipcMain.handle('db:updateFolder', async (_event, id: string, nameOrData: string | Partial<Folder>) => {
    const data = typeof nameOrData === 'string' ? { name: nameOrData } : (nameOrData || {});
    const clean: Record<string, any> = {};
    if (Object.prototype.hasOwnProperty.call(data, 'name')) clean.name = String(data.name || '').trim() || 'Map';
    if (Object.prototype.hasOwnProperty.call(data, 'projectPath')) clean.projectPath = normalizeProjectPath((data as any).projectPath);
    if (Object.keys(clean).length) {
      const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
      getDb().prepare(`UPDATE folders SET ${updates} WHERE id = @id`).run({ ...clean, id });
    }
    return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id);
  });
  ipcMain.handle('db:deleteFolder', async (_event, id: string) => {
    const db = getDb();
    const chatRows = db.prepare('SELECT id FROM chats WHERE folderId = ?').all(id) as Array<{ id: string }>;
    for (const chat of chatRows) await removeManagedAttachmentFilesForChat(chat.id);
    // Een project verwijderen wist ook z'n gesprekken. Zonder de expliciete DELETE
    // zou de FK (ON DELETE SET NULL) ze losmaken en als "los gesprek" laten staan.
    // De berichten van die chats gaan mee via ON DELETE CASCADE.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chats WHERE folderId = ?').run(id);
      db.prepare("DELETE FROM memories WHERE type = 'project' AND scopeId = ?").run(id);
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    notifyChatsChanged();
    return true;
  });

  ipcMain.handle('db:getMemory', async (_event, type?: string, scopeId?: string) => {
    let query = 'SELECT * FROM memories WHERE 1=1';
    const params: any[] = [];
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    if (scopeId) {
      query += ' AND scopeId = ?';
      params.push(scopeId);
    }
    return getDb().prepare(query).all(...params);
  });
  ipcMain.handle('db:addMemory', async (_event, mem: any) => {
    const memory = {
      id: mem.id || crypto.randomUUID(),
      type: mem.type,
      scopeId: mem.scopeId || null,
      title: String(mem.title || '').trim() || 'Memory',
      content: String(mem.content || ''),
      maxTokens: Number(mem.maxTokens || 1000),
      enabled: mem.enabled === false ? 0 : 1,
      createdAt: mem.createdAt || new Date().toISOString(),
    };
    getDb()
      .prepare('INSERT INTO memories (id, type, scopeId, title, content, maxTokens, enabled, createdAt) VALUES (@id, @type, @scopeId, @title, @content, @maxTokens, @enabled, @createdAt)')
      .run(memory);
    return memory;
  });
  ipcMain.handle('db:updateMemory', async (_event, id: string, data: any) => updateMemory(id, data));
  ipcMain.handle('db:deleteMemory', async (_event, id: string) => {
    getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('db:getPresets', async () => getDb().prepare('SELECT * FROM prompt_presets ORDER BY updatedAt DESC').all());
  ipcMain.handle('db:savePreset', async (_event, preset: any) => savePromptPreset(preset));
  ipcMain.handle('db:deletePreset', async (_event, id: string) => {
    getDb().prepare('DELETE FROM prompt_presets WHERE id = ?').run(id);
    return true;
  });
}

// ── Automatische gesprekstitels ──────────────────────────────────────────────
const DEFAULT_CHAT_TITLES = new Set(['Nieuw gesprek', 'New chat']);
const TITLE_SYSTEM_INSTRUCTION_NL = [
  'Je maakt Nederlandse gesprekstitels.',
  'Zet de vraag of opdracht om in een natuurlijke onderwerpstitel van 3 tot 6 woorden.',
  'Neem het eerste bericht niet letterlijk over.',
  'Antwoord uitsluitend met de titel: geen uitleg, label, aanhalingstekens of eindpunt.',
].join(' ');
const TITLE_SYSTEM_INSTRUCTION_EN = [
  'You create English conversation titles.',
  'Turn the question or request into a natural topic title of 3 to 6 words.',
  'Do not copy the first message literally.',
  'Reply with the title only: no explanation, label, quotation marks, or final period.',
].join(' ');
const titleGenerationInFlight = new Map<string, Promise<void>>();
let ollamaTitleSetupInFlight: Promise<OllamaTitleSetupStatus> | null = null;

// Ollama is de enige AI-provider voor gesprekstitels. Oude `auto`- en
// `gpt`-instellingen migreren hier zonder dat ChatGPT nog wordt aangeroepen.
async function resolveTitleMode(_answerModelRef?: ModelRef): Promise<ChatTitleMode> {
  const store = await getStore();
  const configured = (store.get('chat.autoTitleMode') as string | undefined) || 'ollama';
  const resolved = resolveConfiguredChatTitleMode(configured);
  if (configured !== resolved) store.set('chat.autoTitleMode', resolved);
  return resolved;
}

async function ollamaTitleBaseUrl() {
  const store = await getStore();
  return String(store.get('ollama.url') || 'http://localhost:11434').replace(/\/$/, '');
}

async function readOllamaTitleCatalog(): Promise<{
  baseUrl: string;
  runtimeAvailable: boolean;
  models: OllamaTitleModel[];
}> {
  const configuredBaseUrl = await ollamaTitleBaseUrl();
  for (const baseUrl of ollamaProbeBaseUrls(configuredBaseUrl)) {
    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        const data = await response.json() as { models?: OllamaTitleModel[] };
        if (baseUrl !== configuredBaseUrl && isLocalOllamaUrl(baseUrl)) {
          const store = await getStore();
          store.set('ollama.url', baseUrl);
        }
        return {
          baseUrl,
          runtimeAvailable: true,
          models: Array.isArray(data.models) ? data.models : [],
        };
      }
    } catch { /* volgende lokale adresvariant proberen */ }
  }
  return {
    baseUrl: configuredBaseUrl,
    runtimeAvailable: false,
    models: [],
  };
}

async function getOllamaTitleSetupStatus(): Promise<OllamaTitleSetupStatus> {
  const store = await getStore();
  const catalog = await readOllamaTitleCatalog();
  return resolveOllamaTitleSetup(
    store.get('chat.autoTitleOllamaModel'),
    catalog.models,
    catalog.runtimeAvailable,
  );
}

async function titleViaOllama(firstUser: string, language: UiLanguage = 'nl'): Promise<string> {
  const store = await getStore();
  const catalog = await readOllamaTitleCatalog();
  const baseUrl = catalog.baseUrl;
  const model = selectOllamaTitleModel(
    store.get('chat.autoTitleOllamaModel'),
    catalog.models,
  );
  if (!catalog.runtimeAvailable || !model) return '';

  const requestTitle = async (retryFrom?: string) => {
    const firstMessage = firstUser.slice(0, 600);
    const userPrompt = language === 'en'
      ? (retryFrom ? [
        'Provide exactly a title matching the pattern "Conversation about [2 to 4 content words]".',
        'Use only the main topic and properties from the message; omit question and command words.',
        `Rejected title: ${retryFrom}`,
        `Message: ${firstMessage}`,
      ] : [
        'Provide exactly a title matching the pattern "Conversation about [2 to 4 content words]".',
        'Use only the main topic and properties from the message; omit question and command words.',
        `Message: ${firstMessage}`,
      ]).join('\n')
      : (retryFrom ? [
        'Geef exact een titel in het patroon "Gesprek over [2 tot 4 inhoudswoorden]".',
        'Neem alleen het belangrijkste onderwerp en eigenschappen uit het bericht over;',
        'laat vraag- en opdrachtwoorden weg.',
        `Afgekeurde titel: ${retryFrom}`,
        `Bericht: ${firstMessage}`,
      ] : [
        'Geef exact een titel in het patroon "Gesprek over [2 tot 4 inhoudswoorden]".',
        'Neem alleen het belangrijkste onderwerp en eigenschappen uit het bericht over;',
        'laat vraag- en opdrachtwoorden weg.',
        `Bericht: ${firstMessage}`,
      ]).join('\n');
    const request = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: localizedText(language, TITLE_SYSTEM_INSTRUCTION_NL, TITLE_SYSTEM_INSTRUCTION_EN) },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        think: false,
        options: {
          temperature: 0.1,
          num_predict: 30,
        },
      }),
    });
    const response = await withHardTimeout(request, 61_000, localizedText(language, 'Ollama-titel duurde te lang.', 'Ollama title generation took too long.'));
    if (!response.ok) throw new Error(localizedText(language, `Ollama-titel mislukt (${response.status}).`, `Ollama title generation failed (${response.status}).`));
    const data = await response.json() as { message?: { content?: string }; response?: string };
    return String(data.message?.content || data.response || '');
  };

  const first = await requestTitle();
  const cleaned = sanitizeGeneratedChatTitle(first);
  if (isUsableGeneratedChatTitle(cleaned, firstUser)) return cleaned;
  const retry = sanitizeGeneratedChatTitle(await requestTitle(cleaned || first));
  if (isUsableGeneratedChatTitle(retry, firstUser)) return retry;
  const prefix = localizedText(language, 'Gesprek over', 'Conversation about');
  return retry && isGeneratedTitleDistinct(`${prefix} ${retry}`, firstUser)
    ? `${prefix} ${retry}`.slice(0, 60).trim()
    : '';
}

function sendOllamaTitleSetupProgress(
  win: BrowserWindow | null,
  progress: OllamaTitleSetupProgress,
) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('chat:titleOllamaSetupProgress', progress);
  win.webContents.send('runtime:setupProgress', ollamaRuntimeProgress(progress));
}

function sendOllamaModelPullProgress(
  win: BrowserWindow | null,
  progress: OllamaModelPullProgress,
) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('ollama:modelPullProgress', progress);
}

function invalidateOllamaProviderModels() {
  adapters.ollama.invalidateModelCache?.();
  cachedModels = cachedModels.filter((model) => model.provider !== 'ollama');
  providerCredentialStatusesCache = null;
}

function ollamaRuntimeProgress(progress: OllamaTitleSetupProgress): RuntimeSetupProgress {
  const phase = ({
    checking: 'checking',
    'downloading-runtime': 'downloading',
    'verifying-runtime': 'checking',
    'installing-runtime': 'installing',
    'starting-runtime': 'starting',
    'downloading-model': 'pulling-model',
    ready: 'ready',
    error: 'error',
  } as const)[progress.phase];
  return {
    runtime: 'ollama',
    phase,
    status: progress.status,
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  };
}

function sendRuntimeSetupProgress(
  win: BrowserWindow | null,
  progress: RuntimeSetupProgress,
) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('runtime:setupProgress', progress);
}

async function getRuntimeSetupStatus(runtime: RuntimeSetupId): Promise<RuntimeStatus> {
  if (runtime === 'ollama') return ollamaRuntimeStatus(await getOllamaTitleSetupStatus());
  const store = await getStore();
  const status = await getPythonRuntimeStatus(store.get('runtime.pythonExecutable'));
  if (status.ready) activatePythonRuntime(status.executablePath);
  return pythonRuntimeStatus(status);
}

function ollamaRuntimeStatus(status: OllamaTitleSetupStatus): RuntimeStatus {
  return {
    runtime: 'ollama',
    ready: status.ready,
    detail: status.ready
      ? `Ollama en ${status.model} zijn gebruiksklaar.`
      : status.runtimeAvailable
        ? `Ollama draait, maar model ${status.model} ontbreekt.`
        : 'Ollama is niet geïnstalleerd of niet bereikbaar.',
    model: status.model,
    installedModels: status.installedModels,
  };
}

function pythonRuntimeStatus(status: PythonRuntimeStatus): RuntimeStatus {
  return {
    runtime: 'python',
    ready: status.ready,
    executablePath: status.executablePath,
    version: status.version,
    detail: status.detail,
  };
}

async function installPythonRuntime(win: BrowserWindow | null): Promise<RuntimeStatus> {
  sendRuntimeSetupProgress(win, {
    runtime: 'python',
    phase: 'checking',
    status: 'Python-runtime controleren...',
  });
  let status = await getRuntimeSetupStatus('python');
  if (status.ready) {
    sendRuntimeSetupProgress(win, {
      runtime: 'python',
      phase: 'ready',
      status: `${status.version || 'Python'} is gebruiksklaar.`,
    });
    return status;
  }

  if (process.platform !== 'win32') {
    await shell.openExternal('https://www.python.org/downloads/');
    throw new Error('De officiële Python-downloadpagina is geopend. Installeer Python en controleer daarna opnieuw.');
  }

  try {
    sendRuntimeSetupProgress(win, {
      runtime: 'python',
      phase: 'downloading',
      status: 'Officiële Python Install Manager ophalen...',
    });
    await runSetupProcess('winget.exe', [
      'install',
      PYTHON_INSTALL_MANAGER_PACKAGE_ID,
      '-e',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ], 30 * 60_000, (output) => {
      const progress = parsePythonInstallerProgress(output);
      if (!progress) return;
      sendRuntimeSetupProgress(win, {
        runtime: 'python',
        phase: 'downloading',
        status: `Officiële Python Install Manager ophalen... ${progress.percent}%`,
        ...progress,
      });
    });

    for (const command of pythonInstallManagerCommands()) {
      sendRuntimeSetupProgress(win, {
        runtime: 'python',
        phase: command.phase,
        status: command.status,
      });
      await runSetupProcess(
        'pymanager.exe',
        command.args,
        command.phase === 'configuring' ? 10 * 60_000 : 30 * 60_000,
        (output) => {
          const progress = parsePythonInstallerProgress(output);
          if (!progress) return;
          sendRuntimeSetupProgress(win, {
            runtime: 'python',
            phase: command.phase,
            status: `${command.status} ${progress.percent}%`,
            ...progress,
          });
        },
      );
    }
  } catch (error) {
    sendRuntimeSetupProgress(win, {
      runtime: 'python',
      phase: 'error',
      status: error instanceof Error ? error.message : String(error),
    });
    await shell.openExternal('https://www.python.org/downloads/');
    throw new Error(
      `Automatische Python-installatie is niet afgerond. De officiële downloadpagina is geopend. ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  status = await getRuntimeSetupStatus('python');
  if (!status.ready || !status.executablePath) {
    throw new Error('Python is geïnstalleerd, maar een werkende runtime kon niet worden gevonden.');
  }
  const store = await getStore();
  store.set('runtime.pythonExecutable', status.executablePath);
  activatePythonRuntime(status.executablePath);
  sendRuntimeSetupProgress(win, {
    runtime: 'python',
    phase: 'ready',
    status: `${status.version || 'Python'} is gebruiksklaar.`,
  });
  return status;
}

function assertRuntimeSetupId(value: unknown): asserts value is RuntimeSetupId {
  if (value !== 'ollama' && value !== 'python') {
    throw new Error('Onbekende runtime.');
  }
}

async function installOllamaTitleSetup(win: BrowserWindow | null): Promise<OllamaTitleSetupStatus> {
  if (ollamaTitleSetupInFlight) return ollamaTitleSetupInFlight;
  const language = await resolvedUiLanguage();

  const task = runOllamaTitleSetup(win, language)
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const message = localizedText(
        language,
        `Installatie voor lokale gesprekstitels is mislukt (${detail})`,
        `Local chat-title setup failed (${detail})`,
      );
      sendOllamaTitleSetupProgress(win, {
        phase: 'error',
        status: message,
        model: DEFAULT_OLLAMA_TITLE_MODEL,
      });
      throw new Error(message);
    })
    .finally(() => {
      if (ollamaTitleSetupInFlight === task) ollamaTitleSetupInFlight = null;
    });
  ollamaTitleSetupInFlight = task;
  return task;
}

async function runOllamaTitleSetup(win: BrowserWindow | null, language: UiLanguage): Promise<OllamaTitleSetupStatus> {
  sendOllamaTitleSetupProgress(win, {
    phase: 'checking',
    status: localizedText(language, 'Ollama en het titelmodel controleren...', 'Checking Ollama and the title model...'),
    model: DEFAULT_OLLAMA_TITLE_MODEL,
  });
  let status = await getOllamaTitleSetupStatus();
  if (status.ready) {
    sendOllamaTitleSetupProgress(win, {
      phase: 'ready',
      status: localizedText(language, `Ollama en ${status.model} zijn klaar voor gesprekstitels.`, `Ollama and ${status.model} are ready for chat titles.`),
      model: status.model,
      percent: 100,
    });
    return status;
  }

  let baseUrl = await ollamaTitleBaseUrl();
  if (!status.runtimeAvailable) {
    if (!isLocalOllamaUrl(baseUrl)) {
      throw new Error(localizedText(
        language,
        'De ingestelde Ollama-URL is niet bereikbaar. Start die server of gebruik de lokale Ollama-URL.',
        'The configured Ollama URL is unreachable. Start that server or use the local Ollama URL.',
      ));
    }
    let executable = await findOllamaExecutable();
    if (!executable) {
      await installOfficialOllamaRuntime(win, status.model, language);
      executable = await findOllamaExecutable();
    }
    baseUrl = await ensureOllamaRuntimeStarted(win, status.model, executable, language);
    status = await getOllamaTitleSetupStatus();
    if (!status.runtimeAvailable) {
      throw new Error(localizedText(language, 'Ollama is geïnstalleerd, maar de lokale server kon niet worden gestart.', 'Ollama is installed, but the local server could not be started.'));
    }
  }

  const store = await getStore();
  store.set('ollama.url', baseUrl);
  if (!status.modelAvailable) {
    await pullOllamaTitleModel(win, baseUrl, status.model, language);
    store.set('chat.autoTitleOllamaModel', status.model);
  }

  invalidateOllamaProviderModels();
  status = await getOllamaTitleSetupStatus();
  if (!status.ready) {
    throw new Error(localizedText(
      language,
      `Ollama-model ${status.model} is na het downloaden niet beschikbaar.`,
      `Ollama model ${status.model} is unavailable after downloading.`,
    ));
  }

  sendOllamaTitleSetupProgress(win, {
    phase: 'ready',
    status: localizedText(language, `Ollama en ${status.model} zijn klaar voor gesprekstitels.`, `Ollama and ${status.model} are ready for chat titles.`),
    model: status.model,
    percent: 100,
  });
  return status;
}

function isLocalOllamaUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

async function installOfficialOllamaRuntime(win: BrowserWindow | null, model: string, language: UiLanguage) {
  if (process.platform !== 'win32') {
    await shell.openExternal('https://ollama.com/download');
    throw new Error(localizedText(
      language,
      'De officiële Ollama-downloadpagina is geopend. Installeer Ollama en probeer daarna opnieuw.',
      'The official Ollama download page is open. Install Ollama, then try again.',
    ));
  }

  const installerPath = path.join(
    os.tmpdir(),
    `ai-superapp-OllamaSetup-${process.pid}-${crypto.randomBytes(8).toString('hex')}.exe`,
  );
  try {
    await downloadHttpFile(
      OLLAMA_WINDOWS_INSTALLER_URL,
      installerPath,
      {
        timeoutMs: 60 * 60_000,
        onProgress: (progress) => {
          sendOllamaTitleSetupProgress(win, {
            phase: 'downloading-runtime',
            status: `${localizedText(language, 'Ollama voor Windows downloaden', 'Downloading Ollama for Windows')}${progress.percent === undefined ? '...' : `... ${progress.percent}%`}`,
            model,
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
          });
        },
      },
    );

    sendOllamaTitleSetupProgress(win, {
      phase: 'verifying-runtime',
      status: localizedText(language, 'Digitale handtekening van de Ollama-installer controleren...', 'Verifying the Ollama installer digital signature...'),
      model,
      percent: 100,
    });
    await runSetupProcess('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ollamaAuthenticodeVerificationPowerShell(installerPath),
    ], 2 * 60_000);

    sendOllamaTitleSetupProgress(win, {
      phase: 'installing-runtime',
      status: localizedText(language, 'De gecontroleerde Ollama-installer wordt uitgevoerd...', 'Running the verified Ollama installer...'),
      model,
      percent: 100,
    });
    await runSetupProcess(
      installerPath,
      [...OLLAMA_WINDOWS_INSTALLER_ARGS],
      60 * 60_000,
    );
  } finally {
    await fs.promises.rm(installerPath, { force: true }).catch(() => { });
  }
}

async function findOllamaExecutable() {
  return findExecutablePath([
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
    'ollama',
  ].filter(Boolean));
}

async function ensureOllamaRuntimeStarted(
  win: BrowserWindow | null,
  model: string,
  detectedExecutable?: string | null,
  language: UiLanguage = 'nl',
) {
  sendOllamaTitleSetupProgress(win, {
    phase: 'starting-runtime',
    status: localizedText(language, 'De lokale Ollama-server wordt gestart...', 'Starting the local Ollama server...'),
    model,
  });
  const startedByInstaller = await waitForOllamaRuntime(15_000);
  if (startedByInstaller) return startedByInstaller;

  const executable = detectedExecutable || await findOllamaExecutable();
  if (!executable) {
    throw new Error(localizedText(language, 'Ollama is geïnstalleerd, maar ollama.exe is niet gevonden.', 'Ollama is installed, but ollama.exe was not found.'));
  }

  const diagnostics: string[] = [];
  for (const candidate of ollamaWindowsStartCandidates(executable)) {
    if (candidate.requiresExistingFile && !fs.existsSync(candidate.file)) continue;
    sendOllamaTitleSetupProgress(win, {
      phase: 'starting-runtime',
      status: localizedText(language, `${candidate.label} starten...`, `Starting ${candidate.label}...`),
      model,
    });
    let started: Awaited<ReturnType<typeof startOllamaRuntimeCandidate>> | null = null;
    try {
      started = await startOllamaRuntimeCandidate(candidate.file, candidate.args);
      const reachable = await waitForOllamaRuntime(60_000);
      diagnostics.push(started.output());
      if (reachable) {
        started.release();
        started = null;
        const store = await getStore();
        store.set('ollama.url', reachable);
        return reachable;
      }
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (started) {
        if (!started.exited()) terminateProcessTree(started.child);
        started.release();
      }
    }
  }

  diagnostics.push(readOllamaServerLogTail());
  const detail = conciseOllamaStartupDiagnostic(...diagnostics);
  throw new Error(
    localizedText(
      language,
      `De lokale Ollama-server reageert niet na het starten.${detail ? `\nLaatste Ollama-melding:\n${detail}` : ''}`,
      `The local Ollama server did not respond after starting.${detail ? `\nLatest Ollama detail:\n${detail}` : ''}`,
    ),
  );
}

async function waitForOllamaRuntime(timeoutMs: number) {
  const configuredBaseUrl = await ollamaTitleBaseUrl();
  const baseUrls = ollamaProbeBaseUrls(configuredBaseUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const baseUrl of baseUrls) {
      try {
        const response = await fetch(`${baseUrl}/api/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) return baseUrl;
      } catch { /* opnieuw proberen tot de deadline */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

function startOllamaRuntimeCandidate(file: string, args: string[]) {
  return new Promise<{
    child: ReturnType<typeof spawn>;
    output: () => string;
    exited: () => boolean;
    release: () => void;
  }>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: os.homedir(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: agentCommandEnvironment(),
    });
    let output = '';
    let didExit = false;
    const append = (data: Buffer | string) => {
      output = `${output}${data.toString()}`.slice(-8_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('close', () => { didExit = true; });
    child.once('error', reject);
    child.once('spawn', () => {
      resolve({
        child,
        output: () => output,
        exited: () => didExit,
        release: () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        },
      });
    });
  });
}

function readOllamaServerLogTail() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return '';
  try {
    const content = fs.readFileSync(path.join(localAppData, 'Ollama', 'server.log'), 'utf8');
    return content.slice(-8_000);
  } catch {
    return '';
  }
}

async function pullOllamaTitleModel(
  win: BrowserWindow | null,
  baseUrl: string,
  model: string,
  language: UiLanguage,
) {
  try {
    await pullOllamaModel(
      baseUrl,
      model,
      AbortSignal.timeout(60 * 60_000),
      (progress) => {
        sendOllamaTitleSetupProgress(win, {
          phase: 'downloading-model',
          status: progress.status,
          model,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        });
      },
      fetch,
      undefined,
      language,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b401\b|unauthori[sz]ed/i.test(message)) {
      const clockGuidance = await diagnoseOllamaClockSkew(fetch, Date.now(), language);
      if (clockGuidance) {
        throw new Error(
          localizedText(
            language,
            `Ollama Registry weigerde het publieke model ${model} (401). Hiervoor is geen Ollama API-key nodig. ${clockGuidance}`,
            `Ollama Registry rejected the public model ${model} (401). No Ollama API key is required. ${clockGuidance}`,
          ),
        );
      }
    }
    throw error;
  }
}

function runSetupProcess(
  file: string,
  args: string[],
  timeoutMs: number,
  onOutput?: (accumulatedOutput: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: os.homedir(),
      windowsHide: true,
      env: agentCommandEnvironment(),
    });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error('De runtime-installatie duurde te lang en is gestopt.'));
    }, timeoutMs);
    child.stderr?.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-8_000);
      onOutput?.(`${stdout}\n${stderr}`.slice(-24_000));
    });
    // De officiële installer schrijft voortgang naar stdout. Altijd leeglezen,
    // anders kan een volle pipe het installatieproces laten vastlopen.
    child.stdout?.on('data', (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-24_000);
      onOutput?.(`${stdout}\n${stderr}`.slice(-24_000));
    });
    child.on('close', (code) => {
      finish(code === 0
        ? undefined
        : new Error(
          stderr.trim()
          || stdout.trim()
          || `De runtime-installatie stopte met code ${code}.`,
        ));
    });
    child.on('error', (error) => finish(error));
  });
}

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function generateChatTitleAttempt(
  win: BrowserWindow | null,
  chatId: string,
  firstUserText?: string,
  answerModelRef?: ModelRef,
  explicitLanguage?: UiLanguage,
) {
  const language = await resolvedUiLanguage(explicitLanguage);
  const chat = getDb().prepare('SELECT id, title FROM chats WHERE id = ?').get(chatId) as { id: string; title: string } | undefined;
  if (!chat) return;

  const firstUser = (getChatMessages(chatId)
    .find((message) => message.role === 'user' && message.content && !message.content.startsWith('Tool output:'))
    ?.content || firstUserText || '').trim();
  if (!firstUser) return;
  const currentTitle = (chat.title || '').trim();
  if (!DEFAULT_CHAT_TITLES.has(currentTitle)
    && !isLikelyLegacyPromptTitle(currentTitle, firstUser)) return;

  let title = '';
  let showedSpinner = false;
  let updateSent = false;
  let fallbackTitle = chat.title;
  try {
    const mode = await resolveTitleMode(answerModelRef);
    if (mode === 'off') return;
    // AI-methodes duren even -> laat de UI een "bezig"-indicatie tonen.
    showedSpinner = mode === 'ollama';
    if (showedSpinner) win?.webContents.send('chat:titleGenerating', { chatId });
    try {
      if (mode === 'ollama') title = await titleViaOllama(firstUser, language);
      else if (mode === 'simple') title = simpleChatTitleFrom(firstUser);
    } catch { /* een latere retry na de hoofdbeurt krijgt nog een kans */ }
    title = sanitizeGeneratedChatTitle(title);
    if (mode === 'ollama' && !isUsableGeneratedChatTitle(title, firstUser)) {
      title = '';
    }
    if (!title || DEFAULT_CHAT_TITLES.has(title)) return;
    const current = getDb().prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string } | undefined;
    fallbackTitle = current?.title || fallbackTitle;
    // Een handmatige hernoeming tijdens een tragere Ollama-titel wint altijd.
    if (!current || (!DEFAULT_CHAT_TITLES.has((current.title || '').trim())
      && !isLikelyLegacyPromptTitle((current.title || '').trim(), firstUser))) return;
    getDb().prepare('UPDATE chats SET title = ?, updatedAt = ? WHERE id = ?').run(title, new Date().toISOString(), chatId);
    win?.webContents.send('chat:titleUpdated', { chatId, title });
    updateSent = true;
    notifyChatsChanged();
  } finally {
    // Ook bij een database-/rendererfout mag de sidebar nooit in shimmer blijven hangen.
    if (showedSpinner && !updateSent) {
      win?.webContents.send('chat:titleUpdated', { chatId, title: fallbackTitle });
    }
  }
}

function generateChatTitleIfNeeded(
  win: BrowserWindow | null,
  chatId: string,
  firstUserText?: string,
  answerModelRef?: ModelRef,
  language?: UiLanguage,
): Promise<void> {
  const existing = titleGenerationInFlight.get(chatId);
  if (existing) return existing;

  const task = generateChatTitleAttempt(win, chatId, firstUserText, answerModelRef, language)
    .finally(() => {
      if (titleGenerationInFlight.get(chatId) === task) titleGenerationInFlight.delete(chatId);
    });
  titleGenerationInFlight.set(chatId, task);
  return task;
}

async function retryChatTitleAfterTurn(
  win: BrowserWindow | null,
  chatId: string,
  firstUserText?: string,
  language?: UiLanguage,
) {
  const pending = titleGenerationInFlight.get(chatId);
  if (pending) await pending.catch(() => undefined);
  await generateChatTitleIfNeeded(win, chatId, firstUserText, undefined, language);
}

function isClaudeCliModelRef(modelRef: ModelRef) {
  return modelRef.provider === 'anthropic' && modelRef.modelId.startsWith('claude-cli:');
}

// Modellen die hun eigen tools native draaien (in de projectmap, met per-actie-popup):
// Claude, Codex, Antigravity en tool-capabele Gemini-/Ollama-modellen gebruiken
// hetzelfde segment/turn-model in de UI; alleen hun providerprotocol verschilt.
function isNativeToolModel(modelRef: ModelRef) {
  if (isClaudeCliModelRef(modelRef) || modelRef.provider === 'codex' || modelRef.provider === 'antigravity') return true;
  // Googles models.list publiceert function-calling-capabilities niet betrouwbaar.
  // Bij ingeschakelde PC-toegang is de echte generateContent-call daarom de live
  // capabilitycheck; een niet-ondersteund model geeft een providerfout zonder tools uit te voeren.
  if (modelRef.provider === 'google') {
    return cachedModels.some((model) => model.provider === 'google' && model.id === modelRef.modelId);
  }
  if (modelRef.provider === 'ollama') {
    return cachedModels.some((model) => model.provider === modelRef.provider && model.id === modelRef.modelId && model.supportsTools === true);
  }
  return false;
}

function assertRendererSettingKey(key: string) {
  if (!RENDERER_SETTING_KEYS.has(String(key || ''))) throw new Error(`Instelling is niet beschikbaar voor de renderer: ${key}`);
}

async function resolvedUiLanguage(explicit?: unknown): Promise<UiLanguage> {
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return normalizeUiLanguage(explicit);
  }
  const store = await getStore();
  return normalizeUiLanguage(store.get('ui.language'), 'nl');
}

async function sendUserMessageAndRunAssistant(win: BrowserWindow | null, request: ChatRequest) {
  const chat = requireChat(request.chatId);
  const language = await resolvedUiLanguage(request.language);
  const requestedModelRef = normalizeModelRef(request.modelRef);
  const now = new Date().toISOString();
  const attachmentRows = getAttachments(request.attachmentIds || [], request.chatId);
  const userMessage: Message = {
    id: crypto.randomUUID(),
    chatId: request.chatId,
    role: 'user',
    content: request.input.trim(),
    modelId: requestedModelRef.modelId,
    provider: requestedModelRef.provider,
    inputTokens: 0,
    outputTokens: 0,
    fallbackFrom: null,
    attachments: attachmentRows.length ? JSON.stringify(messageAttachmentRefs(attachmentRows)) : null,
    runConfig: serializeRunConfig(requestedModelRef.runConfig),
    createdAt: now,
  };

  insertMessage(userMessage);
  // Start meteen naast de eerste providerbeurt. Bij ChatGPT gebruikt automatisch
  // Ollama indien beschikbaar, zodat de ene websessielaan het antwoord niet ophoudt.
  void generateChatTitleIfNeeded(win, request.chatId, userMessage.content, requestedModelRef, language).catch(() => { });
  if (attachmentRows.length) {
    for (const attachment of attachmentRows) {
      getDb().prepare('UPDATE attachments SET chatId = ?, messageId = ? WHERE id = ?').run(request.chatId, userMessage.id, attachment.id);
    }
  }

  sendStreamEvent(win, {
    requestId: request.requestId,
    type: 'message_saved',
    message: userMessage,
  });
  sendStreamEvent(win, {
    requestId: request.requestId,
    type: 'status',
    status: attachmentRows.length
      ? localizedText(
        language,
        `${attachmentRows.length} bijlage${attachmentRows.length === 1 ? '' : 'n'} verwerkt`,
        `${attachmentRows.length} attachment${attachmentRows.length === 1 ? '' : 's'} processed`,
      )
      : localizedText(language, 'Bericht ontvangen', 'Message received'),
  });

  // Deterministic command router: if the user EXPLICITLY asked to run a command on
  // their PC ("/run …", "run … op mijn pc"), execute it directly via the agent —
  // regardless of which model is selected (so it works even if ChatGPT refuses).
  const agentCfg = await getAgentConfig(chat);
  // Native providers doen hun eigen toolplanning; laat ze "run het nog eens" zelf afhandelen.
  // De directe-commando-router (die "run …" letterlijk als shell-commando draait) moet dan UIT,
  // anders kaapt die het bericht vóórdat Claude het ziet.
  const routerNative = agentCfg.toolsEnabled && isNativeToolModel(requestedModelRef);
  const directCmd = agentCfg.toolsEnabled && !routerNative ? detectDirectCommandSpec(request.input) : null;
  if (directCmd) {
    agentLog('direct-command', { command: directCmd.command, shell: directCmd.shell || agentCfg.defaultShell, mode: agentCfg.mode });
    const toolContext: AgentToolRunContext = {
      chatId: request.chatId,
      requestId: request.requestId,
      anchorMessageId: userMessage.id,
      agentMode: agentCfg.mode,
      language,
    };
    const res = await runAgentCommand(win, directCmd.command, {
      cwd: await getEffectiveProjectPath(chat),
      shell: directCmd.shell,
      source: 'direct',
      anchorMessageId: userMessage.id,
      callbacks: createToolRunCallbacks(win, toolContext),
      toolContext,
    });
    const body = res.denied
      ? localizedText(language, '[geweigerd door gebruiker]', '[denied by user]')
      : [res.stdout, res.stderr].filter(Boolean).join('\n') || `[exit ${res.code}]`;
    const shownCommand = res.run?.command || directCmd.command;
    const toolMessage: Message = {
      id: crypto.randomUUID(),
      chatId: request.chatId,
      role: 'user',
      content: `Tool output:\n\n$ ${shownCommand}\n${body}`,
      modelId: null,
      provider: null,
      inputTokens: 0,
      outputTokens: 0,
      fallbackFrom: null,
      attachments: null,
      runConfig: null,
      toolRun: res.run ? JSON.stringify(res.run) : null,
      createdAt: new Date().toISOString(),
    };
    insertMessage(toolMessage);
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextWindowSize: 0, contextUsedPercent: 0 };
    sendStreamEvent(win, { requestId: request.requestId, type: 'message_saved', message: toolMessage });
    sendStreamEvent(win, { requestId: request.requestId, type: 'done', message: toolMessage, usage });
    return { ok: true, userMessage, assistantMessage: toolMessage };
  }

  const assistantMessage = await runAssistantForExistingChat(win, {
    requestId: request.requestId,
    chat,
    modelRef: requestedModelRef,
    explicitSystemPrompt: request.systemPrompt,
    language,
  });

  return { ok: true, userMessage, assistantMessage };
}

async function runAssistantForExistingChat(
  win: BrowserWindow | null,
  options: {
    requestId: string;
    chat: Chat;
    modelRef: ModelRef;
    explicitSystemPrompt?: string;
    language: UiLanguage;
  },
) {
  const controller = new AbortController();
  activeRequests.set(options.requestId, controller);

  try {
    const assembled = await assemblePromptContext(options.chat, options.explicitSystemPrompt);
    const attachmentRows = getLatestUserAttachments(options.chat.id);
    const messages = getChatMessages(options.chat.id);
    const agent = await getAgentConfig(options.chat);
    // Native providers draaien hun tools via hun eigen protocol of via app-side function calls. Dan gebruiken we
    // NIET het tag-toolsysteem (geen instructies, geen intent-guard, geen tag-loop achteraf) —
    // Elke provider vraagt per tool goedkeuring via dezelfde bestaande popup.
    const nativeToolCapable = isNativeToolModel(options.modelRef);
    const latestUserInput = latestUserToolRequest(messages);
    const nativeToolIntent = shouldStartNativeToolTurn({
      toolsEnabled: agent.toolsEnabled,
      modelToolCapable: nativeToolCapable,
      userInput: latestUserInput,
      recentMessages: messages,
    });
    // Native function declarations worden alleen meegestuurd als de vraag echt een
    // lokale bestands- of commandoactie verlangt. Zo kan een tool-capabel lokaal
    // model normale vragen nooit omzetten in echo/read_file-rondes.
    const nativeCommandTurn = options.modelRef.provider === 'codex'
      && !!options.modelRef.runConfig?.nativeProviderCommand;
    const nativeTurn = nativeToolIntent || nativeCommandTurn;
    const tagToolModel = shouldUseTagToolProtocol({
      toolsEnabled: agent.toolsEnabled,
      modelToolCapable: nativeToolCapable,
    });
    const commandEnvironment = nativeTurn
      ? agentToolEnvironmentInstructions(agent.defaultShell, process.platform, options.language)
      : '';
    const systemPrompt = options.modelRef.provider === 'codex'
      ? assembled.systemPrompt
      : tagToolModel
      ? `${assembled.systemPrompt || ''}\n${agentToolInstructions(options.language)}\n${nativeToolResponseInstructions(options.language)}\n${commandEnvironment}`
      : nativeTurn
        ? `${assembled.systemPrompt || ''}\n${nativeToolResponseInstructions(options.language)}\n${commandEnvironment}`
        : assembled.systemPrompt;
    const guardToolIntent = tagToolModel
      && options.modelRef.provider !== 'codex'
      && detectToolIntentRequest(latestUserInput, messages);
    if (guardToolIntent) {
      sendStreamEvent(win, { requestId: options.requestId, type: 'status', status: localizedText(options.language, 'Model plant toolstappen', 'Model is planning tool steps') });
    }

    // Gedeelde approval-brug voor tools van native providers.
    // Codex App Server heeft ook voor gewone chatbeurten een vaste cwd nodig om
    // dezelfde native thread (en dus goal/review/mode) te hervatten.
    const nativeProjectPath = nativeTurn || options.modelRef.provider === 'codex'
      ? await getEffectiveProjectPath(options.chat)
      : undefined;
    const approvedNativeSnapshots = new Map<string, string | null | undefined>();
    const nativeToolContext: AgentToolRunContext | undefined = nativeTurn
      ? { chatId: options.chat.id, requestId: options.requestId, agentMode: agent.mode, language: options.language }
      : undefined;
    const requestPermission = nativeTurn && nativeProjectPath
      ? async (toolName: string, input: Record<string, unknown>) => {
        const desc = describeNativeTool(toolName, input, options.language);
        // silent: de popup + modus-logica blijven, maar GEEN activiteit-feed — die zou
        // (zonder vast anker) aan een vorige commando-groep plakken en 'm laten re-highlighten.
        const approved = await requestAgentApproval(win, desc.command, nativeProjectPath, {
          kind: desc.kind,
          label: `${toolName}: ${desc.label}`,
          path: desc.path,
          paths: desc.paths,
          context: nativeToolContext,
          silent: true,
        });
        if (approved && (desc.kind === 'file-create' || desc.kind === 'file-edit')) {
          for (const requestedPath of desc.paths?.length ? desc.paths : desc.path ? [desc.path] : []) {
            rememberApprovedNativeSnapshot(approvedNativeSnapshots, nativeProjectPath, requestedPath);
          }
        }
        return { allow: approved, message: approved ? undefined : localizedText(options.language, 'Geweigerd door gebruiker.', 'Denied by the user.') };
      }
      : undefined;
    // ── Native providers: chronologische, geïnterleavede beurt ──────────────────
    // Een beurt is een REEKS segmenten in de echte volgorde: tekst → tool → tekst → …
    // Elk tekst-segment is een assistent-bericht; elke tool hangt aan het tekst-segment
    // dat eraan voorafgaat. Zo staat een samenvatting ná een run ook echt eronder, en
    // narratie vóór een run erboven. De frontend groepeert de segmenten tot één beurt.
    const nativeModelId = options.modelRef.modelId;
    const nativeProvider = options.modelRef.provider;
    const nativeRunConfigStr = serializeRunConfig(options.modelRef.runConfig);
    let segSeq = 0;
    const segBase = Date.now();
    const nextSegTs = () => new Date(segBase + segSeq++).toISOString();
    const nativeAnchorId = crypto.randomUUID();
    const nativeAnchorCreatedAt = nextSegTs();
    const nativeIntentText = localizedText(options.language, 'Ik voer de gevraagde toolstappen uit.', 'I am carrying out the requested tool steps.');
    const nativeTextSegments = [''];
    let nativeToolSeen = false;
    let nativeAnchorStarted = false;
    let pendingFinalSegment = false;
    const nativeRuns = new Map<string, {
      command: string;
      output: string;
      ok: boolean;
      denied: boolean;
      anchorId: string | null;
      startedAt: string;
      createdAt: string;
      toolName: string;
      toolKind?: CommandRun['toolKind'];
      toolPath?: string | null;
      beforeContent?: string | null;
    }>();
    const startNativeAnchor = () => {
      if (nativeAnchorStarted) return;
      nativeAnchorStarted = true;
      sendStreamEvent(win, {
        requestId: options.requestId,
        type: 'assistant_start',
        chatId: options.chat.id,
        message: {
          id: nativeAnchorId, chatId: options.chat.id, role: 'assistant', content: nativeIntentText,
          modelId: nativeModelId, provider: nativeProvider, inputTokens: 0, outputTokens: 0,
          fallbackFrom: null, attachments: null, runConfig: nativeRunConfigStr, createdAt: nativeAnchorCreatedAt,
        },
      });
    };

    // Leeg leidend segment = anker + avatar/kop van de beurt, ook als de provider eerst een
    // tool draait vóór 'ie iets zegt.
    const onNativeDelta = (delta: string) => {
      if (pendingFinalSegment) {
        nativeTextSegments.push('');
        pendingFinalSegment = false;
      }
      nativeTextSegments[nativeTextSegments.length - 1] += delta;
    };

    // ÁLLE tools (Bash/PowerShell én file-ops Write/Edit/Read/Glob/Grep/…) live via het
    // tool_run-kanaal (stabiele run.id → geen geflikker), verankerd aan het tekst-segment
    // ervoor. Na elke tool splitst de tekst in een nieuw segment (chronologisch). Ook bewaard
    // voor persistente kaarten na de beurt.
    const onNativeToolActivity = nativeTurn && nativeProjectPath
      ? (activity: NativeToolActivity) => {
        if (!activity.toolUseId) return;
        const runId = `${activity.provider}-${activity.toolUseId}`;
        const isShell = ['bash', 'powershell', 'run_command', 'run_shell_command', 'command'].includes(activity.toolName.toLowerCase());
        const target = nativeToolTarget(activity.input);
        const toolMeta = nativeToolRunMeta(activity.toolName, activity.input);
        const command = isShell
          ? (typeof activity.input.command === 'string' ? activity.input.command : activity.toolName)
          : (target ? `${activity.toolName} ${target}` : activity.toolName);
        const nowIso = new Date().toISOString();
        if (activity.phase === 'requested') {
          nativeToolSeen = true;
          startNativeAnchor();
          // In ask komt de snapshot uitsluitend uit de zojuist afgeronde approval.
          // Auto/full mag de vóór-toestand bij toolstart direct lezen.
          const beforeContent = toolMeta.toolKind?.startsWith('file-') && toolMeta.toolPath
            ? (agent.mode === 'ask'
              ? takeApprovedNativeSnapshot(approvedNativeSnapshots, nativeProjectPath, toolMeta.toolPath)
              : nativeFileSnapshot(nativeProjectPath, toolMeta.toolPath))
            : undefined;
          nativeRuns.set(runId, {
            command, output: '', ok: false, denied: false, anchorId: nativeAnchorId,
            startedAt: nowIso, createdAt: nextSegTs(), toolName: activity.toolName, ...toolMeta, beforeContent,
          });
          const run: CommandRun = {
            id: runId, source: 'model', command, shell: agent.defaultShell, cwd: nativeProjectPath,
            status: 'running', stdout: '', stderr: '', exitCode: null,
            startedAt: nowIso, endedAt: null, durationMs: null, anchorMessageId: nativeAnchorId,
            toolName: activity.toolName, ...toolMeta,
          };
          sendStreamEvent(win, { requestId: options.requestId, type: 'tool_run_started', chatId: options.chat.id, run, anchorMessageId: nativeAnchorId });
        } else if (activity.phase === 'approved') {
          const prev = nativeRuns.get(runId);
          if (prev?.toolKind?.startsWith('file-') && prev.toolPath) {
            const snapshotKey = nativeSnapshotKey(nativeProjectPath, prev.toolPath);
            const beforeContent = snapshotKey && approvedNativeSnapshots.has(snapshotKey)
              ? takeApprovedNativeSnapshot(approvedNativeSnapshots, nativeProjectPath, prev.toolPath)
              : nativeFileSnapshot(nativeProjectPath, prev.toolPath);
            nativeRuns.set(runId, {
              ...prev,
              beforeContent,
            });
          }
        } else if (activity.phase === 'result' || activity.phase === 'denied') {
          const prev = nativeRuns.get(runId);
          const startedAt = prev?.startedAt || nowIso;
          const anchorId = prev?.anchorId ?? nativeAnchorId;
          const cmd = prev?.command || command;
          let output = activity.output || activity.detail || (activity.phase === 'denied' ? localizedText(options.language, 'Geweigerd door gebruiker.', 'Denied by the user.') : '');
          const ok = activity.phase === 'result' && !!activity.ok;
          const finalToolName = prev?.toolName || activity.toolName;
          let finalToolMeta = prev
            ? { toolKind: prev.toolKind, toolPath: prev.toolPath }
            : toolMeta;
          if (ok && prev?.toolKind?.startsWith('file-') && prev.toolPath) {
            const afterContent = nativeFileSnapshot(nativeProjectPath, prev.toolPath);
            const review = nativeFileReviewOutput(nativeProjectPath, prev.toolKind, prev.toolPath, prev.beforeContent, afterContent, options.language);
            if (review) {
              output = review.output;
              finalToolMeta = { toolKind: review.kind, toolPath: review.path };
            }
          }
          nativeRuns.set(runId, {
            command: cmd, output, ok, denied: activity.phase === 'denied', anchorId, startedAt,
            createdAt: prev?.createdAt || nextSegTs(), toolName: finalToolName, ...finalToolMeta,
            beforeContent: prev?.beforeContent,
          });
          const run: CommandRun = {
            id: runId, source: 'model', command: cmd, shell: agent.defaultShell, cwd: nativeProjectPath,
            status: ok ? 'completed' : activity.phase === 'denied' ? 'denied' : 'failed', stdout: output, stderr: '', exitCode: ok ? 0 : 1,
            startedAt, endedAt: nowIso, durationMs: Math.max(0, Date.parse(nowIso) - Date.parse(startedAt)), anchorMessageId: anchorId,
            toolName: finalToolName, ...finalToolMeta,
          };
          sendStreamEvent(win, { requestId: options.requestId, type: 'tool_run_finished', chatId: options.chat.id, run, anchorMessageId: anchorId || undefined });
          pendingFinalSegment = true;
        }
      }
      : undefined;

    // Gemini en Ollama hebben native function calls, maar geen eigen app-runtime.
    // Deze callback voert zo'n call uit via exact dezelfde gevalideerde app-tools en
    // approval-instellingen als de bestaande tag-laag.
    const executeNativeTool = nativeTurn && nativeProjectPath
      ? async (toolName: string, input: Record<string, unknown>, toolUseId?: string) => {
        try {
          const call = nativeToolCallFrom(toolName, input, options.language);
          const result = await executeAgentToolCall(win, call, nativeProjectPath, {
            ...nativeToolContext!,
            silentApproval: true,
            onFileMutationApproved: (approvedCall, root) => {
              if (!toolUseId) return;
              const runId = `${nativeProvider}-${toolUseId}`;
              const prev = nativeRuns.get(runId);
              if (!prev) return;
              nativeRuns.set(runId, {
                ...prev,
                beforeContent: nativeFileSnapshot(root, approvedCall.path),
              });
            },
          });
          const denied = result.run?.status === 'denied' || /\[(?:geweigerd|denied)/i.test(result.text);
          const failed = result.run?.status === 'failed' || /\[(?:error|invalid|geen wijziging|no change)/i.test(result.text);
          return { ok: !denied && !failed, output: result.text, denied };
        } catch (error) {
          return { ok: false, output: error instanceof Error ? error.message : String(error) };
        }
      }
      : undefined;

    const result = await executeWithFallback(win, {
      requestId: options.requestId,
      chatId: options.chat.id,
      initialModelRef: options.modelRef,
      messages,
      systemPrompt,
      attachments: attachmentRows,
      signal: controller.signal,
      suppressDeltas: guardToolIntent,
      cwd: nativeProjectPath,
      agentMode: agent.mode,
      nativeTools: nativeTurn,
      requireToolUse: nativeToolIntent,
      requestPermission,
      executeTool: executeNativeTool,
      onToolActivity: onNativeToolActivity,
      onNativeDelta: nativeTurn ? onNativeDelta : undefined,
      language: options.language,
    });

    let finalResult = result;
    let finalReply = result.text;
    const firstToolCalls = parseAgentToolCalls(finalReply, { includeShellFences: false });
    const shouldRepair = guardToolIntent && needsToolComplianceRepair({
      userInput: latestUserInput,
      reply: finalReply,
      toolCalls: firstToolCalls,
      recentMessages: messages,
    });

    if (shouldRepair) {
      agentLog('toolCompliance', { event: 'repair-start', model: `${result.modelRef.provider}:${result.modelRef.modelId}`, replyHead: finalReply.slice(0, 180) });
      sendStreamEvent(win, { requestId: options.requestId, type: 'status', status: localizedText(options.language, 'Model maakt een echte tool-opdracht...', 'Model is creating a real tool request...') });
      const complianceContext: AgentToolRunContext = {
        chatId: options.chat.id,
        requestId: options.requestId,
        attempt: 1,
        agentMode: agent.mode,
        language: options.language,
      };
      const complianceActivityId = `${options.requestId}-tool-compliance`;
      sendToolActivity(win, complianceContext, {
        activityId: complianceActivityId,
        phase: 'planning',
        label: localizedText(options.language, 'Model maakt een echte tool-opdracht', 'Model is creating a real tool request'),
        detail: localizedText(options.language, 'Het eerste antwoord was gewone tekst; de app vraagt nu strict file/command-tags.', 'The first answer was ordinary text; the app is now requesting strict file/command tags.'),
        tone: 'running',
      });
      try {
        const repairPrompt = buildToolRepairPrompt({ userInput: latestUserInput, badReply: finalReply }, options.language);
        const repairResult = await executeWithFallback(win, {
          requestId: options.requestId,
          chatId: options.chat.id,
          initialModelRef: result.modelRef,
          messages: [
            ...messages,
            { role: 'assistant', content: finalReply },
            { role: 'user', content: repairPrompt },
          ],
          systemPrompt,
          attachments: [],
          signal: controller.signal,
          suppressDeltas: true,
          language: options.language,
        });
        const repairTools = parseAgentToolCalls(repairResult.text, { includeShellFences: false });
        if (isNoToolsReply(repairResult.text) || !repairTools.length) {
          agentLog('toolCompliance', { event: 'repair-no-tools', replyHead: repairResult.text.slice(0, 180) });
          sendToolActivity(win, complianceContext, {
            activityId: complianceActivityId,
            phase: 'stopped',
            label: localizedText(options.language, 'Model gaf geen tool-opdracht', 'Model did not provide a tool request'),
            detail: localizedText(options.language, 'De herstelpoging bevatte geen geldige file/command-tags.', 'The repair attempt did not contain valid file/command tags.'),
            tone: 'failed',
          });
          return finishAssistantErrorTurn(win, options, result.modelRef, localizedText(options.language, 'Uitvoering kon niet worden gestart: het model gaf geen geldige tool-opdracht.', 'Execution could not be started: the model did not provide a valid tool request.'));
        }
        finalReply = repairResult.text;
        finalResult = {
          ...repairResult,
          usage: sumUsage(result.usage, repairResult.usage),
          fallbackFrom: result.fallbackFrom || repairResult.fallbackFrom,
        };
        agentLog('toolCompliance', { event: 'repair-ok', toolCallsDetected: repairTools.length });
        sendToolActivity(win, complianceContext, {
          activityId: complianceActivityId,
          phase: 'done',
          label: localizedText(options.language, 'Tool-opdracht ontvangen', 'Tool request received'),
          detail: localizedText(options.language, `${repairTools.length} geldige toolactie(s) gevonden.`, `${repairTools.length} valid tool action(s) found.`),
          tone: 'ok',
        });
      } catch (error) {
        const classified = classifyProviderError(error, options.language);
        agentLog('toolCompliance', { event: 'repair-error', message: classified.message });
        sendToolActivity(win, complianceContext, {
          activityId: complianceActivityId,
          phase: 'stopped',
          label: localizedText(options.language, 'Modelherstel mislukt', 'Model repair failed'),
          detail: classified.message,
          tone: 'failed',
        });
        return finishAssistantErrorTurn(win, options, result.modelRef, localizedText(options.language, `Uitvoering kon niet worden gestart: ${classified.message}`, `Execution could not be started: ${classified.message}`));
      }
    }

    // ── Native providers: persist de chronologische segment-beurt ───────────────────
    // Elk tekst-segment → assistent-bericht; elke tool → tool-output-bericht met dezelfde
    // run.id (zodat de live-kaart naadloos vervangen wordt) en verankerd aan het segment
    // ervoor. De frontend groepeert alles tot één beurt.
    if (nativeTurn) {
      const finalSegment = nativeToolSeen
        ? compactToolSummaryForDisplay(finalNativeAssistantText(nativeTextSegments, finalReply), 1_800, options.language)
        : finalNativeAssistantText(nativeTextSegments, finalReply);
      const anchorMessage: Message | null = nativeToolSeen ? {
        id: nativeAnchorId,
        chatId: options.chat.id,
        role: 'assistant',
        content: nativeIntentText,
        modelId: finalResult.modelRef.modelId,
        provider: finalResult.modelRef.provider,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: finalResult.fallbackFrom,
        attachments: null,
        runConfig: serializeRunConfig(finalResult.modelRef.runConfig),
        createdAt: nativeAnchorCreatedAt,
      } : null;
      if (anchorMessage) {
        insertMessage(anchorMessage);
        sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: anchorMessage });
      }
      for (const [runId, data] of nativeRuns) {
        const run: CommandRun = {
          id: runId,
          source: 'model',
          command: data.command,
          shell: agent.defaultShell,
          cwd: nativeProjectPath!,
          status: data.ok ? 'completed' : data.denied ? 'denied' : 'failed',
          stdout: data.output,
          stderr: '',
          exitCode: data.ok ? 0 : 1,
          startedAt: data.startedAt,
          endedAt: data.createdAt,
          durationMs: Math.max(0, Date.parse(data.createdAt) - Date.parse(data.startedAt)),
          anchorMessageId: data.anchorId,
          toolName: data.toolName,
          toolKind: data.toolKind,
          toolPath: data.toolPath,
        };
        const toolMessage: Message = {
          id: crypto.randomUUID(),
          chatId: options.chat.id,
          role: 'user',
          content: `Tool output:\n\n$ ${data.command}\n${data.output}`.slice(0, 20000),
          modelId: null,
          provider: null,
          inputTokens: 0,
          outputTokens: 0,
          fallbackFrom: null,
          attachments: null,
          runConfig: null,
          toolRun: JSON.stringify(run),
          createdAt: data.createdAt,
        };
        insertMessage(toolMessage);
        sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: toolMessage });
      }
      const finalMessage: Message = {
        id: crypto.randomUUID(),
        chatId: options.chat.id,
        role: 'assistant',
        content: finalSegment,
        modelId: finalResult.modelRef.modelId,
        provider: finalResult.modelRef.provider,
        inputTokens: finalResult.usage.inputTokens,
        outputTokens: finalResult.usage.outputTokens,
        fallbackFrom: finalResult.fallbackFrom,
        attachments: null,
        runConfig: serializeRunConfig(finalResult.modelRef.runConfig),
        createdAt: nextSegTs(),
      };
      insertMessage(finalMessage);
      sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: finalMessage });
      recordUsage(options.chat.id, finalMessage.id, finalResult.modelRef, finalResult.usage);
      sendUsageUpdate(win, options.chat.id);
      if (finalResult.rateLimit) recordRateLimit(finalResult.rateLimit);
      updateChat(options.chat.id, {
        activeModelId: finalResult.modelRef.modelId,
        activeProvider: finalResult.modelRef.provider,
        activeRunConfig: finalResult.modelRef.runConfig || null,
      });
      sendStreamEvent(win, { requestId: options.requestId, type: 'usage', usage: finalResult.usage });
      sendStreamEvent(win, { requestId: options.requestId, type: 'done', message: finalMessage, usage: finalResult.usage });
      return finalMessage;
    }

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      chatId: options.chat.id,
      role: 'assistant',
      content: assistantDisplayContentForToolReply(finalReply),
      modelId: finalResult.modelRef.modelId,
      provider: finalResult.modelRef.provider,
      inputTokens: finalResult.usage.inputTokens,
      outputTokens: finalResult.usage.outputTokens,
      fallbackFrom: finalResult.fallbackFrom,
      attachments: null,
      runConfig: serializeRunConfig(finalResult.modelRef.runConfig),
      createdAt: new Date().toISOString(),
    };

    insertMessage(assistantMessage);
    recordUsage(options.chat.id, assistantMessage.id, finalResult.modelRef, finalResult.usage);
    sendUsageUpdate(win, options.chat.id);
    if (finalResult.rateLimit) recordRateLimit(finalResult.rateLimit);
    updateChat(options.chat.id, {
      activeModelId: finalResult.modelRef.modelId,
      activeProvider: finalResult.modelRef.provider,
      activeRunConfig: finalResult.modelRef.runConfig || null,
    });

    sendStreamEvent(win, { requestId: options.requestId, type: 'usage', usage: finalResult.usage });
    sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: assistantMessage });

    if (tagToolModel) {
      await runAgentToolLoop(win, options.chat, finalResult.modelRef, finalReply, controller.signal, {
        requestId: options.requestId,
        anchorMessageId: assistantMessage.id,
      }, options.language);
    }

    // De beurt is pas klaar ná de tool-loop en eventuele resultaatcontrole/samenvatting. Een
    // eerder `done` laat de renderer de streamlistener sluiten en verbergt precies
    // de tijdelijke status "Model controleert resultaat".
    sendStreamEvent(win, { requestId: options.requestId, type: 'done', message: assistantMessage, usage: finalResult.usage });

    return assistantMessage;
  } catch (error) {
    const classified = classifyProviderError(error, options.language);
    const failedRef: ModelRef = (error as any)?.modelRef || options.modelRef;
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextWindowSize: 0,
      contextUsedPercent: 0,
    };
    if (!shouldPersistProviderFailure(classified.reason)) {
      sendStreamEvent(win, { requestId: options.requestId, type: 'done', usage });
      return {
        id: crypto.randomUUID(),
        chatId: options.chat.id,
        role: 'assistant' as const,
        content: '',
        modelId: failedRef.modelId,
        provider: failedRef.provider,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(failedRef.runConfig),
        createdAt: new Date().toISOString(),
      };
    }
    if (classified.rateLimit) recordRateLimit(classified.rateLimit);
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      chatId: options.chat.id,
      role: 'assistant',
      content: failedRef.provider === 'openai' && failedRef.modelId.startsWith('chatgpt:')
        ? classified.message
        : localizedText(options.language, `Providerfout (${classified.reason}): ${classified.message}`, `Provider error (${classified.reason}): ${classified.message}`),
      modelId: failedRef.modelId,
      provider: failedRef.provider,
      inputTokens: 0,
      outputTokens: 0,
      fallbackFrom: (error as any)?.fallbackFrom || null,
      attachments: null,
      runConfig: serializeRunConfig(failedRef.runConfig),
      createdAt: new Date().toISOString(),
    };

    insertMessage(assistantMessage);
    sendStreamEvent(win, {
      requestId: options.requestId,
      type: 'error',
      reason: classified.reason,
      error: classified.message,
    });
    sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: assistantMessage });
    sendStreamEvent(win, { requestId: options.requestId, type: 'done', message: assistantMessage, usage });
    return assistantMessage;
  } finally {
    activeRequests.delete(options.requestId);
  }
}

function latestUserToolRequest(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (message.content.startsWith('Tool output:') || message.content.startsWith('Command output:')) continue;
    return message.content;
  }
  return '';
}

function isNoToolsReply(reply: string) {
  return reply.trim().toUpperCase() === 'NO_TOOLS';
}

function sumUsage(first: TokenUsage, second: TokenUsage): TokenUsage {
  const contextWindowSize = Math.max(first.contextWindowSize || 0, second.contextWindowSize || 0);
  const totalTokens = (first.totalTokens || 0) + (second.totalTokens || 0);
  const cachedTokens = (first.cachedTokens || 0) + (second.cachedTokens || 0);
  const reasoningTokens = (first.reasoningTokens || 0) + (second.reasoningTokens || 0);
  return {
    inputTokens: (first.inputTokens || 0) + (second.inputTokens || 0),
    outputTokens: (first.outputTokens || 0) + (second.outputTokens || 0),
    totalTokens,
    contextWindowSize,
    contextUsedPercent: contextWindowSize ? Math.round((totalTokens / contextWindowSize) * 100) : 0,
    cachedTokens: cachedTokens || undefined,
    reasoningTokens: reasoningTokens || undefined,
    source: mergeUsageSources(first.source, second.source),
  };
}

function finishAssistantErrorTurn(
  win: BrowserWindow | null,
  options: {
    requestId: string;
    chat: Chat;
    modelRef: ModelRef;
    explicitSystemPrompt?: string;
  },
  modelRef: ModelRef,
  content: string,
) {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextWindowSize: 0,
    contextUsedPercent: 0,
  };
  const assistantMessage: Message = {
    id: crypto.randomUUID(),
    chatId: options.chat.id,
    role: 'assistant',
    content,
    modelId: modelRef.modelId,
    provider: modelRef.provider,
    inputTokens: 0,
    outputTokens: 0,
    fallbackFrom: null,
    attachments: null,
    runConfig: serializeRunConfig(modelRef.runConfig),
    createdAt: new Date().toISOString(),
  };

  insertMessage(assistantMessage);
  sendStreamEvent(win, { requestId: options.requestId, type: 'message_saved', message: assistantMessage });
  sendStreamEvent(win, { requestId: options.requestId, type: 'done', message: assistantMessage, usage });
  return assistantMessage;
}

async function executeWithFallback(
  win: BrowserWindow | null,
  options: {
    requestId: string;
    chatId?: string;
    initialModelRef: ModelRef;
    messages: ChatMessage[];
    systemPrompt?: string;
    attachments: AttachmentRecord[];
    signal: AbortSignal;
    suppressDeltas?: boolean;
    // Native CLI-tools (Claude Code): projectmap + modus + permissie-/activiteit-hooks.
    cwd?: string;
    agentMode?: AgentApprovalMode;
    nativeTools?: boolean;
    requireToolUse?: boolean;
    requestPermission?: (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }>;
    executeTool?: import('./native-tools').NativeToolExecutor;
    onToolActivity?: (activity: NativeToolActivity) => void;
    // Als gezet: de native provider beheert tekst-delta's als segment-berichten i.p.v.
    // de zwevende streaming-bubbel — zodat tekst en tools chronologisch interleaven.
    onNativeDelta?: (delta: string) => void;
    language: UiLanguage;
  },
) {
  const candidates = await fallbackCandidates(options.initialModelRef);
  const knownQuotas = getStoredQuotaSnapshots();
  void ensureRecentQuotaSnapshots().catch(() => []);
  let lastError: unknown;
  let fallbackFrom: string | null = null;
  let lastModelRef: ModelRef = options.initialModelRef;

  for (let index = 0; index < candidates.length; index++) {
    const modelRef = candidates[index];
    lastModelRef = modelRef;
    const blockingQuota = blockingQuotaForModel(modelRef, knownQuotas, fallbackLimitGroupKey(modelRef));
    if (blockingQuota) {
      const message = localizedText(
        options.language,
        `${blockingQuota.bucket.label} is opgebruikt${blockingQuota.bucket.resetAt ? ` tot ${blockingQuota.bucket.resetAt}` : ''}.`,
        `${blockingQuota.bucket.label} is exhausted${blockingQuota.bucket.resetAt ? ` until ${blockingQuota.bucket.resetAt}` : ''}.`,
      );
      lastError = new ProviderRuntimeError(message, 'rate_limit');
      if (index === candidates.length - 1) break;
      const next = candidates[index + 1];
      fallbackFrom = `${modelRef.provider}:${modelRef.modelId}`;
      emitFallbackSwitch(win, options.requestId, modelRef, next, 'rate_limit', message, true, options.language);
      continue;
    }
    try {
      assertProvider(modelRef.provider);
      const adapter = adapters[modelRef.provider];
      const preflight = await preflightModel(modelRef, options.language);
      if (!preflight.ok) {
        throw new ProviderRuntimeError(preflight.message, preflight.reason);
      }
      const prepared = prepareMessagesForContext(options.messages, options.systemPrompt, modelRef, options.language);
      const hydratedMessages = await hydrateMessageAttachments(prepared.messages);
      const targetModel = cachedModels.find((model) => model.provider === modelRef.provider && model.id === modelRef.modelId);
      const droppedAttachments = options.attachments.filter((attachment) => (
        attachment.kind === 'image' ? targetModel?.supportsVision === false : attachment.kind === 'binary'
      ));
      const acceptedAttachments = options.attachments.filter((attachment) => !droppedAttachments.includes(attachment));
      const hydratedAttachments = await hydrateAttachments(acceptedAttachments);
      const nativeCapabilitiesAvailable = !options.nativeTools || isNativeToolModel(modelRef);
      const fallbackWarning = [
        droppedAttachments.length ? localizedText(
          options.language,
          `${droppedAttachments.length} niet-ondersteunde bijlage(n) zijn niet naar dit fallbackmodel gestuurd.`,
          `${droppedAttachments.length} unsupported attachment(s) were not sent to this fallback model.`,
        ) : '',
        !nativeCapabilitiesAvailable ? localizedText(
          options.language,
          'Dit fallbackmodel heeft geen native lokale tools; voer geen bestands- of commandoacties voor alsof ze gelukt zijn.',
          'This fallback model has no native local tools; do not claim file or command actions succeeded.',
        ) : '',
      ].filter(Boolean).join(' ');
      const resumeInstructions = index > 0 ? executionLedgerResumePrompt(options.requestId, options.language) : '';
      if (fallbackWarning) sendStreamEvent(win, { requestId: options.requestId, type: 'status', status: fallbackWarning });
      if (prepared.omitted > 0) {
        sendStreamEvent(win, {
          requestId: options.requestId,
          type: 'status',
          status: localizedText(options.language, `${prepared.omitted} oudere berichten buiten de context gelaten.`, `${prepared.omitted} older messages omitted from the context.`),
        });
      }
      const result = await adapter.sendChat({
        chatId: options.chatId,
        modelRef,
        messages: hydratedMessages,
        systemPrompt: appendRuntimeMetadata(
          [options.systemPrompt, fallbackWarning, resumeInstructions].filter(Boolean).join('\n\n'),
          modelRef,
          options.language,
        ),
        attachments: hydratedAttachments,
        signal: options.signal,
        onDelta: (delta) => {
          if (options.suppressDeltas) return;
          if (options.onNativeDelta) {
            options.onNativeDelta(delta);
          } else {
            sendStreamEvent(win, { requestId: options.requestId, type: 'delta', delta });
          }
        },
        onStatus: (status) => {
          sendStreamEvent(win, { requestId: options.requestId, type: 'status', status });
        },
        cwd: options.cwd,
        agentMode: options.agentMode,
        nativeTools: options.nativeTools && nativeCapabilitiesAvailable,
        requireToolUse: options.requireToolUse && nativeCapabilitiesAvailable,
        requestPermission: options.requestPermission
          ? async (toolName, input) => {
            const duplicate = duplicateTurnAction(options.requestId, toolName, input, options.cwd);
            if (duplicate?.status === 'completed') return { allow: false, message: localizedText(options.language, 'Deze exacte actie is in deze beurt al voltooid en wordt niet opnieuw uitgevoerd.', 'This exact action already completed during this turn and will not be run again.') };
            if (duplicate?.status === 'uncertain') return { allow: false, message: localizedText(options.language, 'De uitkomst van deze exacte actie is onzeker. Controleer de toestand eerst met een leesactie.', 'The outcome of this exact action is uncertain. Check the current state with a read action first.') };
            return options.requestPermission!(toolName, input);
          }
          : undefined,
        executeTool: options.executeTool
          ? async (toolName, input, toolUseId) => {
            const duplicate = duplicateTurnAction(options.requestId, toolName, input, options.cwd);
            if (duplicate?.status === 'completed') return { ok: false, denied: true, output: localizedText(options.language, 'Deze exacte actie is al voltooid; niet opnieuw uitgevoerd.', 'This exact action already completed; it was not run again.') };
            if (duplicate?.status === 'uncertain') return { ok: false, denied: true, output: localizedText(options.language, 'Onzekere eerdere actie; controleer de toestand eerst met read_file of een ander read-only commando.', 'Earlier action is uncertain; check the current state first with read_file or another read-only command.') };
            return options.executeTool!(toolName, input, toolUseId);
          }
          : undefined,
        onToolActivity: (activity) => {
          recordTurnExecutionActivity(options.requestId, activity, options.cwd);
          options.onToolActivity?.(activity);
        },
        language: options.language,
      });

      const resultModelRef = normalizeModelRef({
        ...modelRef,
        runConfig: result.runConfig || modelRef.runConfig,
      });

      return {
        ...result,
        modelRef: resultModelRef,
        fallbackFrom,
      };
    } catch (error) {
      markPendingTurnActionsUncertain(options.requestId, modelRef.provider);
      lastError = error;
      const classified = classifyProviderError(error, options.language);
      agentLog('fallback', { failedModel: `${modelRef.provider}:${modelRef.modelId}`, reason: classified.reason, message: (classified.message || '').slice(0, 400) });
      if (classified.rateLimit) recordRateLimit(classified.rateLimit);
      if (classified.reason === 'rate_limit') recordRuntimeQuotaFailure(modelRef, classified);
      const recoverableReasons: FallbackReason[] = ['rate_limit', 'context_exceeded', 'auth_failed', 'network'];
      if (!recoverableReasons.includes(classified.reason) || index === candidates.length - 1) break;

      const next = candidates[index + 1];
      fallbackFrom = `${modelRef.provider}:${modelRef.modelId}`;
      emitFallbackSwitch(win, options.requestId, modelRef, next, classified.reason, classified.message, false, options.language);
    }
  }

  // Attribute the failure to the model that actually ran last (the fallback
  // target), not the initial one — so the UI shows the right provider/branding.
  if (lastError && typeof lastError === 'object') {
    (lastError as any).modelRef = lastModelRef;
    (lastError as any).fallbackFrom = fallbackFrom;
  }
  throw lastError || new Error(localizedText(options.language, 'Geen providerkandidaat kon dit verzoek verwerken.', 'No provider candidate could handle this request.'));
}

async function fallbackCandidates(initial: ModelRef) {
  const config = await getFallbackConfig();
  const normalizedInitial = normalizeModelRef(initial);
  const candidates: ModelRef[] = [normalizedInitial];
  const seenLimitGroups = new Set([fallbackLimitGroupKey(normalizedInitial)]);
  if (!config.autoSwitchEnabled) return candidates;

  for (const item of config.order) {
    if (!item.enabled) continue;
    const ref = normalizeModelRef(item.modelRef);
    if (!ref?.provider || !ref.modelId) continue;
    if (ref.provider === normalizedInitial.provider && ref.modelId === normalizedInitial.modelId) continue;
    const groupKey = fallbackLimitGroupKey(ref);
    if (seenLimitGroups.has(groupKey)) continue;
    if (isPaidApiFallback(ref) && item.allowPaidApi !== true) continue;
    seenLimitGroups.add(groupKey);
    candidates.push(ref);
  }

  return candidates;
}

async function refreshModels(providerId?: ProviderType) {
  if (providerId) {
    assertProvider(providerId);
    adapters[providerId].invalidateModelCache?.();
    const models = await adapters[providerId].listModels();
    cachedModels = [
      ...cachedModels.filter((model) => model.provider !== providerId),
      ...models,
    ];
    return models;
  }

  const all: AIModel[] = [];
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      try {
        adapters[provider].invalidateModelCache?.();
        const models = await adapters[provider].listModels();
        all.push(...models);
      } catch {
        // Model discovery failure should not block other providers.
      }
    }),
  );
  cachedModels = all;
  return all;
}

async function listModels(providerId?: ProviderType) {
  if (providerId) {
    assertProvider(providerId);
    const models = await adapters[providerId].listModels();
    cachedModels = [
      ...cachedModels.filter((model) => model.provider !== providerId),
      ...models,
    ];
    return models;
  }
  if (!cachedModels.length) return refreshModels();
  return cachedModels;
}

async function listProviders() {
  const health = await getProviderHealth();
  return PROVIDERS.map((provider) => ({
    id: provider,
    name: provider,
    status: health[provider],
  }));
}

async function getProviderHealth() {
  const statuses = await getProviderCredentialStatuses();
  const entries = PROVIDERS.map((provider) => {
    if (!statuses[provider]?.authenticated) return [provider, 'offline'];
    if (!PROVIDER_STATUS[provider].canChat) return [provider, 'limited'];
    return [provider, 'online'];
  });
  return Object.fromEntries(entries);
}

async function getProviderCredentialStatuses(explicitLanguage?: UiLanguage): Promise<Record<ProviderType, CredentialStatus>> {
  const language = await resolvedUiLanguage(explicitLanguage);
  if (providerCredentialStatusesCache?.language === language && providerCredentialStatusesCache.expiresAt > Date.now()) {
    return providerCredentialStatusesCache.value;
  }
  if (providerCredentialStatusesInFlight?.language === language) return providerCredentialStatusesInFlight.promise;

  const request = (async () => {
    const base = await getCredentialStatuses();
    const store = await getStore();
    const [claudeExecutable, antigravityExecutable] = await Promise.all([
      findExecutablePath(claudeExecutableCandidates(store.get('claude.executable') as string | undefined)),
      findExecutablePath(antigravityExecutableCandidates(store.get('antigravity.executable') as string | undefined)),
    ]);
    // Statusregels zijn de officiële live-uitvoerlaag van deze CLI's. De bridge
    // bewaart en ketent een bestaande gebruikersstatusregel en slaat uitsluitend
    // quota/model/plan op, nooit e-mail of transcriptinhoud.
    if (claudeExecutable) await ensureStatuslineBridge('claude').catch(() => {});
    if (antigravityExecutable) await ensureStatuslineBridge('antigravity').catch(() => {});
    const entries = await Promise.all(PROVIDERS.map(async (provider) => {
      const meta = PROVIDER_STATUS[provider];
      const validation = await adapters[provider].validateCredential(undefined, { language }).catch((error: any) => ({
        id: crypto.randomUUID(),
        keyMasked: base[provider]?.label || localizedText(language, 'ontbreekt', 'missing'),
        provider,
        status: 'invalid' as const,
        error: error?.message || String(error),
      }));
      let valid = validation.status === 'valid';
      let quotaSetupError: string | undefined;
      if (provider === 'google' && valid) {
        const quotaStatus = await getGeminiQuotaAuthStatus(true, language);
        valid = quotaStatus.connected;
        quotaSetupError = quotaStatus.error;
      }
      const canChat = valid && meta.canChat;
      return [
        provider,
        {
          ...base[provider],
          provider,
          authenticated: valid,
          label: validation.keyMasked || base[provider]?.label,
          error: quotaSetupError || validation.error || base[provider]?.error,
          statusLabel: localizedText(language, valid ? meta.valid : meta.invalid, valid ? PROVIDER_STATUS_EN[provider].valid : PROVIDER_STATUS_EN[provider].invalid),
          category: meta.category,
          canChat,
        },
      ];
    }));
    const value = Object.fromEntries(entries) as Record<ProviderType, CredentialStatus>;
    providerCredentialStatusesCache = { language, expiresAt: Date.now() + 15_000, value };
    return value;
  })();

  providerCredentialStatusesInFlight = { language, promise: request };
  try {
    return await request;
  } finally {
    if (providerCredentialStatusesInFlight?.promise === request) {
      providerCredentialStatusesInFlight = null;
    }
  }
}

async function configuredCliCandidates(kind: InteractiveCliKind) {
  const store = await getStore();
  if (kind === 'codex') {
    return codexExecutableCandidates(store.get('codex.executable') as string | undefined);
  }
  if (kind === 'claude') {
    return claudeExecutableCandidates(store.get('claude.executable') as string | undefined);
  }
  return antigravityExecutableCandidates(store.get('antigravity.executable') as string | undefined);
}

type InteractiveCliOpenResult = {
  success: boolean;
  action?: 'open' | 'install';
  executablePath?: string;
  terminalProcessId?: number;
  message?: string;
  error?: string;
};

const interactiveCliSetupInFlight = new Map<
  InteractiveCliKind,
  Promise<InteractiveCliOpenResult>
>();

async function openOrInstallInteractiveCli(
  kind: InteractiveCliKind,
  win: BrowserWindow | null = null,
): Promise<InteractiveCliOpenResult> {
  const language = await resolvedUiLanguage();
  if (process.platform !== 'win32') {
    return {
      success: false,
      error: localizedText(
        language,
        'Automatisch installeren en openen wordt momenteel alleen op Windows ondersteund.',
        'Automatic installation and sign-in are currently supported on Windows only.',
      ),
    };
  }

  const active = interactiveCliSetupInFlight.get(kind);
  if (active) return active;

  const task = runInteractiveCliSetup(kind, win, language)
    .finally(() => {
      if (interactiveCliSetupInFlight.get(kind) === task) {
        interactiveCliSetupInFlight.delete(kind);
      }
    });
  interactiveCliSetupInFlight.set(kind, task);
  return task;
}

async function runInteractiveCliSetup(
  kind: InteractiveCliKind,
  win: BrowserWindow | null,
  language: UiLanguage,
): Promise<InteractiveCliOpenResult> {
  const name = interactiveCliName(kind);
  try {
    sendRuntimeSetupProgress(win, {
      runtime: kind,
      phase: 'checking',
      status: localizedText(language, `${name} controleren...`, `Checking ${name}...`),
    });

    let executable = await findExecutablePath(await configuredCliCandidates(kind));
    const installedNow = !executable;
    if (!executable) {
      sendRuntimeSetupProgress(win, {
        runtime: kind,
        phase: 'downloading',
        status: localizedText(language, `Officiële ${name}-installer ophalen...`, `Fetching the official ${name} installer...`),
      });
      await runSetupProcess('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', interactiveCliInstallPowerShell(kind, language),
      ], 30 * 60_000, (output) => {
        const parsed = parseInteractiveCliInstallerProgress(kind, output, language);
        if (!parsed) return;
        sendRuntimeSetupProgress(win, {
          runtime: kind,
          ...parsed,
        });
      });

      sendRuntimeSetupProgress(win, {
        runtime: kind,
        phase: 'checking',
        status: localizedText(language, `${name}-installatie controleren...`, `Verifying ${name} installation...`),
      });
      const deadline = Date.now() + 20_000;
      while (!executable && Date.now() < deadline) {
        executable = await findExecutablePath(await configuredCliCandidates(kind));
        if (!executable) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!executable) {
        throw new Error(
          localizedText(
            language,
            `${name} meldde dat de installatie klaar is, maar het uitvoerbare bestand is niet gevonden. Controleer de installeruitvoer en kies daarna “Controleer opnieuw”.`,
            `${name} reported a completed installation, but its executable was not found. Check the installer output, then choose “Check again”.`,
          ),
        );
      }
    }

    sendRuntimeSetupProgress(win, {
      runtime: kind,
      phase: 'configuring',
      status: localizedText(language, `${name}-loginvenster openen...`, `Opening ${name} sign-in window...`),
      percent: installedNow ? 100 : undefined,
    });
    const terminalProcessId = await openInteractiveCliLogin(kind, executable, ensureDefaultWorkspacePath(), language);
    sendRuntimeSetupProgress(win, {
      runtime: kind,
      phase: 'awaiting-login',
      status: localizedText(
        language,
        `${name}-loginvenster is geopend. Rond de login af en keer daarna terug naar LLMelt.`,
        `${name} sign-in window is open. Complete sign-in, then return to LLMelt.`,
      ),
    });

    return {
      success: true,
      action: installedNow ? 'install' : 'open',
      executablePath: executable,
      terminalProcessId,
      message: installedNow
        ? localizedText(language, `${name} is geïnstalleerd en geopend. Rond de login af in het terminalvenster.`, `${name} was installed and opened. Complete sign-in in the terminal window.`)
        : localizedText(language, `${name} is geopend. Rond de login af in het terminalvenster.`, `${name} is open. Complete sign-in in the terminal window.`),
    };
  } catch (error: any) {
    const detail = error?.message || String(error);
    const message = localizedText(
      language,
      `${name}-configuratie is mislukt (${detail})`,
      `${name} setup failed (${detail})`,
    );
    sendRuntimeSetupProgress(win, {
      runtime: kind,
      phase: 'error',
      status: message,
    });
    return { success: false, error: message };
  }
}

function openInteractiveCliLogin(
  kind: InteractiveCliKind,
  executablePath: string,
  workingDirectory: string,
  language: UiLanguage,
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', interactiveCliTerminalLauncherPowerShell(kind, executablePath, workingDirectory, language),
    ], {
      cwd: workingDirectory,
      windowsHide: true,
      env: agentCommandEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, processId?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(processId!);
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error(localizedText(
        language,
        `${interactiveCliName(kind)}-loginvenster kon niet binnen 15 seconden worden geopend.`,
        `${interactiveCliName(kind)} sign-in window could not be opened within 15 seconds.`,
      )));
    }, 15_000);

    child.stdout?.on('data', (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-8_000);
    });
    child.stderr?.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-8_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const marker = [...stdout.matchAll(/AI_SUPERAPP_LOGIN_PID\|(\d+)/g)].at(-1);
      const processId = Number(marker?.[1]);
      if (code !== 0 || !Number.isSafeInteger(processId) || processId <= 0) {
        finish(new Error(
          stderr.trim()
          || stdout.trim()
          || localizedText(
            language,
            `${interactiveCliName(kind)}-loginvenster kon niet worden geopend.`,
            `${interactiveCliName(kind)} sign-in window could not be opened.`,
          ),
        ));
        return;
      }
      finish(undefined, processId);
    });
  });
}

async function getProviderAccountStatuses(): Promise<ProviderAccountStatus[]> {
  const credentialStatuses = await getProviderCredentialStatuses();
  const chatGptDesktop = await detectChatGptDesktop();
  const antigravityState = await readAntigravityStatuslineState();
  const claudeCliStatus = await getClaudeCliRuntimeStatus();
  const codexExe = await findExecutablePath(await configuredCliCandidates('codex'));
  const antigravityExe = await findExecutablePath(await configuredCliCandidates('antigravity'));

  const statuses: ProviderAccountStatus[] = [
    {
      provider: 'chatgpt',
      displayName: 'ChatGPT desktop',
      surface: 'desktop',
      installed: !!chatGptDesktop,
      authenticated: false,
      executablePath: chatGptDesktop || undefined,
      statusLabel: chatGptDesktop ? 'Desktop gevonden; login/subscription niet uitleesbaar' : 'Desktop niet gevonden',
      statusSource: 'desktop',
      canChat: false,
      limitsKnown: false,
      error: chatGptDesktop ? undefined : 'ChatGPT desktop wordt alleen gedetecteerd; subscription-modellen komen via web-sessie.',
    },
    apiAccountStatus('openai', 'ChatGPT Subscription / OpenAI API', credentialStatuses.openai),
    apiAccountStatus('anthropic', 'Claude / Anthropic API', credentialStatuses.anthropic),
    {
      provider: 'claude-cli',
      displayName: 'Claude Code CLI',
      surface: 'cli',
      installed: claudeCliStatus.installed,
      authenticated: claudeCliStatus.authenticated,
      executablePath: claudeCliStatus.executablePath,
      statusLabel: claudeCliStatus.authenticated
        ? 'CLI gevonden en ingelogd'
        : claudeCliStatus.installed
          ? 'CLI gevonden; login nodig'
          : 'CLI niet gevonden',
      statusSource: 'cli',
      canChat: claudeCliStatus.authenticated,
      limitsKnown: false,
      error: claudeCliStatus.installed && !claudeCliStatus.authenticated
        ? 'Open Claude Code CLI en rond de accountlogin af.'
        : undefined,
    },
    apiAccountStatus('google', 'Gemini API', credentialStatuses.google),
    {
      provider: 'codex',
      displayName: 'Codex CLI',
      surface: 'cli',
      installed: !!codexExe,
      authenticated: !!credentialStatuses.codex?.authenticated,
      executablePath: codexExe || undefined,
      statusLabel: credentialStatuses.codex?.statusLabel || (codexExe ? 'CLI gevonden' : 'CLI auth nodig'),
      statusSource: 'cli',
      canChat: !!credentialStatuses.codex?.canChat,
      limitsKnown: false,
      error: credentialStatuses.codex?.error,
    },
    {
      provider: 'antigravity',
      displayName: 'Antigravity CLI',
      surface: 'cli',
      installed: !!antigravityExe,
      authenticated: !!antigravityState?.email || !!credentialStatuses.antigravity?.authenticated,
      accountLabel: antigravityState?.email,
      planTier: antigravityState?.plan_tier,
      executablePath: antigravityExe || undefined,
      statusLabel: antigravityState?.email
        ? `Ingelogd: ${antigravityState.email}`
        : credentialStatuses.antigravity?.statusLabel || (antigravityExe ? 'CLI gevonden; account onbekend' : 'CLI niet gevonden'),
      statusSource: antigravityState ? 'statusline' : 'cli',
      canChat: !!antigravityExe,
      limitsKnown: !!antigravityState?.context_window,
      error: credentialStatuses.antigravity?.error,
    },
    localAccountStatus('ollama', 'Ollama', credentialStatuses.ollama),
    {
      provider: 'remote',
      displayName: 'Remote SSH',
      surface: 'remote',
      installed: !!credentialStatuses.remote?.authenticated,
      authenticated: !!credentialStatuses.remote?.authenticated,
      statusLabel: credentialStatuses.remote?.statusLabel || 'SSH niet ingesteld',
      statusSource: 'config',
      canChat: !!credentialStatuses.remote?.canChat,
      limitsKnown: false,
      error: credentialStatuses.remote?.error,
    },
  ];

  return statuses;
}

function apiAccountStatus(provider: Extract<ProviderType, 'openai' | 'anthropic' | 'google'>, displayName: string, status: CredentialStatus): ProviderAccountStatus {
  return {
    provider,
    displayName,
    surface: 'api',
    installed: true,
    authenticated: !!status?.authenticated,
    accountLabel: status?.label,
    statusLabel: status?.statusLabel || 'API key vereist',
    statusSource: 'api',
    canChat: !!status?.canChat,
    limitsKnown: false,
    error: status?.error,
  };
}

function localAccountStatus(provider: Extract<ProviderType, 'ollama'>, displayName: string, status: CredentialStatus): ProviderAccountStatus {
  return {
    provider,
    displayName,
    surface: 'local',
    installed: !!status?.authenticated,
    authenticated: !!status?.authenticated,
    statusLabel: status?.statusLabel || 'Offline',
    statusSource: 'local',
    canChat: !!status?.canChat,
    limitsKnown: false,
    error: status?.error,
  };
}

async function openAccountSurface(provider: ProviderAccountId) {
  if (provider === 'chatgpt') {
    const chatGptDesktop = await detectChatGptDesktop();
    if (chatGptDesktop) {
      const result = await shell.openPath(chatGptDesktop);
      if (!result) return { ok: true };
    }
    await shell.openExternal('https://chatgpt.com/');
    return { ok: true };
  }

  if (provider === 'claude-cli') {
    return openOrInstallInteractiveCli('claude');
  }

  if (provider === 'codex') {
    return openOrInstallInteractiveCli('codex');
  }

  const urls: Record<ProviderType, string> = {
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys',
    google: 'https://aistudio.google.com/apikey',
    ollama: 'https://ollama.com/download/windows',
    codex: 'https://developers.openai.com/codex/',
    antigravity: 'https://antigravity.google/docs/cli-install',
    remote: 'about:blank',
  };
  if (provider !== 'remote') await shell.openExternal(urls[provider]);
  return { ok: true };
}

async function preflightModel(modelRef: ModelRef, language: UiLanguage = 'nl'): Promise<{ ok: boolean; reason: FallbackReason; message: string }> {
  // Een chatgpt:* model gebruikt de ChatGPT-websessie en heeft geen OpenAI-API-key.
  // De generieke OpenAI-validator hier gebruiken blokkeerde geldige abonnementssessies
  // met een misleidende "Key is verlopen"-melding voordat de scraper kon starten.
  if (providerPreflightSurface(modelRef) === 'chatgpt-session') {
    const active = await chatgptScraper.isSessionActive();
    return active
      ? { ok: true, reason: 'provider_error', message: localizedText(language, 'ChatGPT-websessie is beschikbaar.', 'The ChatGPT web session is available.') }
      : {
        ok: false,
        reason: 'auth_failed',
        message: localizedText(language, 'ChatGPT-websessie is niet ingelogd. Open Instellingen -> ChatGPT Subscription -> Inloggen.', 'The ChatGPT web session is not signed in. Open Settings -> ChatGPT Subscription -> Sign in.'),
      };
  }

  if (modelRef.provider === 'google') {
    const quotaStatus = await getGeminiQuotaAuthStatus(true, language);
    if (!quotaStatus.connected) {
      return {
        ok: false,
        reason: 'auth_failed',
        message: quotaStatus.error || localizedText(language, 'Koppel voor Gemini zowel de API-key als Google Cloud-quota in Instellingen.', 'Connect both the API key and Google Cloud quota for Gemini in Settings.'),
      };
    }
  }

  const validation = await adapters[modelRef.provider].validateCredential(undefined, { language }).catch((error: any) => ({
    status: 'invalid' as const,
    error: error?.message || String(error),
  }));
  if (validation.status === 'valid') {
    return { ok: true, reason: 'provider_error', message: localizedText(language, 'Provider is gereed.', 'Provider is ready.') };
  }

  const reason = credentialPreflightFallbackReason(modelRef.provider);
  return {
    ok: false,
    reason,
    message: validation.error || localizedText(language, `${modelRef.provider} is niet gereed.`, `${modelRef.provider} is not ready.`),
  };
}

async function getFallbackConfig(): Promise<FallbackConfig> {
  const store = await getStore();
  const saved = store.get('fallback.config') as FallbackConfig | undefined;
  if (saved?.order) {
    const normalized = normalizeFallbackConfig(saved);
    if (JSON.stringify(saved) !== JSON.stringify(normalized)) store.set('fallback.config', normalized);
    return normalized;
  }

  const discoveredModels = cachedModels.length ? cachedModels : await refreshModels();

  return {
    autoSwitchEnabled: false,
    autoSwitchConfirmed: false,
    order: selectDefaultFallbackModels(discoveredModels).map((model) => ({
      enabled: true,
      modelRef: normalizeModelRef({
        provider: model.provider,
        modelId: model.id,
        runConfig: model.runConfig,
      }),
    })),
  };
}

async function setFallbackConfig(config: FallbackConfig) {
  const clean = normalizeFallbackConfig(config);
  (await getStore()).set('fallback.config', clean);
  return clean;
}

function normalizeFallbackConfig(config: FallbackConfig): FallbackConfig {
  const seen = new Set<string>();
  const switchState = normalizeFallbackSwitchState(config);
  return {
    ...switchState,
    order: (config.order || [])
      .filter((item) => item?.modelRef?.provider && item.modelRef.modelId)
      .map((item) => {
        const modelRef = normalizeModelRef(item.modelRef);
        return {
          enabled: item.enabled !== false,
          allowPaidApi: item.allowPaidApi === true,
          modelRef,
        };
      })
      .filter((item) => {
        try {
          assertProvider(item.modelRef.provider);
          if (!item.modelRef.modelId) return false;
          const groupKey = fallbackLimitGroupKey(item.modelRef);
          if (seen.has(groupKey)) return false;
          seen.add(groupKey);
          return true;
        } catch {
          return false;
        }
      }),
  };
}

function fallbackLimitGroupKey(modelRef: ModelRef) {
  const model = cachedModels.find((candidate) => candidate.provider === modelRef.provider && candidate.id === modelRef.modelId);
  if (model?.limitGroupKey) return model.limitGroupKey;
  if (modelRef.provider === 'codex') return 'codex:account';
  if (modelRef.provider === 'openai' && modelRef.modelId.startsWith('chatgpt:')) return 'openai:account';
  if (modelRef.provider === 'anthropic' && modelRef.modelId.startsWith('claude-cli:')) return 'anthropic:account';
  return `${modelRef.provider}:${modelRef.modelId}`;
}

function selectDefaultFallbackModels(models: AIModel[]) {
  const byProvider = new Map<ProviderType, AIModel>();
  const providerOrder = PROVIDERS;
  for (const provider of providerOrder) {
    const model = models.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.canChat !== false &&
        candidate.executionMode !== 'connector',
    );
    if (model) byProvider.set(provider, model);
  }
  return providerOrder.map((provider) => byProvider.get(provider)).filter(Boolean) as AIModel[];
}

async function firstDiscoveredChatModel() {
  const models = cachedModels.length ? cachedModels : await refreshModels();
  return selectDefaultFallbackModels(models)[0] || models.find((model) => model.canChat !== false && model.executionMode !== 'connector');
}

function normalizeModelRef(modelRef: ModelRef): ModelRef {
  const provider = modelRef.provider;
  const { modelId, runConfig: legacyRunConfig } = normalizeLegacyModelId(provider, String(modelRef.modelId || ''));
  const mergedRunConfig = {
    ...legacyRunConfig,
    ...modelRef.runConfig,
  };
  if (provider === 'codex' && !mergedRunConfig.baseModelId) mergedRunConfig.baseModelId = modelId;
  return {
    provider,
    modelId,
    runConfig: normalizeRunConfig(provider, mergedRunConfig),
  };
}

function normalizeRunConfig(provider: ProviderType, value?: ModelRunConfig): ModelRunConfig | undefined {
  const runConfig: ModelRunConfig = {};
  if (value?.baseModelId) runConfig.baseModelId = String(value.baseModelId);
  const effort = normalizeReasoningEffort(value?.reasoningEffort);
  if (effort) runConfig.reasoningEffort = effort;
  const serviceTier = normalizeServiceTier(value?.serviceTier);
  if (serviceTier) runConfig.serviceTier = serviceTier;
  const timeoutSeconds = Number(value?.timeoutSeconds || 0);
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) runConfig.timeoutSeconds = Math.max(30, Math.round(timeoutSeconds));
  if (value?.commandPresetId) runConfig.commandPresetId = String(value.commandPresetId).slice(0, 80);
  if (value?.commandGoal) runConfig.commandGoal = String(value.commandGoal).slice(0, 1200);
  if (value?.commandInstruction) runConfig.commandInstruction = String(value.commandInstruction).slice(0, 2000);
  // ChatGPT browser thinking effort (e.g. 'standard' | 'extended') — keep it, or it
  // gets stripped on every normalize and the Inspanning always falls back to default.
  if (value?.chatgptThinkingEffort) runConfig.chatgptThinkingEffort = String(value.chatgptThinkingEffort);
  return Object.keys(runConfig).length ? runConfig : undefined;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim();
  return /^[a-z][a-z0-9._-]*$/i.test(effort) ? effort : undefined;
}

function normalizeServiceTier(value: unknown): ServiceTier | undefined {
  if (typeof value !== 'string') return undefined;
  const tier = value.trim();
  return /^[a-z][a-z0-9._-]*$/i.test(tier) ? tier : undefined;
}

function serializeRunConfig(runConfig?: ModelRunConfig) {
  if (!runConfig || !Object.keys(runConfig).length) return null;
  return JSON.stringify(runConfig);
}

function appendRuntimeMetadata(systemPrompt: string | undefined, modelRef: ModelRef, language: UiLanguage = 'en') {
  const runConfig = modelRef.runConfig || {};
  const metadata = (language === 'nl' ? [
    'Runtimemetadata van de host-app:',
    `Provider: ${modelRef.provider}`,
    `Model-ID: ${modelRef.modelId}`,
    runConfig.reasoningEffort ? `Redeneerinspanning: ${runConfig.reasoningEffort}` : '',
    runConfig.serviceTier ? `Serviceniveau: ${runConfig.serviceTier}` : '',
    runConfig.commandPresetId ? `App-opdrachtpreset: ${runConfig.commandPresetId}` : '',
    runConfig.commandGoal ? `Actief doel: ${runConfig.commandGoal}` : '',
    runConfig.commandInstruction ? `Actieve app-opdracht: ${runConfig.commandInstruction}` : '',
    'Als de gebruiker vraagt welk model of welke redeneerinstelling is gekozen, antwoord dan op basis van deze metadata en verzin geen verborgen interne varianten.',
  ] : [
    'Runtime metadata from the host app:',
    `Provider: ${modelRef.provider}`,
    `Model ID: ${modelRef.modelId}`,
    runConfig.reasoningEffort ? `Reasoning effort: ${runConfig.reasoningEffort}` : '',
    runConfig.serviceTier ? `Service tier: ${runConfig.serviceTier}` : '',
    runConfig.commandPresetId ? `App command preset: ${runConfig.commandPresetId}` : '',
    runConfig.commandGoal ? `Active goal: ${runConfig.commandGoal}` : '',
    runConfig.commandInstruction ? `App command instruction: ${runConfig.commandInstruction}` : '',
    'If the user asks what model or reasoning setting is selected, answer from this metadata and do not invent hidden internal variants.',
  ]).filter(Boolean).join('\n');

  return systemPrompt ? `${metadata}\n\n${systemPrompt}` : metadata;
}

function mapChatRow(row: any): Chat | undefined {
  if (!row) return undefined;
  let activeRunConfig: ModelRunConfig | null = null;
  if (row.activeRunConfig) {
    try { activeRunConfig = JSON.parse(row.activeRunConfig); } catch { activeRunConfig = null; }
  }
  return { ...row, activeRunConfig, agentMode: normalizeAgentApprovalMode(row.agentMode) || null };
}

function getChatById(id: string) {
  return mapChatRow(getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id));
}

function createChat(title: string, folderId?: string, requestedId?: string) {
  const now = new Date().toISOString();
  const id = String(requestedId || '').trim();
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new Error('Ongeldig gesprek-id.');
  }
  const chat: Chat = {
    id: id || crypto.randomUUID(),
    title: String(title || '').trim() || 'New chat',
    folderId: folderId || null,
    projectPath: null,
    systemPrompt: null,
    activeModelId: null,
    activeProvider: null,
    activeRunConfig: null,
    agentMode: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare('INSERT INTO chats (id, title, folderId, projectPath, systemPrompt, activeModelId, activeProvider, activeRunConfig, agentMode, createdAt, updatedAt) VALUES (@id, @title, @folderId, @projectPath, @systemPrompt, @activeModelId, @activeProvider, @activeRunConfig, @agentMode, @createdAt, @updatedAt)')
    .run({ ...chat, activeRunConfig: null, agentMode: null });
  return chat;
}

function updateChat(id: string, data: Partial<Chat>) {
  const allowed = ['title', 'folderId', 'projectPath', 'systemPrompt', 'activeModelId', 'activeProvider', 'agentMode'] as const;
  const clean: Record<string, any> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (key === 'projectPath') {
      clean[key] = normalizeProjectPath((data as any)[key]);
    } else if (key === 'agentMode') {
      clean[key] = normalizeAgentApprovalMode((data as any)[key]) || null;
    } else {
      clean[key] = (data as any)[key] ?? null;
    }
  }
  // activeRunConfig is an object → store as JSON text.
  if (Object.prototype.hasOwnProperty.call(data, 'activeRunConfig')) {
    clean.activeRunConfig = serializeRunConfig(data.activeRunConfig || undefined);
  }
  if (Object.keys(clean).length) {
    const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
    getDb()
      .prepare(`UPDATE chats SET ${updates}, updatedAt = @updatedAt WHERE id = @id`)
      .run({ ...clean, id, updatedAt: new Date().toISOString() });
  }
  return getChatById(id);
}

function insertMessage(message: Message) {
  const normalized = {
    id: message.id || crypto.randomUUID(),
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    modelId: message.modelId || null,
    provider: message.provider || null,
    inputTokens: Number(message.inputTokens || 0),
    outputTokens: Number(message.outputTokens || 0),
    fallbackFrom: message.fallbackFrom || null,
    attachments: message.attachments || null,
    runConfig: message.runConfig || null,
    toolRun: message.toolRun || null,
    createdAt: message.createdAt || new Date().toISOString(),
  };
  getDb()
    .prepare('INSERT INTO messages (id, chatId, role, content, modelId, provider, inputTokens, outputTokens, fallbackFrom, attachments, runConfig, toolRun, createdAt) VALUES (@id, @chatId, @role, @content, @modelId, @provider, @inputTokens, @outputTokens, @fallbackFrom, @attachments, @runConfig, @toolRun, @createdAt)')
    .run(normalized);
  getDb().prepare('UPDATE chats SET updatedAt = ? WHERE id = ?').run(new Date().toISOString(), normalized.chatId);
  return normalized;
}

function updateMemory(id: string, data: any) {
  const allowed = ['type', 'scopeId', 'title', 'content', 'maxTokens', 'enabled'] as const;
  const clean: Record<string, any> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, key)) clean[key] = data[key];
  }
  if (clean.enabled !== undefined) clean.enabled = clean.enabled ? 1 : 0;
  if (Object.keys(clean).length) {
    const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
    getDb().prepare(`UPDATE memories SET ${updates} WHERE id = @id`).run({ ...clean, id });
  }
  return getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function savePromptPreset(preset: any) {
  const now = new Date().toISOString();
  const row = {
    id: preset.id || crypto.randomUUID(),
    name: String(preset.name || '').trim() || 'Prompt preset',
    content: String(preset.content || ''),
    isDefault: preset.isDefault ? 1 : 0,
    createdAt: preset.createdAt || now,
    updatedAt: now,
  };
  getDb()
    .prepare('INSERT INTO prompt_presets (id, name, content, isDefault, createdAt, updatedAt) VALUES (@id, @name, @content, @isDefault, @createdAt, @updatedAt) ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, isDefault = excluded.isDefault, updatedAt = excluded.updatedAt')
    .run(row);
  return row;
}

async function assemblePromptContext(chat: Chat, explicitSystemPrompt?: string) {
  const parts: string[] = [];
  const basePrompt = explicitSystemPrompt ?? chat.systemPrompt;
  if (basePrompt) parts.push(basePrompt);

  const projectPath = await getEffectiveProjectPath(chat);
  if (projectPath) {
    parts.push([
      '[Project]',
      `Current project root: ${projectPath}`,
      'Use this as the working directory for project-specific answers. When the host provides tool access, shell commands should run from this root.',
    ].join('\n'));
  }

  const memories = [
    ...getDb().prepare("SELECT * FROM memories WHERE enabled = 1 AND type = 'global'").all(),
    ...(chat.folderId
      ? getDb().prepare("SELECT * FROM memories WHERE enabled = 1 AND type = 'project' AND scopeId = ?").all(chat.folderId)
      : []),
    ...getDb().prepare("SELECT * FROM memories WHERE enabled = 1 AND type = 'chat' AND scopeId = ?").all(chat.id),
  ] as Array<{ title: string; content: string; maxTokens: number }>;

  for (const memory of memories) {
    const maxChars = Math.max(200, Number(memory.maxTokens || 1000) * 4);
    parts.push(`[Memory: ${memory.title}]\n${String(memory.content || '').slice(0, maxChars)}`);
  }

  return { systemPrompt: parts.join('\n\n') || undefined };
}

async function getEffectiveProjectPath(chat: Chat) {
  const candidates: Array<string | null | undefined> = [];
  if (chat.folderId) {
    const folder = getDb().prepare('SELECT projectPath FROM folders WHERE id = ?').get(chat.folderId) as { projectPath?: string | null } | undefined;
    candidates.push(folder?.projectPath);
  }
  // Legacy per-chat project paths are only a fallback. New project structure uses
  // folders as projects, so the folder path must win for every chat inside it.
  candidates.push(chat.projectPath);
  candidates.push(ensureDefaultWorkspacePath());
  for (const candidate of candidates) {
    const normalized = normalizeProjectPath(candidate);
    if (!normalized) continue;
    try {
      const stat = fs.statSync(normalized);
      if (stat.isDirectory()) return normalized;
    } catch {
      // Ignore stale project paths; the UI still shows the saved value.
    }
  }
  return undefined;
}

function ensureDefaultWorkspacePath() {
  try {
    const documents = app.getPath('documents');
    const workspace = selectDefaultWorkspacePath(documents, fs.existsSync);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  } catch {
    return process.cwd();
  }
}

function normalizeProjectPath(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(expandPath(trimmed));
}

function getChatMessages(chatId: string): ChatMessage[] {
  const rows = getDb().prepare('SELECT id, role, content FROM messages WHERE chatId = ? ORDER BY createdAt ASC').all(chatId) as any[];
  const attachmentRows = getDb().prepare('SELECT * FROM attachments WHERE chatId = ? AND messageId IS NOT NULL ORDER BY createdAt ASC').all(chatId) as unknown as AttachmentRecord[];
  const attachmentsByMessage = new Map<string, AttachmentRecord[]>();
  for (const attachment of attachmentRows) {
    if (!attachment.messageId) continue;
    const current = attachmentsByMessage.get(attachment.messageId) || [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const attachments = attachmentsByMessage.get(row.id) || [];
      return {
        role: row.role,
        content: row.content,
        attachments: attachments.length ? attachments : undefined,
      };
    });
}

function prepareMessagesForContext(messages: ChatMessage[], systemPrompt: string | undefined, modelRef: ModelRef, language: UiLanguage = 'nl') {
  const model = cachedModels.find((candidate) => candidate.provider === modelRef.provider && candidate.id === modelRef.modelId);
  const contextWindow = Math.max(8_192, Number(model?.contextWindow || 128_000));
  const outputReserve = Math.max(2_048, Number(model?.maxOutputTokens || 8_192));
  const systemTokens = estimateTokens(systemPrompt || '');
  const budget = Math.max(1_024, contextWindow - outputReserve - systemTokens - 2_048);
  const selected: ChatMessage[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const tokens = estimateMessageTokens(message);
    if (!selected.length && tokens > budget) {
      throw new ProviderRuntimeError(localizedText(language, 'Het nieuwste bericht met bijlagen past niet in het contextvenster van dit model.', 'The latest message with attachments does not fit in this model\'s context window.'), 'context_exceeded');
    }
    if (used + tokens > budget) break;
    selected.unshift(message);
    used += tokens;
  }

  return { messages: selected, omitted: messages.length - selected.length };
}

function estimateMessageTokens(message: ChatMessage) {
  let total = estimateTokens(message.content || '') + 8;
  for (const attachment of message.attachments || []) {
    if (attachment.kind === 'image') total += 1_500;
    else total += Math.max(0, Number(attachment.tokenEstimate || 0));
  }
  return total;
}

function getLatestUserAttachments(chatId: string): AttachmentRecord[] {
  const row = getDb()
    .prepare("SELECT id FROM messages WHERE chatId = ? AND role = 'user' ORDER BY createdAt DESC LIMIT 1")
    .get(chatId) as { id: string } | undefined;
  if (!row) return [];
  return getDb().prepare('SELECT * FROM attachments WHERE messageId = ?').all(row.id) as unknown as AttachmentRecord[];
}

function messageAttachmentRefs(attachments: AttachmentRecord[]): AttachmentRef[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    chatId: attachment.chatId,
    messageId: attachment.messageId,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size,
    tokenEstimate: attachment.tokenEstimate,
    contentPreview: attachment.contentPreview,
    createdAt: attachment.createdAt,
  }));
}

function requireChat(chatId: string) {
  const chat = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as Chat | undefined;
  if (!chat) throw new Error(`Chat not found: ${chatId}`);
  return chat;
}

function recordUsage(chatId: string, messageId: string, modelRef: ModelRef, usage: TokenUsage) {
  // Een lege placeholder betekent dat de provider geen usage heeft geleverd;
  // sla die niet op alsof er werkelijk nul tokens zijn verbruikt.
  if (!hasRecordableUsage(usage)) return;
  getDb()
    .prepare('INSERT INTO usage_events (id, chatId, messageId, provider, modelId, inputTokens, outputTokens, totalTokens, cachedTokens, reasoningTokens, usageSource, createdAt) VALUES (@id, @chatId, @messageId, @provider, @modelId, @inputTokens, @outputTokens, @totalTokens, @cachedTokens, @reasoningTokens, @usageSource, @createdAt)')
    .run({
      id: crypto.randomUUID(),
      chatId,
      messageId,
      provider: modelRef.provider,
      modelId: modelRef.modelId,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: usage.totalTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      reasoningTokens: usage.reasoningTokens || 0,
      usageSource: normalizeUsageSource(usage.source),
      createdAt: new Date().toISOString(),
    });
}

function sendUsageUpdate(win: BrowserWindow | null, chatId?: string) {
  if (!win || win.isDestroyed()) return;
  getTokenDashboard(chatId)
    .then((dashboard) => win.webContents.send('tokens:usageUpdate', dashboard))
    .catch(() => { });
}

function recordRateLimit(snapshot: RateLimitSnapshot) {
  const row = {
    id: rateLimitKey(snapshot),
    provider: snapshot.provider,
    modelId: snapshot.modelId || null,
    known: snapshot.known ? 1 : 0,
    source: snapshot.source,
    limitScope: snapshot.limitScope || null,
    limitGroupKey: snapshot.limitGroupKey || null,
    displayState: snapshot.displayState || null,
    requestsLimit: snapshot.requestsLimit ?? null,
    requestsRemaining: snapshot.requestsRemaining ?? null,
    tokensLimit: snapshot.tokensLimit ?? null,
    tokensRemaining: snapshot.tokensRemaining ?? null,
    resetRequestsAt: snapshot.resetRequestsAt || null,
    resetTokensAt: snapshot.resetTokensAt || null,
    retryAfterMs: snapshot.retryAfterMs ?? null,
    note: snapshot.note || null,
    updatedAt: snapshot.updatedAt,
  };
  // INSERT OR REPLACE resolves a conflict on EITHER the id PK or the
  // (provider, modelId) unique index — avoids "UNIQUE constraint failed".
  const db = getDb();
  const updateBindings = providerLimitUpdateBindings(row);
  // Match on the natural key (provider, modelId) and never touch the id PK —
  // rewriting id to a value used by another row throws "UNIQUE constraint failed:
  // provider_limits.id".
  const updated = db
    .prepare('UPDATE provider_limits SET known = @known, source = @source, limitScope = @limitScope, limitGroupKey = @limitGroupKey, displayState = @displayState, requestsLimit = @requestsLimit, requestsRemaining = @requestsRemaining, tokensLimit = @tokensLimit, tokensRemaining = @tokensRemaining, resetRequestsAt = @resetRequestsAt, resetTokensAt = @resetTokensAt, retryAfterMs = @retryAfterMs, note = @note, updatedAt = @updatedAt WHERE provider = @provider AND IFNULL(modelId, \'\') = IFNULL(@modelId, \'\')')
    .run(updateBindings);
  if (!updated.changes) {
    try {
      db.prepare('INSERT INTO provider_limits (id, provider, modelId, known, source, limitScope, limitGroupKey, displayState, requestsLimit, requestsRemaining, tokensLimit, tokensRemaining, resetRequestsAt, resetTokensAt, retryAfterMs, note, updatedAt) VALUES (@id, @provider, @modelId, @known, @source, @limitScope, @limitGroupKey, @displayState, @requestsLimit, @requestsRemaining, @tokensLimit, @tokensRemaining, @resetRequestsAt, @resetTokensAt, @retryAfterMs, @note, @updatedAt)')
        .run(row);
    } catch {
      db.prepare('UPDATE provider_limits SET known = @known, source = @source, limitScope = @limitScope, limitGroupKey = @limitGroupKey, displayState = @displayState, requestsLimit = @requestsLimit, requestsRemaining = @requestsRemaining, tokensLimit = @tokensLimit, tokensRemaining = @tokensRemaining, resetRequestsAt = @resetRequestsAt, resetTokensAt = @resetTokensAt, retryAfterMs = @retryAfterMs, note = @note, updatedAt = @updatedAt WHERE provider = @provider AND IFNULL(modelId, \'\') = IFNULL(@modelId, \'\')')
        .run(updateBindings);
    }
  }
}

async function getTokenDashboard(chatId?: string): Promise<TokenDashboard> {
  const db = getDb();
  const usageRows = db
    .prepare(`SELECT * FROM usage_events ${chatId ? 'WHERE chatId = ?' : ''} ORDER BY createdAt DESC LIMIT 200`)
    .all(...(chatId ? [chatId] : [])) as any[];
  const aggregateRows = db
    .prepare(`SELECT provider, modelId, SUM(inputTokens) inputTokens, SUM(outputTokens) outputTokens, SUM(totalTokens) totalTokens, SUM(cachedTokens) cachedTokens, SUM(reasoningTokens) reasoningTokens, GROUP_CONCAT(DISTINCT usageSource) usageSources FROM usage_events ${chatId ? 'WHERE chatId = ?' : ''} GROUP BY provider, modelId`)
    .all(...(chatId ? [chatId] : [])) as any[];

  const usageByModel: TokenDashboard['usageByModel'] = {};
  for (const row of aggregateRows) {
    const key = `${row.provider}:${row.modelId}`;
    const discoveredModel = cachedModels.find((model) => model.provider === row.provider && model.id === row.modelId);
    const current = usageByModel[key] || {
      provider: row.provider,
      modelId: row.modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      contextWindowSize: discoveredModel?.contextWindow || 128000,
      contextUsedPercent: 0,
      source: usageSourceFromRows(row.usageSources),
    };
    current.inputTokens += row.inputTokens || 0;
    current.outputTokens += row.outputTokens || 0;
    current.totalTokens += row.totalTokens || 0;
    current.cachedTokens += row.cachedTokens || 0;
    current.reasoningTokens += row.reasoningTokens || 0;
    // Historisch totaalverbruik is geen contextvenster. De actuele context staat
    // afzonderlijk in dashboard.context en mag hier niet uit een cumulatieve som
    // worden afgeleid.
    current.contextUsedPercent = 0;
    usageByModel[key] = current;
  }

  const context = chatId ? await getContextUsage(chatId) : { used: 0, total: 0, percent: 0, source: 'unknown' as const };
  return {
    usageEvents: usageRows.map((row) => ({ ...row, source: normalizeUsageSource(row.usageSource) })),
    usageByModel,
    rateLimits: await getStoredRateLimits(),
    quotas: await ensureRecentQuotaSnapshots(),
    context: { chatId, ...context },
  };
}

async function loginChatGptBrowser(language: UiLanguage = 'nl') {
  try {
    await chatgptScraper.openLoginWindow(language);
    providerCredentialStatusesCache = null;
    cachedModels = cachedModels.filter((model) => !(model.provider === 'openai' && model.id.startsWith('chatgpt:')));
    // Geef de renderer één samenhangende post-login-snapshot. Zo hoeft de
    // onboarding niet op losse, onderling racende statuscalls te gokken.
    const models = await refreshModels('openai').catch(() => []);
    const [versions, sessionStatus] = await Promise.all([
      chatgptScraper.listSessionVersions().catch(() => []),
      chatgptScraper.getSessionStatus(),
    ]);
    return { success: true, models, versions, sessionStatus };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

function isPaidApiFallback(modelRef: ModelRef) {
  if (modelRef.provider === 'google') return true;
  if (modelRef.provider === 'openai') return !modelRef.modelId.startsWith('chatgpt:');
  if (modelRef.provider === 'anthropic') return !modelRef.modelId.startsWith('claude-cli:');
  return modelRef.provider === 'remote';
}

function emitFallbackSwitch(
  win: BrowserWindow | null,
  requestId: string,
  from: ModelRef,
  to: ModelRef,
  reason: FallbackReason,
  message: string,
  preSkipped: boolean,
  language: UiLanguage = 'nl',
) {
  sendStreamEvent(win, {
    requestId,
    type: 'model_switch',
    from,
    to,
    reason,
    detail: preSkipped
      ? localizedText(language, 'Bekende actieve cooldown preventief overgeslagen.', 'Known active cooldown skipped preemptively.')
      : message,
    delta: localizedText(
      language,
      `\n\n[Doorgeschakeld van ${from.modelId} naar ${to.modelId}: ${reason}]\n\n`,
      `\n\n[Switched from ${from.modelId} to ${to.modelId}: ${reason}]\n\n`,
    ),
  });
  win?.webContents.send('fallback:switch', { requestId, from, to, reason, message, preSkipped });
}

function recordRuntimeQuotaFailure(
  modelRef: ModelRef,
  classified: { message: string; rateLimit?: RateLimitSnapshot },
) {
  const observedAt = new Date().toISOString();
  const resetAt = classified.rateLimit?.resetRequestsAt
    || classified.rateLimit?.resetTokensAt
    || (classified.rateLimit?.retryAfterMs
      ? new Date(Date.now() + classified.rateLimit.retryAfterMs).toISOString()
      : new Date(Date.now() + 60_000).toISOString());
  const group = fallbackLimitGroupKey(modelRef);
  const unavailable = makeUnknownQuota(modelRef.provider, providerSurfaceForRef(modelRef), group, classified.message, 'runtime-error');
  const snapshot = {
    ...unavailable,
    // Een runtime-429 moet naast een periodiek opgehaalde providerstatus kunnen
    // bestaan. Anders overschrijft de volgende collector dezelfde primaire sleutel
    // en kan fallback te vroeg opnieuw dezelfde provider proberen.
    id: `${unavailable.id}:runtime-error`,
    state: 'cooldown' as const,
    accuracy: 'live' as const,
    observedAt,
    staleAfter: resetAt,
    buckets: [{ id: 'runtime-rate-limit', label: 'Runtime-limiet', meter: 'provider' as const, state: 'cooldown' as const, resetAt }],
  };
  persistQuotaSnapshots([snapshot]);
}

function providerSurfaceForRef(modelRef: ModelRef): import('../src/providers/types').ProviderSurface {
  const model = cachedModels.find((candidate) => candidate.provider === modelRef.provider && candidate.id === modelRef.modelId);
  if (model?.providerSurface) return model.providerSurface;
  if (modelRef.provider === 'ollama') return 'local';
  if (modelRef.provider === 'codex' || modelRef.provider === 'antigravity' || modelRef.modelId.startsWith('claude-cli:')) return 'cli';
  if (modelRef.modelId.startsWith('chatgpt:')) return 'subscription-web';
  return 'api';
}

type TurnActionStatus = 'requested' | 'approved' | 'completed' | 'failed' | 'denied' | 'uncertain';

function recordTurnExecutionActivity(turnId: string, activity: NativeToolActivity, cwd?: string) {
  const signature = nativeToolLedgerSignature(activity.toolName, activity.input, cwd);
  const now = new Date().toISOString();
  const status: TurnActionStatus = activity.phase === 'result'
    ? (activity.ok ? 'completed' : 'failed')
    : activity.phase === 'denied'
      ? 'denied'
      : activity.phase;
  const id = crypto.createHash('sha256').update(`${turnId}\0${activity.provider}\0${activity.toolUseId || ''}\0${signature}`).digest('hex');
  getDb().prepare(`
    INSERT INTO turn_execution_actions
      (id, turnId, provider, toolUseId, toolName, signature, status, inputJson, output, createdAt, updatedAt)
    VALUES
      (@id, @turnId, @provider, @toolUseId, @toolName, @signature, @status, @inputJson, @output, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, output=excluded.output, updatedAt=excluded.updatedAt
  `).run({
    id, turnId, provider: activity.provider, toolUseId: activity.toolUseId || null,
    toolName: activity.toolName, signature, status, inputJson: stableJson(activity.input),
    output: activity.output || activity.detail || null, createdAt: now, updatedAt: now,
  });
}

function duplicateTurnAction(turnId: string, toolName: string, input: Record<string, unknown>, cwd?: string) {
  return getDb().prepare(`
    SELECT status, provider, output FROM turn_execution_actions
    WHERE turnId = ? AND signature = ? AND status IN ('completed', 'uncertain')
    ORDER BY updatedAt DESC LIMIT 1
  `).get(turnId, nativeToolLedgerSignature(toolName, input, cwd)) as { status: TurnActionStatus; provider: string; output?: string } | undefined;
}

function markPendingTurnActionsUncertain(turnId: string, provider: ProviderType) {
  getDb().prepare(`
    UPDATE turn_execution_actions SET status = 'uncertain', updatedAt = ?
    WHERE turnId = ? AND provider = ? AND status IN ('requested', 'approved')
  `).run(new Date().toISOString(), turnId, provider);
}

function executionLedgerResumePrompt(turnId: string, language: UiLanguage = 'nl') {
  const rows = getDb().prepare(`
    SELECT toolName, inputJson, status, output FROM turn_execution_actions
    WHERE turnId = ? AND status IN ('completed', 'uncertain') ORDER BY createdAt
  `).all(turnId) as Array<{ toolName: string; inputJson: string; status: TurnActionStatus; output?: string }>;
  if (!rows.length) return '';
  const completed = rows.filter((row) => row.status === 'completed');
  const uncertain = rows.filter((row) => row.status === 'uncertain');
  return language === 'en'
    ? [
      'SAFE RESUMPTION OF THE SAME TURN:',
      'Do not repeat exact actions that already completed; the app also blocks duplicates technically.',
      ...completed.map((row) => `- COMPLETED ${row.toolName} ${row.inputJson}${row.output ? ` -> ${boundedString(row.output, 300, 'Tool output')}` : ''}`),
      ...(uncertain.length ? ['Check uncertain actions read-only first; do not repeat them blindly.'] : []),
      ...uncertain.map((row) => `- UNCERTAIN ${row.toolName} ${row.inputJson}`),
      'New mutating actions go through the normal approval flow again.',
    ].join('\n')
    : [
      'VEILIGE HERVATTING VAN DEZELFDE BEURT:',
      'Voer voltooide exacte acties niet opnieuw uit; de app blokkeert duplicaten ook technisch.',
      ...completed.map((row) => `- VOLTOOID ${row.toolName} ${row.inputJson}${row.output ? ` -> ${boundedString(row.output, 300, 'Tooluitvoer')}` : ''}`),
      ...(uncertain.length ? ['Controleer onzekere acties eerst read-only; voer ze niet blind opnieuw uit.'] : []),
      ...uncertain.map((row) => `- ONZEKER ${row.toolName} ${row.inputJson}`),
      'Nieuwe muterende acties doorlopen de normale goedkeuring opnieuw.',
    ].join('\n');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function ensureRecentQuotaSnapshots() {
  const stored = getStoredQuotaSnapshots();
  const newest = Math.max(0, ...stored.map((snapshot) => new Date(snapshot.observedAt).getTime()));
  if (stored.length && Date.now() - newest < 5 * 60_000) return stored;
  try {
    return await refreshProviderQuotas();
  } catch {
    return stored;
  }
}

function getStoredQuotaSnapshots(): import('../src/providers/types').ProviderQuotaSnapshot[] {
  return (getDb().prepare('SELECT * FROM provider_quota_snapshots ORDER BY observedAt DESC').all() as any[]).map((row) => ({
    id: row.id,
    provider: row.provider,
    surface: row.surface,
    modelId: row.modelId || undefined,
    limitGroupKey: row.limitGroupKey,
    planTier: row.planTier || undefined,
    state: row.state,
    source: row.source,
    accuracy: row.accuracy,
    observedAt: row.observedAt,
    staleAfter: row.staleAfter || undefined,
    delayedBySeconds: row.delayedBySeconds ?? undefined,
    note: row.note || undefined,
    buckets: safeJsonParse(row.bucketsJson, []),
  }));
}

async function refreshProviderQuotas() {
  if (providerQuotaRefreshInFlight) return providerQuotaRefreshInFlight;
  const refresh = (async () => {
    const store = await getStore();
    const codexExecutable = await findExecutablePath(codexExecutableCandidates(store.get('codex.executable') as string | undefined));
    const legacyRateLimits = await getStoredRateLimits();
    const snapshots = await collectProviderQuotaSnapshots({
      codexExecutable,
      antigravityStatusPath: store.get('antigravity.statusJsonPath') as string | undefined,
      models: cachedModels,
      legacyRateLimits,
    });
    persistQuotaSnapshots(snapshots, true);
    return getStoredQuotaSnapshots();
  })().finally(() => {
    if (providerQuotaRefreshInFlight === refresh) providerQuotaRefreshInFlight = null;
  });
  providerQuotaRefreshInFlight = refresh;
  return refresh;
}

function persistQuotaSnapshots(snapshots: import('../src/providers/types').ProviderQuotaSnapshot[], replaceCollected = false) {
  const db = getDb();
  if (replaceCollected) {
    // Een collectorrefresh is een nieuwe complete momentopname. Laat oude
    // modelbuckets niet eindeloos in het dashboard staan, maar bewaar een nog
    // actieve runtime-429 omdat die actueler en veiliger is dan vertraagde data.
    db.prepare(`DELETE FROM provider_quota_snapshots WHERE source <> 'runtime-error' OR (staleAfter IS NOT NULL AND staleAfter <= ?)`).run(new Date().toISOString());
  }
  const statement = db.prepare(`
    INSERT INTO provider_quota_snapshots
      (id, provider, surface, modelId, limitGroupKey, planTier, state, source, accuracy, observedAt, staleAfter, delayedBySeconds, note, bucketsJson, updatedAt)
    VALUES
      (@id, @provider, @surface, @modelId, @limitGroupKey, @planTier, @state, @source, @accuracy, @observedAt, @staleAfter, @delayedBySeconds, @note, @bucketsJson, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider, surface=excluded.surface, modelId=excluded.modelId,
      limitGroupKey=excluded.limitGroupKey, planTier=excluded.planTier, state=excluded.state,
      source=excluded.source, accuracy=excluded.accuracy, observedAt=excluded.observedAt,
      staleAfter=excluded.staleAfter, delayedBySeconds=excluded.delayedBySeconds,
      note=excluded.note, bucketsJson=excluded.bucketsJson, updatedAt=excluded.updatedAt
  `);
  const updatedAt = new Date().toISOString();
  for (const snapshot of snapshots) {
    statement.run({
      id: snapshot.id,
      provider: snapshot.provider,
      surface: snapshot.surface,
      modelId: snapshot.modelId || null,
      limitGroupKey: snapshot.limitGroupKey,
      planTier: snapshot.planTier || null,
      state: snapshot.state,
      source: snapshot.source,
      accuracy: snapshot.accuracy,
      observedAt: snapshot.observedAt,
      staleAfter: snapshot.staleAfter || null,
      delayedBySeconds: snapshot.delayedBySeconds ?? null,
      note: snapshot.note || null,
      bucketsJson: JSON.stringify(snapshot.buckets),
      updatedAt,
    });
  }
}

async function getContextUsage(chatId: string, requestedModelRef?: ModelRef) {
  const chat = requireChat(chatId);
  const messages = getChatMessages(chatId);
  const fallbackModel = await firstDiscoveredChatModel();
  const modelRef = normalizeModelRef(
    requestedModelRef || {
      provider: (chat.activeProvider as ProviderType) || fallbackModel?.provider || 'codex',
      modelId: chat.activeModelId || fallbackModel?.id || '',
      runConfig: fallbackModel?.runConfig,
    },
  );
  if (!modelRef.modelId) {
    return {
      provider: modelRef.provider,
      modelId: modelRef.modelId,
      used: 0,
      total: 0,
      percent: 0,
      source: 'unknown' as const,
      windowSource: 'unknown' as const,
    };
  }
  const adapter = adapters[modelRef.provider] || adapters.codex;
  const used = await adapter.countTokens(modelRef.modelId, messages, chat.systemPrompt || undefined);
  const model = cachedModels.find((candidate) => candidate.provider === modelRef.provider && candidate.id === modelRef.modelId);
  const antigravityState = modelRef.provider === 'antigravity' ? await readAntigravityStatuslineState() : null;
  const total = antigravityState?.context_window || model?.contextWindow || 0;
  return {
    provider: modelRef.provider,
    modelId: modelRef.modelId,
    used,
    total,
    percent: total ? Math.round((used / total) * 100) : 0,
    // countTokens kan bij providers intern terugvallen op een lokale schatting;
    // zolang die API geen bronmetadata teruggeeft, claimen we dus niet dat het
    // gebruikte aantal exact door de provider is gemeten.
    source: 'estimate' as const,
    windowSource: antigravityState?.context_window ? 'cli' as const : contextSourceForModel(modelRef.provider, model),
  };
}

function contextSourceForModel(provider: ProviderType, model?: AIModel) {
  if (model?.contextSource) return model.contextSource;
  if (!model) return 'unknown' as const;
  if (provider === 'anthropic' || provider === 'google') return 'provider' as const;
  if (provider === 'codex' || provider === 'openai' || provider === 'ollama') return 'estimate' as const;
  return 'unknown' as const;
}

async function getStoredRateLimits() {
  const rows = getDb().prepare('SELECT * FROM provider_limits ORDER BY updatedAt DESC').all() as any[];
  const stored = rows.map((row) => ({
    provider: row.provider,
    modelId: row.modelId || undefined,
    known: !!row.known,
    source: row.source,
    limitScope: row.limitScope || undefined,
    limitGroupKey: row.limitGroupKey || undefined,
    displayState: row.displayState || undefined,
    requestsLimit: row.requestsLimit ?? undefined,
    requestsRemaining: row.requestsRemaining ?? undefined,
    tokensLimit: row.tokensLimit ?? undefined,
    tokensRemaining: row.tokensRemaining ?? undefined,
    resetRequestsAt: row.resetRequestsAt || undefined,
    resetTokensAt: row.resetTokensAt || undefined,
    retryAfterMs: row.retryAfterMs ?? undefined,
    note: row.note || undefined,
    updatedAt: row.updatedAt,
  })) as RateLimitSnapshot[];

  const dynamic = await Promise.all(PROVIDERS.map((provider) => adapters[provider].getRateLimitState()));
  const knownKeys = new Set(stored.map((snapshot) => rateLimitKey(snapshot)));
  return [...stored, ...dynamic.filter((snapshot) => !knownKeys.has(rateLimitKey(snapshot)))];
}

async function selectAndImportFiles(chatId?: string) {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'csv', 'json', 'md', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled) return [];
  if (result.filePaths.length > MAX_ATTACHMENT_COUNT) throw new Error(`Selecteer maximaal ${MAX_ATTACHMENT_COUNT} bestanden tegelijk.`);
  const stats = await Promise.all(result.filePaths.map((filePath) => fs.promises.stat(filePath)));
  const totalBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('Bijlagen mogen samen maximaal 50 MB zijn.');
  const imported: AttachmentRef[] = [];
  for (const filePath of result.filePaths) {
    imported.push(await importAttachment(filePath, chatId));
  }
  return imported;
}

async function selectDirectory() {
  // Nieuwe installaties starten in Documents/LLMelt; een bestaande legacywerkmap
  // blijft intact zodat opgeslagen projecten en bestanden niet onverwacht verhuizen.
  // i.p.v. de standaard Downloads-map.
  const defaultPath = ensureDefaultWorkspacePath();
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });
  if (result.canceled) return null;
  return result.filePaths[0] || null;
}

async function importAttachment(filePath: string, chatId?: string) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Alleen bestanden kunnen worden geïmporteerd.');
  if (stat.size > 25 * 1024 * 1024) throw new Error('Dit bestand is te groot. De limiet is 25 MB.');

  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.promises.readFile(filePath);
  const id = crypto.randomUUID();
  const mimeType = mimeFromExt(ext);
  const kind = kindFromExt(ext);
  let textContent: string | null = null;
  const base64Content: string | null = null;
  let storedPath = filePath;

  if (kind === 'text') textContent = buffer.toString('utf8');
  if (kind === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    textContent = (parsed.text || '').slice(0, MAX_EXTRACTED_TEXT_CHARS);
  }
  if (kind === 'image') {
    const managedDir = managedAttachmentDirectory();
    await fs.promises.mkdir(managedDir, { recursive: true });
    storedPath = path.join(managedDir, `${id}${ext}`);
    await fs.promises.writeFile(storedPath, buffer, { flag: 'wx' });
  }

  const row = {
    id,
    chatId: chatId || null,
    messageId: null,
    name: path.basename(filePath),
    path: storedPath,
    mimeType,
    kind,
    size: stat.size,
    tokenEstimate: estimateTokens(textContent || ''),
    textContent,
    base64Content,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare('INSERT INTO attachments (id, chatId, messageId, name, path, mimeType, kind, size, tokenEstimate, textContent, base64Content, createdAt) VALUES (@id, @chatId, @messageId, @name, @path, @mimeType, @kind, @size, @tokenEstimate, @textContent, @base64Content, @createdAt)')
    .run(row);
  importedAttachmentIds.add(id);
  return toAttachmentRef(row);
}

function getAttachmentById(id: string) {
  if (!importedAttachmentIds.has(id)) {
    const found = getDb().prepare('SELECT id FROM attachments WHERE id = ?').get(id);
    if (!found) throw new Error('Attachment is not available.');
  }
  const row = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRecord | undefined;
  if (!row) throw new Error('Attachment not found.');
  return toAttachmentRef(row);
}

function getAttachments(ids: string[], chatId: string) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  // Een bijlage die bij een nog onzichtbaar concept is gekozen heeft bewust nog
  // geen chatId. Bij de eerste verzending wordt het gesprek eerst gematerialiseerd
  // en wordt de bijlage hieronder aan dat gesprek gekoppeld.
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE (chatId = ? OR chatId IS NULL) AND id IN (${placeholders})`)
    .all(chatId, ...ids) as unknown as AttachmentRecord[];
  if (rows.length !== new Set(ids).size) throw new Error('Een of meer bijlagen horen niet bij dit gesprek.');
  return rows;
}

async function hydrateMessageAttachments(messages: ChatMessage[]) {
  return Promise.all(messages.map(async (message) => ({
    ...message,
    attachments: message.attachments ? await hydrateAttachments(message.attachments as AttachmentRecord[]) : undefined,
  })));
}

async function hydrateAttachments(attachments: AttachmentRecord[]) {
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.kind !== 'image' || attachment.base64Content || !attachment.path) return attachment;
    const buffer = await fs.promises.readFile(attachment.path);
    if (buffer.length > 25 * 1024 * 1024) throw new Error(`Afbeelding ${attachment.name} is groter dan 25 MB.`);
    return { ...attachment, base64Content: buffer.toString('base64') };
  }));
}

function managedAttachmentDirectory() {
  return path.join(app.getPath('userData'), 'attachments');
}

async function removeManagedAttachmentPath(filePath: string) {
  if (!isPathInsideRoot(managedAttachmentDirectory(), filePath)) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => { });
}

async function removeManagedAttachmentFilesForChat(chatId: string) {
  const rows = getDb().prepare('SELECT path FROM attachments WHERE chatId = ?').all(chatId) as unknown as Array<{ path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
}

async function removeManagedAttachmentFilesForMessage(messageId: string) {
  const rows = getDb().prepare('SELECT path FROM attachments WHERE messageId = ?').all(messageId) as unknown as Array<{ path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
}

async function cleanupStalePendingAttachments() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb().prepare(
    'SELECT id, path FROM attachments WHERE messageId IS NULL AND createdAt < ?',
  ).all(cutoff) as unknown as Array<{ id: string; path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
  const remove = getDb().prepare('DELETE FROM attachments WHERE id = ? AND messageId IS NULL');
  for (const row of rows) {
    remove.run(row.id);
    importedAttachmentIds.delete(row.id);
  }
}

function toAttachmentRef(row: AttachmentRecord): AttachmentRef {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    name: row.name,
    path: row.path,
    mimeType: row.mimeType,
    kind: row.kind,
    size: row.size,
    tokenEstimate: row.tokenEstimate,
    contentPreview: row.textContent ? row.textContent.slice(0, 500) : undefined,
    createdAt: row.createdAt,
  };
}

async function validateKeyBatch(win: BrowserWindow | null, keys: Array<{ key: string; provider?: ProviderType }>) {
  const language = await resolvedUiLanguage();
  const unique = Array.from(new Map(keys.filter((item) => item.key).map((item) => [item.key.trim(), item])).values());
  const results: ValidationResult[] = [];
  const concurrency = 3;
  let index = 0;

  async function worker() {
    while (index < unique.length) {
      const item = unique[index++];
      const provider = item.provider ? item.provider : detectProvider(item.key);
      const result =
        provider === 'unknown'
          ? {
            id: crypto.randomUUID(),
            keyMasked: maskKey(item.key),
            provider: 'unknown' as const,
            status: 'invalid' as const,
            error: localizedText(language, 'Onbekend providerprefix.', 'Unknown provider prefix.'),
          }
          : await adapters[provider].validateCredential(item.key, { language });
      results.push(result);
      win?.webContents.send('keys:validationResult', result);
      win?.webContents.send('keys:validationEvent', result);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function normalizeAgentApprovalMode(mode: unknown): AgentApprovalMode | undefined {
  return AGENT_APPROVAL_MODES.includes(mode as AgentApprovalMode) ? mode as AgentApprovalMode : undefined;
}

async function getAgentConfig(source?: { agentMode?: AgentApprovalMode | null } | string | null): Promise<{ mode: AgentApprovalMode; workingDir: string; toolsEnabled: boolean; defaultShell: AgentShell }> {
  const store = await getStore();
  const storedMode = normalizeAgentApprovalMode(store.get('agent.mode')) || 'ask';
  const workingDir = (store.get('agent.workingDir') as string) || process.cwd();
  const toolsEnabled = store.get('agent.toolsEnabled') === true;
  const storedShell = store.get('agent.defaultShell') as AgentShell;
  const defaultShell = AGENT_SHELLS.includes(storedShell) ? storedShell : 'powershell';
  let chatMode: AgentApprovalMode | undefined;
  if (typeof source === 'string') {
    chatMode = normalizeAgentApprovalMode(getChatById(source)?.agentMode);
  } else if (source) {
    chatMode = normalizeAgentApprovalMode(source.agentMode);
  }
  const mode = chatMode || storedMode;
  return { mode, workingDir, toolsEnabled, defaultShell };
}

async function setAgentConfig(config: { mode?: AgentApprovalMode; workingDir?: string; toolsEnabled?: boolean; defaultShell?: AgentShell }) {
  const store = await getStore();
  const mode = normalizeAgentApprovalMode(config.mode);
  if (mode) store.set('agent.mode', mode);
  if (typeof config.workingDir === 'string') store.set('agent.workingDir', config.workingDir);
  if (typeof config.toolsEnabled === 'boolean') store.set('agent.toolsEnabled', config.toolsEnabled);
  if (config.defaultShell && AGENT_SHELLS.includes(config.defaultShell)) store.set('agent.defaultShell', config.defaultShell);
  return getAgentConfig();
}

// Tool parsing lives in the tested pure module src/components/agent-commands.ts.

function assistantDisplayContentForToolReply(reply: string, language: UiLanguage = 'nl') {
  const toolCalls = parseAgentToolCalls(reply, { includeShellFences: false });
  if (!toolCalls.length) return reply;

  const reads = toolCalls.filter((call) => call.type === 'file-read').length;
  const creates = toolCalls.filter((call) => call.type === 'file-create').length;
  const edits = toolCalls.filter((call) => call.type === 'file-edit').length;
  const commands = toolCalls.filter((call) => call.type === 'command').length;
  const parts = [
    reads ? localizedText(language, `${reads} bestand${reads === 1 ? '' : 'en'} lezen`, `read ${reads} file${reads === 1 ? '' : 's'}`) : '',
    creates ? localizedText(language, `${creates} bestand${creates === 1 ? '' : 'en'} maken`, `create ${creates} file${creates === 1 ? '' : 's'}`) : '',
    edits ? localizedText(language, `${edits} bestand${edits === 1 ? '' : 'en'} aanpassen`, `edit ${edits} file${edits === 1 ? '' : 's'}`) : '',
    commands ? localizedText(language, `${commands} commando${commands === 1 ? '' : "'s"} uitvoeren`, `run ${commands} command${commands === 1 ? '' : 's'}`) : '',
  ].filter(Boolean);
  return parts.length
    ? localizedText(language, `Ik voer de gevraagde toolstappen uit: ${parts.join(', ')}.`, `I am carrying out the requested tool steps: ${parts.join(', ')}.`)
    : localizedText(language, 'Ik voer de gevraagde toolstappen uit.', 'I am carrying out the requested tool steps.');
}

// After an assistant turn, if agent tools are enabled and the reply asked to run
// commands, execute them (gated by approval mode), feed the output back, and let
// the model continue — up to a small cap. Emits chat:refresh so the UI updates.
async function runAgentToolLoop(
  win: BrowserWindow | null,
  chat: Chat,
  modelRef: ModelRef,
  firstReply: string,
  signal: AbortSignal,
  context: { requestId: string; anchorMessageId?: string },
  language: UiLanguage = 'nl',
) {
  const agent = await getAgentConfig(chat);
  const agentToolSystemPrompt = (basePrompt?: string) => [
    basePrompt || '',
    agentToolInstructions(language),
    nativeToolResponseInstructions(language),
    agentToolEnvironmentInstructions(agent.defaultShell, process.platform, language),
  ].filter(Boolean).join('\n');
  const firstTools = parseAgentToolCalls(firstReply, { includeShellFences: false });
  const summary = { provider: modelRef.provider, toolsEnabled: agent.toolsEnabled, mode: agent.mode, toolCallsDetected: firstTools.length, sample: summarizeToolCall(firstTools[0]), replyHead: firstReply.slice(0, 200) };
  console.log('[agent] toolLoop:', summary);
  agentLog('toolLoop', summary);
  if (!agent.toolsEnabled) { agentLog('toolLoop', 'tools DISABLED — enable the checkbox in Settings'); return; }
  // Codex already runs commands natively via its own CLI — don't double-execute.
  if (modelRef.provider === 'codex') { agentLog('toolLoop', 'skipping Codex (runs natively)'); return; }
  let reply = firstReply;
  // Track commands already run this loop so we don't spin re-running a command that keeps
  // failing (the "run run run" loop). Re-running only makes sense after a file change.
  const executedCommands = new Set<string>();
  const successfullyExecutedCommands: string[] = [];
  const changedFilePaths = new Set<string>();
  const originalUserRequest = latestUserToolRequest(getChatMessages(chat.id));
  const seenRoundSignatures = new Set<string>();
  const seenFailureFingerprints = new Set<string>();
  // Hard safety cap on top of the no-progress/failure guards, so a model that emits a fresh
  // (but still broken) tool round every time can never loop forever.
  const MAX_TOOL_ROUNDS = 4;
  const stopHint = localizedText(language, 'Uitvoering gestopt: het model gaf opnieuw dezelfde ongeldige tool-opdracht.', 'Execution stopped: the model repeated the same invalid tool request.');
  for (let round = 0; round < MAX_TOOL_ROUNDS && !signal.aborted; round++) {
    if (signal.aborted) break;
    const toolCalls = parseAgentToolCalls(reply, { includeShellFences: false });
    if (!toolCalls.length) { agentLog('toolLoop', `no-command-detected round=${round}`); break; }
    const loopContext: AgentToolRunContext = {
      chatId: chat.id,
      requestId: context.requestId,
      anchorMessageId: context.anchorMessageId,
      attempt: round + 1,
      agentMode: agent.mode,
      language,
    };
    const loopActivityId = `${context.requestId}-tool-loop`;
    sendToolActivity(win, loopContext, {
      activityId: loopActivityId,
      phase: 'planning',
      label: round === 0
        ? localizedText(language, 'Model plant toolstappen', 'Model is planning tool steps')
        : localizedText(language, 'Model voert volgende toolstap uit', 'Model is carrying out the next tool step'),
      detail: localizedText(language, `Poging ${round + 1}: ${toolCalls.length} toolactie(s).`, `Attempt ${round + 1}: ${toolCalls.length} tool action(s).`),
      tone: 'running',
    });

    // No-progress guard: stop if this round only repeats an already-run command with no
    // file change, OR if the whole round is identical to a previous one (e.g. a no-op
    // file-edit + re-run of the same failing command). Either way it never converges.
    const commandCalls = toolCalls.filter((call): call is Extract<AgentToolCall, { type: 'command' }> => call.type === 'command');
    const roundSignature = agentRoundSignature(toolCalls);
    if (isNoProgressRepeat(toolCalls, executedCommands) || seenRoundSignatures.has(roundSignature)) {
      agentLog('toolLoop', { event: 'stop-no-progress', round, repeatedRound: seenRoundSignatures.has(roundSignature), calls: commandCalls.map((call) => call.command) });
      insertMessage({
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'assistant',
        content: makeToolSummaryErrorContent(stopHint),
        modelId: modelRef.modelId,
        provider: modelRef.provider,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(modelRef.runConfig),
        createdAt: new Date().toISOString(),
      });
      win?.webContents.send('chat:refresh', { chatId: chat.id });
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'stopped',
        label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
        detail: localizedText(language, 'Het model gaf opnieuw dezelfde ongeldige tool-opdracht.', 'The model repeated the same invalid tool request.'),
        stopReason: localizedText(language, 'Geen voortgang.', 'No progress.'),
        tone: 'failed',
      });
      break;
    }
    seenRoundSignatures.add(roundSignature);

    agentLog('toolLoop', { event: 'model-command', round, count: toolCalls.length, calls: toolCalls.map(summarizeToolCall) });

    const toolResults: Array<{ text: string; run?: CommandRun }> = [];
    const projectCwd = await getEffectiveProjectPath(chat);
    const failedFilePathsThisRound = new Set<string>();
    for (const call of toolCalls) {
      try {
        if (call.type === 'command') {
          const commandValidation = validateModelCommand(call.command, language);
          if (!commandValidation.ok) {
            toolResults.push({ text: `run ${call.command}\n[error] ${commandValidation.message || localizedText(language, 'Ongeldig model-command.', 'Invalid model command.')}` });
            continue;
          }
          const skip = shouldSkipCommandForFailedFileTool(call.command, failedFilePathsThisRound, language);
          if (skip.skip) {
            toolResults.push({ text: `run ${call.command}\n[error] ${skip.message}` });
            continue;
          }
        }
        const result = await executeAgentToolCall(win, call, projectCwd, {
          chatId: chat.id,
          requestId: context.requestId,
          anchorMessageId: context.anchorMessageId,
          attempt: round + 1,
          agentMode: agent.mode,
          language,
        });
        toolResults.push(result);
        if (call.type !== 'command' && isFailedFileToolResult(result.text)) {
          const failedPath = fileToolPathFromResult(result.text);
          if (failedPath) failedFilePathsThisRound.add(failedPath);
        }
      } catch (error: any) {
        const text = `${summarizeToolCall(call)}\n[error] ${error?.message || String(error)}`;
        toolResults.push({ text });
        if (call.type !== 'command') {
          const failedPath = fileToolPathFromResult(text) || call.path;
          if (failedPath) failedFilePathsThisRound.add(failedPath.replace(/\\/g, '/').toLowerCase());
        }
      }
    }
    for (const call of commandCalls) executedCommands.add(normalizeAgentCommand(call.command));
    for (const [index, call] of toolCalls.entries()) {
      const toolResult = toolResults[index];
      if (!toolResult || isFailedFileToolResult(toolResult.text) || /\[(?:geweigerd|denied)/i.test(toolResult.text)) continue;
      if (call.type === 'command') {
        if (toolResult.run?.status === 'completed' && (toolResult.run.exitCode === 0 || toolResult.run.exitCode == null)) {
          successfullyExecutedCommands.push(call.command);
        }
      } else if (call.type === 'file-create' || call.type === 'file-edit') {
        changedFilePaths.add(call.path);
      }
    }

    for (const result of toolResults) {
      insertMessage({
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'user',
        content: `Tool output:\n\n${result.text}`,
        modelId: null,
        provider: null,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: null,
        attachments: null,
        runConfig: null,
        toolRun: result.run ? JSON.stringify(result.run) : null,
        createdAt: new Date().toISOString(),
      });
    }
    win?.webContents.send('chat:refresh', { chatId: chat.id });

    sendToolActivity(win, loopContext, {
      activityId: loopActivityId,
      phase: 'sending_output',
      label: localizedText(language, 'Stuurt output terug naar model', 'Sending output back to model'),
      detail: localizedText(language, `${toolResults.length} toolresultaat/resultaten opgeslagen.`, `${toolResults.length} tool result(s) saved.`),
      tone: 'running',
    });

    if (hasDeniedToolResult(toolResults)) {
      agentLog('toolLoop', { event: 'stop-denied', round });
      insertMessage({
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'assistant',
        content: makeToolSummaryErrorContent(localizedText(language, 'Uitvoering gestopt: goedkeuring is geweigerd.', 'Execution stopped: approval was denied.')),
        modelId: modelRef.modelId,
        provider: modelRef.provider,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(modelRef.runConfig),
        createdAt: new Date().toISOString(),
      });
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'stopped',
        label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
        detail: localizedText(language, 'Goedkeuring is geweigerd.', 'Approval was denied.'),
        stopReason: 'approval denied',
        tone: 'denied',
      });
      win?.webContents.send('chat:refresh', { chatId: chat.id });
      break;
    }

    const failedToolResult = hasFailedToolResult(toolResults);
    const successfulCommandRun = hasSuccessfulCommandRun(toolResults);
    if (failedToolResult) {
      const fingerprint = toolFailureFingerprint(toolResults);
      if (isRepeatFailure(seenFailureFingerprints, fingerprint)) {
        agentLog('toolLoop', { event: 'stop-repeat-failure', round, fingerprint: fingerprint.slice(0, 240) });
        insertMessage({
          id: crypto.randomUUID(),
          chatId: chat.id,
          role: 'assistant',
          content: makeToolSummaryErrorContent(stopHint),
          modelId: modelRef.modelId,
          provider: modelRef.provider,
          inputTokens: 0,
          outputTokens: 0,
          fallbackFrom: null,
          attachments: null,
          runConfig: serializeRunConfig(modelRef.runConfig),
          createdAt: new Date().toISOString(),
        });
        win?.webContents.send('chat:refresh', { chatId: chat.id });
        sendToolActivity(win, loopContext, {
          activityId: loopActivityId,
          phase: 'stopped',
          label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
          detail: localizedText(language, 'Het model gaf opnieuw dezelfde ongeldige tool-opdracht.', 'The model repeated the same invalid tool request.'),
          stopReason: 'repeat failure',
          tone: 'failed',
        });
        break;
      }
    }
    const assembled = await assemblePromptContext(chat);
    let result: Awaited<ReturnType<typeof executeWithFallback>>;
    const followMessages = getChatMessages(chat.id);
    try {
      if (failedToolResult) {
        sendToolActivity(win, loopContext, {
          activityId: loopActivityId,
          phase: 'repairing',
          label: localizedText(language, 'Model herstelt fout', 'Model is repairing an error'),
          detail: localizedText(language, 'Echte tool-output is teruggestuurd naar het model.', 'Real tool output was sent back to the model.'),
          tone: 'running',
        });
        followMessages.push({ role: 'user', content: buildToolFailureRepairPrompt(toolResults, language) });
        agentLog('toolLoop', { event: 'failure-repair-request', round, results: toolResults.map((item) => item.run ? { command: item.run.command, status: item.run.status, exitCode: item.run.exitCode } : { text: item.text.slice(0, 120) }) });
      } else {
        sendToolActivity(win, loopContext, {
          activityId: loopActivityId,
          phase: 'summarizing',
          label: localizedText(language, 'Model controleert resultaat', 'Model is checking the result'),
          detail: localizedText(language, 'Het model controleert of de volledige opdracht aantoonbaar is afgerond.', 'The model is checking whether the full task is demonstrably complete.'),
          tone: 'running',
        });
        const missingExecutionPaths = missingRequestedFileExecutions(
          originalUserRequest,
          changedFilePaths,
          successfullyExecutedCommands,
        );
        const verifiedAllRequestedExecutions = requestRequiresEveryFileExecution(originalUserRequest)
          && changedFilePaths.size > 0
          && successfullyExecutedCommands.length > 0
          && missingExecutionPaths.length === 0;
        followMessages.push({
          role: 'user',
          content: buildToolSuccessSummaryPrompt(toolResults, {
            missingExecutionPaths,
            verifiedAllRequestedExecutions,
          }, language),
        });
        agentLog('toolLoop', { event: 'success-completion-check', round, results: toolResults.map((item) => item.run ? { command: item.run.command, status: item.run.status, exitCode: item.run.exitCode } : { text: item.text.slice(0, 120) }) });
      }
      result = await executePostToolFollowup(win, {
        ...toolFollowupRouting(context.requestId),
        initialModelRef: modelRef,
        messages: followMessages,
        systemPrompt: agent.toolsEnabled
          ? agentToolSystemPrompt(assembled.systemPrompt)
          : assembled.systemPrompt,
        attachments: [],
        signal,
        language,
      });
    } catch (error) {
      const classified = classifyProviderError(error, language);
      agentLog('toolLoop-summary-error', { model: `${modelRef.provider}:${modelRef.modelId}`, message: classified.message });
      insertMessage({
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'assistant',
        content: makeToolSummaryErrorContent(classified.message),
        modelId: modelRef.modelId,
        provider: modelRef.provider,
        inputTokens: 0,
        outputTokens: 0,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(modelRef.runConfig),
        createdAt: new Date().toISOString(),
      });
      win?.webContents.send('chat:refresh', { chatId: chat.id });
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'stopped',
        label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
        detail: classified.message,
        stopReason: classified.message,
        tone: 'failed',
      });
      break;
    }
    let nextToolCalls = parseAgentToolCalls(result.text, { includeShellFences: false });
    const malformedToolMarkup = hasUnparsedToolMarkup(result.text);
    if (malformedToolMarkup) {
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'repairing',
        label: localizedText(language, 'Model herstelt tool-opdracht', 'Model is repairing the tool request'),
        detail: localizedText(language, 'De vorige tool-tag was onvolledig en wordt opnieuw in strict formaat gevraagd.', 'The previous tool tag was incomplete and is being requested again in strict format.'),
        tone: 'running',
      });
      try {
        const syntaxRepairResult = await executePostToolFollowup(win, {
          ...toolFollowupRouting(context.requestId),
          initialModelRef: result.modelRef,
          messages: [
            ...followMessages,
            { role: 'assistant', content: result.text },
            { role: 'user', content: buildToolSyntaxRepairPrompt({ badReply: result.text, completedResults: toolResults }, language) },
          ],
          systemPrompt: agent.toolsEnabled
            ? agentToolSystemPrompt(assembled.systemPrompt)
            : assembled.systemPrompt,
          attachments: [],
          signal,
          language,
        });
        const repairedTools = parseAgentToolCalls(syntaxRepairResult.text, { includeShellFences: false });
        if (isNoToolsReply(syntaxRepairResult.text) || !repairedTools.length || hasUnparsedToolMarkup(syntaxRepairResult.text)) {
          const message = localizedText(language, 'Uitvoering niet afgerond: het model gaf opnieuw geen geldige tool-opdracht.', 'Execution not completed: the model again provided no valid tool request.');
          insertMessage({
            id: crypto.randomUUID(), chatId: chat.id, role: 'assistant',
            content: makeToolSummaryErrorContent(message), modelId: syntaxRepairResult.modelRef.modelId,
            provider: syntaxRepairResult.modelRef.provider, inputTokens: syntaxRepairResult.usage.inputTokens,
            outputTokens: syntaxRepairResult.usage.outputTokens, fallbackFrom: null, attachments: null,
            runConfig: serializeRunConfig(syntaxRepairResult.modelRef.runConfig), createdAt: new Date().toISOString(),
          });
          win?.webContents.send('chat:refresh', { chatId: chat.id });
          sendToolActivity(win, loopContext, {
            activityId: loopActivityId, phase: 'stopped', label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
            detail: message, stopReason: 'malformed tool markup', tone: 'failed',
          });
          break;
        }
        result = {
          ...syntaxRepairResult,
          usage: sumUsage(result.usage, syntaxRepairResult.usage),
          fallbackFrom: result.fallbackFrom || syntaxRepairResult.fallbackFrom,
        };
        nextToolCalls = repairedTools;
      } catch (error) {
        const classified = classifyProviderError(error, language);
        const message = localizedText(language, `Tool-opdracht herstellen mislukt: ${classified.message}`, `Repairing the tool request failed: ${classified.message}`);
        insertMessage({
          id: crypto.randomUUID(), chatId: chat.id, role: 'assistant',
          content: makeToolSummaryErrorContent(message), modelId: result.modelRef.modelId,
          provider: result.modelRef.provider, inputTokens: 0, outputTokens: 0,
          fallbackFrom: null, attachments: null, runConfig: serializeRunConfig(result.modelRef.runConfig),
          createdAt: new Date().toISOString(),
        });
        win?.webContents.send('chat:refresh', { chatId: chat.id });
        sendToolActivity(win, loopContext, {
          activityId: loopActivityId, phase: 'stopped', label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
          detail: message, stopReason: classified.message, tone: 'failed',
        });
        break;
      }
    }
    if (failedToolResult && (isNoFixReply(result.text) || !nextToolCalls.length)) {
      const message = isNoFixReply(result.text)
        ? localizedText(language, 'Uitvoering niet afgerond: het model gaf aan geen veilige fix te kunnen maken.', 'Execution not completed: the model said it could not make a safe fix.')
        : localizedText(language, 'Uitvoering niet afgerond: het model gaf geen geldige fix-opdracht.', 'Execution not completed: the model did not provide a valid fix request.');
      agentLog('toolLoop', { event: 'failure-repair-missing-tags', round, replyHead: result.text.slice(0, 240) });
      const repairFailureMessage: Message = {
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'assistant',
        content: makeToolSummaryErrorContent(message),
        modelId: result.modelRef.modelId,
        provider: result.modelRef.provider,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(result.modelRef.runConfig),
        createdAt: new Date().toISOString(),
      };
      insertMessage(repairFailureMessage);
      recordUsage(chat.id, repairFailureMessage.id, result.modelRef, result.usage);
      sendUsageUpdate(win, chat.id);
      win?.webContents.send('chat:refresh', { chatId: chat.id });
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'stopped',
        label: localizedText(language, 'Uitvoering gestopt', 'Execution stopped'),
        detail: message,
        stopReason: message,
        tone: 'failed',
      });
      break;
    }
    const continuation = decideAgentToolLoopContinuation(round, MAX_TOOL_ROUNDS, nextToolCalls);
    if (continuation.action === 'stop-limit') {
      agentLog('toolLoop', {
        event: 'stop-tool-round-limit',
        round,
        count: continuation.pendingCount,
        calls: nextToolCalls.map(summarizeToolCall),
      });
      const continuationMessage = localizedText(language,
        continuation.message,
        `Execution stopped after ${MAX_TOOL_ROUNDS} tool rounds with ${continuation.pendingCount} pending tool action(s).`);
      const limitMessage: Message = {
        id: crypto.randomUUID(),
        chatId: chat.id,
        role: 'assistant',
        content: makeToolSummaryErrorContent(continuationMessage),
        modelId: result.modelRef.modelId,
        provider: result.modelRef.provider,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        fallbackFrom: null,
        attachments: null,
        runConfig: serializeRunConfig(result.modelRef.runConfig),
        createdAt: new Date().toISOString(),
      };
      insertMessage(limitMessage);
      recordUsage(chat.id, limitMessage.id, result.modelRef, result.usage);
      sendUsageUpdate(win, chat.id);
      win?.webContents.send('chat:refresh', { chatId: chat.id });
      sendToolActivity(win, loopContext, {
        activityId: loopActivityId,
        phase: 'stopped',
        label: localizedText(language, 'Veiligheidsgrens bereikt', 'Safety limit reached'),
        detail: continuationMessage,
        stopReason: 'tool round limit',
        tone: 'failed',
      });
      break;
    }
    if (continuation.action === 'continue') {
      agentLog('toolLoop', { event: 'internal-repair-tools', round, count: nextToolCalls.length, calls: nextToolCalls.map(summarizeToolCall) });
      reply = result.text;
      continue;
    }
    const followMessage: Message = {
      id: crypto.randomUUID(),
      chatId: chat.id,
      role: 'assistant',
      content: successfulCommandRun
        ? compactToolSummaryForDisplay(assistantDisplayContentForToolReply(result.text, language), 1_800, language)
        : assistantDisplayContentForToolReply(result.text, language),
      modelId: result.modelRef.modelId,
      provider: result.modelRef.provider,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      fallbackFrom: null,
      attachments: null,
      runConfig: serializeRunConfig(result.modelRef.runConfig),
      createdAt: new Date().toISOString(),
    };
    insertMessage(followMessage);
    recordUsage(chat.id, followMessage.id, result.modelRef, result.usage);
    sendUsageUpdate(win, chat.id);
    win?.webContents.send('chat:refresh', { chatId: chat.id });
    sendToolActivity(win, loopContext, {
      activityId: loopActivityId,
      phase: 'done',
      label: localizedText(language, 'Klaar', 'Done'),
      detail: localizedText(language, 'Tool-output is verwerkt door het model.', 'Tool output was processed by the model.'),
      tone: 'ok',
    });
    reply = result.text;
  }
}

async function executeAgentToolCall(
  win: BrowserWindow | null,
  call: AgentToolCall,
  projectCwd?: string,
  context?: AgentToolRunContext,
): Promise<{ text: string; run?: CommandRun }> {
  const language = context?.language || 'nl';
  if (call.type === 'command') {
    const res = await runAgentCommand(win, call.command, {
      cwd: projectCwd,
      shell: call.shell,
      source: 'model',
      anchorMessageId: context?.anchorMessageId,
      callbacks: context ? createToolRunCallbacks(win, context) : undefined,
      toolContext: context,
      silentApproval: context?.silentApproval,
    });
    const body = res.denied
      ? localizedText(language, '[geweigerd door gebruiker]', '[denied by user]')
      : [res.stdout, res.stderr].filter(Boolean).join('\n') || `[exit ${res.code}]`;
    return { text: `$ ${res.run?.command || call.command}\n${body}`, run: res.run };
  }

  const config = await getAgentConfig(context);
  const root = projectCwd && fs.existsSync(projectCwd) ? projectCwd : (config.workingDir && fs.existsSync(config.workingDir) ? config.workingDir : process.cwd());
  if (call.type === 'file-read') {
    return executeAgentFileRead(win, call, root, context);
  }
  const normalized = normalizeFileToolPayload(call, language);
  const normalizedCall = normalized.call;
  const target = resolveProjectFilePath(root, normalizedCall.path, language);
  const label = normalizedCall.type === 'file-create' ? `file-create ${normalizedCall.path}` : `file-edit ${normalizedCall.path}`;
  const normalizationNote = normalized.changed && normalized.message ? `[normalized] ${normalized.message}\n` : '';
  const validation = validateFileToolPayload(normalizedCall, language);
  // Keep the marker: downstream repair/skip logic relies on it and sends this
  // exact tool output back to the model for the next repair turn.
  if (!validation.ok) return { text: `${label}\n[invalid file payload] ${validation.message || localizedText(language, 'Ongeldige file-tool inhoud.', 'Invalid file-tool contents.')}` };
  const approved = await requestAgentApproval(win, label, root, {
    kind: normalizedCall.type,
    label: normalizedCall.type === 'file-create'
      ? localizedText(language, 'Bestand maken', 'Create file')
      : localizedText(language, 'Bestand wijzigen', 'Edit file'),
    path: normalizedCall.path,
    context,
    activityId: `${context?.requestId || 'file'}-${normalizedCall.type}-${normalizedCall.path}`,
    silent: context?.silentApproval,
  });
  if (!approved) return { text: `${label}\n${localizedText(language, '[geweigerd door gebruiker]', '[denied by user]')}` };
  context?.onFileMutationApproved?.(normalizedCall, root);

  if (normalizedCall.type === 'file-create') {
    await assertRealPathInsideRoot(root, target, true);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await assertRealPathInsideRoot(root, path.dirname(target), false);
    try {
      await fs.promises.writeFile(target, normalizedCall.content, { encoding: 'utf8', flag: normalizedCall.overwrite ? 'w' : 'wx' });
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        const current = await fs.promises.readFile(target, 'utf8').catch(() => null);
        if (current === normalizedCall.content) {
          return { text: `${label}\n${normalizationNote}${fileUnchangedDetail(path.relative(root, target), normalizedCall.content.length, language)}${formatFileToolContentPreview(normalizedCall.path, normalizedCall.content, language)}` };
        }
        return { text: `${label}\n${localizedText(language, '[geen wijziging] Bestand bestaat al. Gebruik overwrite="true" als overschrijven bedoeld is.', '[no change] File already exists. Use overwrite="true" when overwriting is intended.')}` };
      }
      throw error;
    }
    return { text: `${label}\n${normalizationNote}${fileCreatedDetail(path.relative(root, target), normalizedCall.content.length, language)}${formatFileToolContentPreview(normalizedCall.path, normalizedCall.content, language)}` };
  }

  await assertRealPathInsideRoot(root, target, false);
  const current = await fs.promises.readFile(target, 'utf8');
  if (!current.includes(normalizedCall.oldText)) return { text: `${label}\n${localizedText(language, '[geen wijziging] old= tekst niet gevonden', '[no change] old= text not found')}` };
  const next = normalizedCall.replaceAll
    ? current.split(normalizedCall.oldText).join(normalizedCall.newText)
    : current.replace(normalizedCall.oldText, normalizedCall.newText);
  await fs.promises.writeFile(target, next, 'utf8');
  return {
    text: `${label}\n${normalizationNote}${fileEditedDetail(path.relative(root, target), next.length - current.length, language)}${formatFileToolEditDiff(normalizedCall.oldText, normalizedCall.newText, language)}${formatFileToolContentPreview(normalizedCall.path, next, language)}`,
  };
}

function formatFileToolContentPreview(filePath: string, content: string, language: UiLanguage = 'nl') {
  const ext = path.extname(filePath).toLowerCase();
  const textLike = new Set([
    '.bat', '.cmd', '.ps1', '.py', '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css',
    '.md', '.txt', '.yml', '.yaml', '.toml', '.xml', '.csv', '.env', '.gitignore',
  ]);
  const basename = path.basename(filePath).toLowerCase();
  if (!textLike.has(ext) && !['dockerfile', 'makefile'].includes(basename)) return '';
  const normalized = content.replace(/^\uFEFF/, '');
  const maxChars = 8000;
  const truncated = normalized.length > maxChars;
  const preview = truncated
    ? `${normalized.slice(0, maxChars)}\n... ${localizedText(language, `[afgekapt: ${normalized.length - maxChars} chars extra]`, `[truncated: ${normalized.length - maxChars} extra chars]`)}`
    : normalized;
  return `\n\n--- ${localizedText(language, 'bestandsinhoud', 'file contents')} ---\n${preview}`;
}

function formatFileToolEditDiff(oldText: string, newText: string, language: UiLanguage = 'nl') {
  const oldLines = splitPreviewLines(oldText);
  const newLines = splitPreviewLines(newText);
  const maxLines = 240;
  const lines = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  const truncated = lines.length > maxLines;
  const preview = truncated
    ? [...lines.slice(0, maxLines), ` ... ${localizedText(language, `[afgekapt: ${lines.length - maxLines} diffregels extra]`, `[truncated: ${lines.length - maxLines} extra diff lines]`)}`]
    : lines;
  return preview.length ? `\n\n--- ${localizedText(language, 'wijziging', 'change')} ---\n${preview.join('\n')}` : '';
}

function splitPreviewLines(text: string) {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  if (!normalized) return [''];
  return normalized.split('\n');
}

async function executeAgentFileRead(
  win: BrowserWindow | null,
  call: Extract<AgentToolCall, { type: 'file-read' }>,
  root: string,
  context?: AgentToolRunContext,
): Promise<{ text: string }> {
  const language = context?.language || 'nl';
  const target = resolveProjectFilePath(root, call.path, language);
  const label = `file-read ${call.path}`;
  const approved = await requestAgentApproval(win, label, root, {
    kind: 'file-read',
    label: localizedText(language, 'Bestand lezen', 'Read file'),
    path: call.path,
    context,
    activityId: `${context?.requestId || 'file'}-file-read-${call.path}`,
    silent: context?.silentApproval,
  });
  if (!approved) return { text: `${label}\n${localizedText(language, '[geweigerd door gebruiker]', '[denied by user]')}` };

  await assertRealPathInsideRoot(root, target, false);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) return { text: `${label}\n[error] ${localizedText(language, 'Pad is geen bestand.', 'Path is not a file.')}` };
  if (stat.size > FILE_READ_TOOL_MAX_BYTES) {
    return { text: `${label}\n[error] ${localizedText(language, `Bestand is te groot om direct in de chat te lezen (${formatBytes(stat.size)}). Upload het bestand als bijlage of lees een kleiner bestand.`, `File is too large to read directly in chat (${formatBytes(stat.size)}). Upload it as an attachment or read a smaller file.`)}` };
  }

  const buffer = await fs.promises.readFile(target);
  if (looksLikeBinary(buffer)) {
    return { text: `${label}\n[error] ${localizedText(language, 'Bestand lijkt binair. Upload het bestand als bijlage als je wilt dat het model het verwerkt.', 'File appears to be binary. Upload it as an attachment if you want the model to process it.')}` };
  }

  const content = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return {
    text: `${label}\n${fileReadDetail(path.relative(root, target), content.length, language)}${formatFileToolContentPreview(call.path, content, language)}`,
  };
}

function looksLikeBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return true;
  const decoded = sample.toString('utf8');
  if (!decoded) return false;
  const replacementCount = [...decoded].filter((char) => char === '\uFFFD').length;
  return replacementCount > Math.max(4, decoded.length * 0.02);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function executePostToolFollowup(
  win: BrowserWindow | null,
  options: {
    requestId: string;
    initialModelRef: ModelRef;
    messages: ChatMessage[];
    systemPrompt?: string;
    attachments: AttachmentRecord[];
    signal: AbortSignal;
    suppressDeltas?: boolean;
    language: UiLanguage;
  },
) {
  const chatgptSubscription = isChatGptSubscriptionModel(options.initialModelRef);
  let timedOut = false;
  const timeout = chatgptSubscription
    ? linkedTimeoutSignal(options.signal, 25_000, () => {
      timedOut = true;
      agentLog('chatgpt-summary-timeout', 'ChatGPT follow-up duurde langer dan 25s; websessie blijft warm voor recovery.');
    })
    : null;
  try {
    return await executeWithFallback(win, {
      ...options,
      signal: timeout?.signal || options.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new ProviderRuntimeError(localizedText(options.language, 'Samenvatting overgeslagen: ChatGPT web-engine reageerde niet snel genoeg. De tool-uitvoer staat hierboven.', 'Summary skipped: the ChatGPT web engine did not respond quickly enough. The tool output is shown above.'), 'provider_error');
    }
    const message = (error as any)?.message || String(error);
    if (!chatgptSubscription || !/composer|web-engine|geen antwoord|stream/i.test(message)) throw error;

    agentLog('chatgpt-summary-skipped', message.slice(0, 400));
    throw new ProviderRuntimeError(localizedText(options.language, `Samenvatting overgeslagen: ${message}`, `Summary skipped: ${message}`), 'provider_error');
  } finally {
    timeout?.dispose();
  }
}

async function requestAgentApproval(
  win: BrowserWindow | null,
  command: string,
  cwd: string,
  options: {
    kind?: AgentApprovalKind;
    label?: string;
    shell?: AgentShell;
    path?: string;
    paths?: string[];
    context?: AgentToolRunContext;
    activityId?: string;
    // Popup + modus-logica behouden, maar GEEN activiteit-feed schrijven. Gebruikt door
    // native providerbeurten, waar tool-output apart als kaart onder het antwoord komt.
    silent?: boolean;
  } = {},
) {
  const config = await getAgentConfig(options.context);
  const language = options.context?.language || 'nl';
  // Een vrij shellcommando kan vanuit de juiste cwd alsnog absolute paden buiten
  // het project benaderen. Auto-project geldt daarom alleen voor bestandstools
  // waarvan het canonieke doelpad aantoonbaar binnen de root blijft.
  const requestedPaths = (options.paths?.length ? options.paths : options.path ? [options.path] : [])
    .filter((value): value is string => typeof value === 'string' && !!value.trim());
  const pathChecks = await Promise.all(requestedPaths.map((requestedPath) => isRealPathInsideRoot(cwd, requestedPath, true)));
  const allPathsInsideRoot = requestedPaths.length > 0 && pathChecks.every(Boolean);
  const autoProjectPathAllowed = canAutoApproveAgentAction(config.mode, options.kind, allPathsInsideRoot);
  if (config.mode === 'full' || autoProjectPathAllowed) {
    // Auto-approve modes show no popup by design — but surface it in the activity feed so the
    // user can SEE why nothing was asked (transparency: the chosen mode is in effect).
    if (win && !win.isDestroyed() && options.context && !options.silent) {
      const modeLabel = config.mode === 'full'
        ? localizedText(language, 'Volledige toegang', 'Full access')
        : localizedText(language, 'Auto in werkmap', 'Auto in workspace');
      sendToolActivity(win, options.context, {
        activityId: options.activityId || `approval-${crypto.randomUUID()}`,
        phase: 'approval_approved',
        label: localizedText(
          language,
          `Automatisch goedgekeurd (${modeLabel}): ${options.label || approvalLabelForKind(options.kind || 'command', language)}`,
          `Automatically approved (${modeLabel}): ${options.label || approvalLabelForKind(options.kind || 'command', language)}`,
        ),
        detail: command,
        approvalStatus: 'approved',
        tone: 'ok',
      });
    }
    return true;
  }
  if (!win || win.isDestroyed()) return false;
  const id = crypto.randomUUID();
  const kind = options.kind || 'command';
  const label = options.label || approvalLabelForKind(kind, language);
  const activityId = options.activityId || `approval-${id}`;
  agentLog('toolApproval', `requesting approval ${id} (hasWin=${!!win})`);
  if (!options.silent) {
    sendToolActivity(win, options.context, {
      activityId,
      phase: 'approval_pending',
      label: localizedText(language, `Wacht op goedkeuring: ${label}`, `Waiting for approval: ${label}`),
      detail: command,
      approvalStatus: 'pending',
      tone: 'running',
    });
  }
  return new Promise<boolean>((resolve) => {
    const approvalRequest = {
      id,
      command,
      cwd,
      shell: options.shell,
      kind,
      label,
      path: options.path,
      chatId: options.context?.chatId,
      requestId: options.context?.requestId,
    };
    const handleWindowClosed = () => {
      const pending = pendingAgentApprovals.get(id);
      if (!pending) return;
      pendingAgentApprovals.delete(id);
      pending.resolve(false, 'window_closed');
    };
    pendingAgentApprovals.set(id, {
      ownerId: win.webContents.id,
      requestId: options.context?.requestId,
      chatId: options.context?.chatId,
      request: approvalRequest,
      resolve: (approved, reason = 'answered') => {
        if (!win.webContents.isDestroyed()) win.webContents.removeListener('destroyed', handleWindowClosed);
        if (!options.silent) {
          sendToolActivity(win, options.context, {
            activityId,
            phase: approved ? 'approval_approved' : 'approval_denied',
            label: approved
              ? localizedText(language, `Goedgekeurd: ${label}`, `Approved: ${label}`)
              : reason === 'cancelled'
                ? localizedText(language, `Gestopt: ${label}`, `Stopped: ${label}`)
                : localizedText(language, `Geweigerd: ${label}`, `Denied: ${label}`),
            detail: reason === 'cancelled'
              ? localizedText(language, 'De beurt is gestopt voordat toestemming werd gegeven.', 'The turn was stopped before permission was granted.')
              : command,
            approvalStatus: approved ? 'approved' : 'denied',
            tone: approved ? 'ok' : 'denied',
          });
        }
        if (!win.webContents.isDestroyed()) {
          win.webContents.send('agent:approvalResolved', { id, approved, reason });
        }
        resolve(approved);
      }
    });
    win.webContents.once('destroyed', handleWindowClosed);
    win.webContents.send('agent:approvalRequest', approvalRequest);
  });
}

function approvalLabelForKind(kind: AgentApprovalKind, language: UiLanguage = 'nl') {
  if (kind === 'file-read') return localizedText(language, 'Bestand lezen', 'Read file');
  if (kind === 'file-create') return localizedText(language, 'Bestand maken', 'Create file');
  if (kind === 'file-edit') return localizedText(language, 'Bestand wijzigen', 'Edit file');
  return localizedText(language, 'Commando uitvoeren', 'Run command');
}

// Vertaal provider-eigen toolnamen naar de app-approval (kind + label + pad), zodat
// Claude, Codex, Gemini, Antigravity en Ollama exact dezelfde popup gebruiken.
function describeNativeTool(
  toolName: string,
  input: Record<string, unknown>,
  language: UiLanguage = 'nl',
): { kind: AgentApprovalKind; label: string; command: string; path?: string; paths?: string[] } {
  const filePaths = Array.isArray(input.file_paths)
    ? input.file_paths.filter((value): value is string => typeof value === 'string' && !!value.trim())
    : [];
  const filePath = typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
      : typeof input.notebook_path === 'string' ? input.notebook_path
        : typeof input.TargetFile === 'string' ? unquoteNativeValue(input.TargetFile)
          : typeof input.AbsolutePath === 'string' ? unquoteNativeValue(input.AbsolutePath)
            : undefined;
  const fallback = typeof input.command === 'string' ? input.command : undefined;
  const normalizedName = toolName.toLowerCase();
  const allFilePaths = filePaths.length ? filePaths : filePath ? [filePath] : [];
  const fileCommand = allFilePaths.length ? allFilePaths.join('\n') : fallback;
  if (['write', 'write_file', 'write_to_file'].includes(normalizedName)) return {
    kind: 'file-create',
    label: localizedText(language, 'Bestand maken/overschrijven', 'Create/overwrite file'),
    command: fileCommand || localizedText(language, 'nieuw bestand', 'new file'),
    path: allFilePaths[0],
    paths: allFilePaths,
  };
  if (['edit', 'multiedit', 'notebookedit', 'edit_file', 'replace_file_content', 'multi_replace_file_content'].includes(normalizedName)) return {
    kind: 'file-edit',
    label: localizedText(language, 'Bestand wijzigen', 'Edit file'),
    command: fileCommand || localizedText(language, 'bestand', 'file'),
    path: allFilePaths[0],
    paths: allFilePaths,
  };
  if (['read', 'glob', 'grep', 'read_file', 'view_file', 'list_dir', 'search'].includes(normalizedName)) return {
    kind: 'file-read',
    label: localizedText(language, 'Lezen/zoeken', 'Read/search'),
    command: fileCommand || String(input.pattern || input.query || ''),
    path: allFilePaths[0],
    paths: allFilePaths,
  };
  if (['bash', 'powershell', 'run_command', 'run_shell_command', 'command'].includes(normalizedName)) return {
    kind: 'command',
    label: localizedText(language, 'Commando uitvoeren', 'Run command'),
    command: typeof input.command === 'string' ? input.command : typeof input.CommandLine === 'string' ? input.CommandLine : toolName,
  };
  return { kind: 'command', label: toolName, command: typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 200) };
}

// Korte doelnaam voor een tool-kaart-titel (bv. "test.py" of een zoek-patroon).
function nativeToolTarget(input: Record<string, unknown>): string {
  const firstFilePath = Array.isArray(input.file_paths)
    ? input.file_paths.find((value): value is string => typeof value === 'string' && !!value.trim())
    : undefined;
  const filePath = firstFilePath || (typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
      : typeof input.notebook_path === 'string' ? input.notebook_path
        : typeof input.TargetFile === 'string' ? unquoteNativeValue(input.TargetFile)
          : typeof input.AbsolutePath === 'string' ? unquoteNativeValue(input.AbsolutePath)
            : '');
  if (filePath) return path.basename(filePath);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  return '';
}

function nativeToolRunMeta(toolName: string, input: Record<string, unknown>): Pick<CommandRun, 'toolKind' | 'toolPath'> {
  const name = toolName.toLowerCase();
  const toolPath = firstNativeString(input, ['path', 'file_path', 'TargetFile', 'AbsolutePath']);
  if (['read_file', 'read', 'view_file'].includes(name)) return { toolKind: 'file-read', toolPath: toolPath || undefined };
  if (['edit_file', 'edit', 'replace_file_content'].includes(name)) return { toolKind: 'file-edit', toolPath: toolPath || undefined };
  if (['write_file', 'write', 'write_to_file'].includes(name)) {
    return { toolKind: input.changes ? 'file-edit' : 'file-create', toolPath: toolPath || undefined };
  }
  if (['run_command', 'run_shell_command', 'bash', 'powershell', 'command'].includes(name)) return { toolKind: 'command' };
  return {};
}

function nativeFileSnapshot(root: string, requestedPath: string): string | null | undefined {
  try {
    if (!requestedPath || !isPathInsideRoot(root, requestedPath)) return undefined;
    const rootPath = fs.realpathSync.native(path.resolve(root));
    const target = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(rootPath, requestedPath);
    if (!fs.existsSync(target)) return null;
    const realTarget = fs.realpathSync.native(target);
    const relative = path.relative(rootPath, realTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const stat = fs.statSync(realTarget);
    if (!stat.isFile() || stat.size > FILE_READ_TOOL_MAX_BYTES) return undefined;
    const buffer = fs.readFileSync(realTarget);
    if (looksLikeBinary(buffer)) return undefined;
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

function rememberApprovedNativeSnapshot(
  snapshots: Map<string, string | null | undefined>,
  root: string,
  requestedPath: string,
) {
  const key = nativeSnapshotKey(root, requestedPath);
  if (!key) return;
  snapshots.set(key, nativeFileSnapshot(root, requestedPath));
}

function takeApprovedNativeSnapshot(
  snapshots: Map<string, string | null | undefined>,
  root: string,
  requestedPath: string,
) {
  const key = nativeSnapshotKey(root, requestedPath);
  if (!key || !snapshots.has(key)) return undefined;
  const snapshot = snapshots.get(key);
  snapshots.delete(key);
  return snapshot;
}

function nativeSnapshotKey(root: string, requestedPath: string) {
  if (!requestedPath || !isPathInsideRoot(root, requestedPath)) return null;
  const resolved = path.resolve(root, requestedPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nativeFileReviewOutput(
  root: string,
  requestedKind: NonNullable<CommandRun['toolKind']>,
  requestedPath: string,
  before: string | null | undefined,
  after: string | null | undefined,
  language: UiLanguage = 'nl',
): { kind: 'file-read' | 'file-create' | 'file-edit'; path: string; output: string } | null {
  if (typeof after !== 'string') return null;
  const absolute = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath);
  const relative = path.relative(path.resolve(root), absolute);
  const displayPath = (!relative.startsWith('..') && !path.isAbsolute(relative) ? relative : path.basename(absolute)).replace(/\\/g, '/');

  if (requestedKind === 'file-read') {
    return {
      kind: 'file-read',
      path: displayPath,
      output: `file-read ${displayPath}\n${fileReadDetail(displayPath, after.length, language)}${formatFileToolContentPreview(displayPath, after, language)}`,
    };
  }
  if (before === undefined) return null;

  const kind = before === null ? 'file-create' : 'file-edit';
  const original = before || '';
  const diff = changedLineDiff(original, after, 240, language);
  if (!diff.length) {
    return {
      kind,
      path: displayPath,
      output: `${kind} ${displayPath}\n${fileUnchangedDetail(displayPath, after.length, language)}`,
    };
  }
  const delta = after.length - original.length;
  const detail = kind === 'file-create'
    ? fileCreatedDetail(displayPath, after.length, language)
    : fileEditedDetail(displayPath, delta, language);
  const diffText = diff.map((line) => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`).join('\n');
  return {
    kind,
    path: displayPath,
    output: `${kind} ${displayPath}\n${detail}\n\n--- ${localizedText(language, 'wijziging', 'change')} ---\n${diffText}`,
  };
}

function isPathInsideRoot(root: string, requestedPath: string): boolean {
  const rootPath = path.resolve(root);
  const target = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootPath, requestedPath);
  const relative = path.relative(rootPath, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function unquoteNativeValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  return trimmed;
}

function nativeToolCallFrom(toolName: string, input: Record<string, unknown>, language: UiLanguage = 'nl'): AgentToolCall {
  const name = toolName.toLowerCase();
  const filePath = firstNativeString(input, ['path', 'file_path', 'TargetFile', 'AbsolutePath']);
  if (['read_file', 'read', 'view_file'].includes(name)) {
    if (!filePath) throw new Error(localizedText(language, 'Native read_file mist een pad.', 'Native read_file is missing a path.'));
    return { type: 'file-read', path: filePath };
  }
  if (['write_file', 'write', 'write_to_file'].includes(name)) {
    if (!filePath) throw new Error(localizedText(language, 'Native write_file mist een pad.', 'Native write_file is missing a path.'));
    return {
      type: 'file-create',
      path: filePath,
      content: firstNativeString(input, ['content', 'CodeContent']) || '',
      overwrite: nativeBoolean(input.overwrite ?? input.Overwrite, true),
    };
  }
  if (['edit_file', 'edit', 'replace_file_content'].includes(name)) {
    if (!filePath) throw new Error(localizedText(language, 'Native edit_file mist een pad.', 'Native edit_file is missing a path.'));
    return {
      type: 'file-edit',
      path: filePath,
      oldText: firstNativeString(input, ['old_text', 'oldText', 'TargetContent']) || '',
      newText: firstNativeString(input, ['new_text', 'newText', 'ReplacementContent']) || '',
      replaceAll: nativeBoolean(input.replace_all ?? input.replaceAll ?? input.AllowMultiple, false),
    };
  }
  if (['run_command', 'run_shell_command', 'bash', 'powershell', 'command'].includes(name)) {
    const command = firstNativeString(input, ['command', 'CommandLine']);
    if (!command) throw new Error(localizedText(language, 'Native run_command mist een commando.', 'Native run_command is missing a command.'));
    const shellValue = firstNativeString(input, ['shell']).toLowerCase();
    const shell = AGENT_SHELLS.includes(shellValue as AgentShell) ? shellValue as AgentShell : undefined;
    return { type: 'command', command, shell };
  }
  throw new Error(localizedText(language, `Onbekende native tool: ${toolName}`, `Unknown native tool: ${toolName}`));
}

function firstNativeString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return unquoteNativeValue(value);
  }
  return '';
}

function nativeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = unquoteNativeValue(value).toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function resolveProjectFilePath(root: string, requestedPath: string, language: UiLanguage = 'nl') {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, requestedPath);
  const rel = path.relative(rootPath, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(localizedText(language, `Bestand valt buiten de projectmap/werkmap: ${requestedPath}`, `File is outside the project/workspace folder: ${requestedPath}`));
  }
  return target;
}

function summarizeToolCall(call?: AgentToolCall) {
  if (!call) return '(none)';
  if (call.type === 'command') return `run:${call.command.slice(0, 80)}`;
  return `${call.type}:${call.path}`;
}

function hasDeniedToolResult(results: Array<{ text: string; run?: CommandRun }>) {
  return results.some((result) => result.run?.status === 'denied' || /\[(?:geweigerd|denied)|(?:geweigerd door gebruiker|denied by user)/i.test(result.text || ''));
}

function sendToolActivity(
  win: BrowserWindow | null,
  context: AgentToolRunContext | undefined,
  data: {
    activityId: string;
    phase: NonNullable<ChatStreamEvent['phase']>;
    label: string;
    detail?: string;
    approvalStatus?: ChatStreamEvent['approvalStatus'];
    stopReason?: string;
    tone?: ChatStreamEvent['tone'];
    attempt?: number;
  },
) {
  if (!context) return;
  sendStreamEvent(win, {
    requestId: context.requestId,
    type: 'tool_activity',
    chatId: context.chatId,
    anchorMessageId: context.anchorMessageId,
    activityId: data.activityId,
    phase: data.phase,
    label: data.label,
    detail: data.detail,
    approvalStatus: data.approvalStatus,
    stopReason: data.stopReason,
    tone: data.tone,
    attempt: data.attempt ?? context.attempt,
  });
}

function createToolRunCallbacks(win: BrowserWindow | null, context: AgentToolRunContext): AgentCommandCallbacks {
  return {
    onStart: (run) => sendStreamEvent(win, {
      requestId: context.requestId,
      type: 'tool_run_started',
      chatId: context.chatId,
      runId: run.id,
      anchorMessageId: context.anchorMessageId,
      run,
    }),
    onOutput: (runId, stream, delta) => sendStreamEvent(win, {
      requestId: context.requestId,
      type: 'tool_run_output',
      chatId: context.chatId,
      runId,
      anchorMessageId: context.anchorMessageId,
      stream,
      delta,
    }),
    onFinish: (run) => sendStreamEvent(win, {
      requestId: context.requestId,
      type: 'tool_run_finished',
      chatId: context.chatId,
      runId: run.id,
      anchorMessageId: context.anchorMessageId,
      run,
    }),
  };
}

// Run a shell command on the user's PC, gated by the chosen approval mode:
//  - 'ask'          → ask the renderer for per-command approval
//  - 'auto-project' → auto-approve (runs inside the configured working dir)
//  - 'full'         → auto-approve everything
async function runAgentCommand(
  win: BrowserWindow | null,
  command: string,
  options: { cwd?: string; shell?: AgentShell; source?: CommandRun['source']; anchorMessageId?: string; callbacks?: AgentCommandCallbacks; toolContext?: AgentToolRunContext; silentApproval?: boolean } = {},
): Promise<AgentCommandResult> {
  const language = options.toolContext?.language || 'nl';
  if (!command.trim()) return { ok: false, error: localizedText(language, 'Leeg commando.', 'Empty command.'), stdout: '', stderr: '', code: null, cwd: process.cwd(), shell: 'powershell' };
  const config = await getAgentConfig(options.toolContext);
  const requestedCwd = options.cwd || config.workingDir;
  const cwd = requestedCwd && fs.existsSync(requestedCwd) ? requestedCwd : process.cwd();
  const shell = availableAgentShell(normalizeAgentShell(options.shell || config.defaultShell));
  const runnableCommand = normalizeCommandForShell(command, shell, cwd);
  const source = options.source || 'model';
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const baseRun: CommandRun = {
    id: crypto.randomUUID(),
    source,
    command: runnableCommand,
    shell,
    cwd,
    status: 'running',
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    anchorMessageId: options.anchorMessageId || null,
  };
  agentLog('runCommand', { mode: config.mode, hasWin: !!win, source, shell, command: runnableCommand.slice(0, 120), requested: command.slice(0, 120) });

  if (config.mode === 'ask') {
    const approved = await requestAgentApproval(win, runnableCommand, cwd, {
      kind: 'command',
      label: localizedText(language, 'Commando uitvoeren', 'Run command'),
      shell,
      context: options.toolContext,
      activityId: baseRun.id,
      silent: options.silentApproval,
    });
    if (!approved) {
      const run = finishCommandRun(baseRun, 'denied', '', localizedText(language, 'Geweigerd door gebruiker.', 'Denied by the user.'), null, startedMs);
      options.callbacks?.onFinish?.(run);
      return { ok: false, error: run.stderr, denied: true, stdout: '', stderr: run.stderr, code: null, cwd, shell, run };
    }
  }

  const spec = agentShellSpawnSpec(shell, runnableCommand);
  return new Promise<AgentCommandResult>((resolve) => {
    options.callbacks?.onStart?.(baseRun);
    const child = spawn(spec.command, spec.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      env: agentCommandEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const finish = (status: CommandRun['status'], code: number | null, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const clippedStdout = stdout.slice(0, 100000);
      const clippedStderr = (stderr + extraStderr).slice(0, 100000);
      const run = finishCommandRun(baseRun, status, clippedStdout, clippedStderr, code, startedMs);
      options.callbacks?.onFinish?.(run);
      resolve({ ok: status === 'completed' && code === 0, stdout: clippedStdout, stderr: clippedStderr, code, cwd, shell, run, error: status === 'failed' ? clippedStderr : undefined });
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish('failed', null, `\n[timeout] ${localizedText(language, `Commando gestopt na ${Math.round(AGENT_COMMAND_TIMEOUT_MS / 1000)}s.`, `Command stopped after ${Math.round(AGENT_COMMAND_TIMEOUT_MS / 1000)}s.`)}`);
    }, AGENT_COMMAND_TIMEOUT_MS);
    child.stdin?.end();
    child.stdout?.on('data', (data) => {
      const text = data.toString();
      if (stdoutTruncated) return;
      const remaining = MAX_COMMAND_OUTPUT_CHARS - stdout.length;
      const accepted = text.slice(0, Math.max(0, remaining));
      stdout += accepted;
      if (accepted) options.callbacks?.onOutput?.(baseRun.id, 'stdout', accepted);
      if (accepted.length < text.length) {
        stdoutTruncated = true;
        const marker = localizedText(language, '\n[uitvoer afgekapt na 100.000 tekens]\n', '\n[output truncated after 100,000 characters]\n');
        options.callbacks?.onOutput?.(baseRun.id, 'stdout', marker);
      }
    });
    child.stderr?.on('data', (data) => {
      const text = data.toString();
      if (stderrTruncated) return;
      const remaining = MAX_COMMAND_OUTPUT_CHARS - stderr.length;
      const accepted = text.slice(0, Math.max(0, remaining));
      stderr += accepted;
      if (accepted) options.callbacks?.onOutput?.(baseRun.id, 'stderr', accepted);
      if (accepted.length < text.length) {
        stderrTruncated = true;
        const marker = localizedText(language, '\n[uitvoer afgekapt na 100.000 tekens]\n', '\n[output truncated after 100,000 characters]\n');
        options.callbacks?.onOutput?.(baseRun.id, 'stderr', marker);
      }
    });
    child.on('close', (code) => {
      finish(code === 0 ? 'completed' : 'failed', code);
    });
    child.on('error', (err) => {
      finish('failed', null, String(err?.message || err));
    });
  });
}

function normalizeAgentShell(shell: AgentShell): AgentShell {
  return AGENT_SHELLS.includes(shell) ? shell : 'powershell';
}

function availableAgentShell(shell: AgentShell): AgentShell {
  if (process.platform !== 'win32' || shell !== 'pwsh') return shell;
  const probe = spawnSync('where.exe', ['pwsh.exe'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return probe.status === 0 ? shell : 'powershell';
}

function normalizeCommandForShell(command: string, shell: AgentShell, cwd: string) {
  const trimmed = normalizePowerShell5ConditionalChain(command, shell);
  if (process.platform !== 'win32' || shell === 'cmd') return trimmed;
  const match = trimmed.match(/^(['"]?)([^'"\s&|;<>]+?\.(?:bat|cmd|ps1|exe))\1(\s+[\s\S]*)?$/i);
  if (!match) return trimmed;

  const script = match[2];
  if (/^(?:\.{1,2}[\\/]|[a-z]:[\\/]|[\\/])/i.test(script)) return trimmed;
  if (script.includes('\\') || script.includes('/')) return trimmed;
  if (!fs.existsSync(path.join(cwd, script))) return trimmed;

  return `.${path.sep}${script}${match[3] || ''}`;
}

function finishCommandRun(base: CommandRun, status: CommandRun['status'], stdout: string, stderr: string, exitCode: number | null, startedMs: number): CommandRun {
  return {
    ...base,
    status,
    stdout,
    stderr,
    exitCode,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
  };
}

async function waitWhileAutoModePaused(runId: string) {
  while (autoModeRunId === runId && !autoModeStopRequested && autoModeState.status === 'paused') {
    await delay(250);
  }
}

async function runAutoModeLoop(win: BrowserWindow | null, config: AutoModeConfig, runId: string) {
  const unlimitedIterations = config.maxIterations <= 0;
  const language = normalizeUiLanguage(config.language, 'nl');
  let completionDetail = localizedText(language, 'Auto Mode is klaar.', 'Auto Mode is complete.');

  while (autoModeRunId === runId && !autoModeStopRequested && (unlimitedIterations || autoModeState.iteration < config.maxIterations)) {
    await waitWhileAutoModePaused(runId);
    if (autoModeRunId !== runId || autoModeStopRequested || autoModeState.status !== 'running') break;
    if (config.tokenBudget && autoModeState.totalTokens >= config.tokenBudget) {
      completionDetail = localizedText(language, 'Auto Mode is klaar: het tokenbudget is bereikt.', 'Auto Mode is complete: the token budget was reached.');
      break;
    }

    const chat = requireChat(config.chatId);
    const nextIteration = autoModeState.iteration + 1;
    const iterationLabel = `${nextIteration}${unlimitedIterations ? '' : `/${config.maxIterations}`}`;
    const prompterRequestId = `auto-prompter-${crypto.randomUUID()}`;
    const messages = getChatMessages(config.chatId);
    const prompter = adapters[config.prompterModelRef.provider];
    const controller = new AbortController();
    activeRequests.set(prompterRequestId, controller);
    autoModeRequestIds.add(prompterRequestId);
    publishAutoModeState(win, {
      phase: 'prompter',
      detail: localizedText(language, `Prompter maakt prompt ${iterationLabel}.`, `Prompter is creating prompt ${iterationLabel}.`),
      lastPromptPreview: '',
      error: undefined,
    });
    const goal = (config.goal || '').trim();
    const prompterSystemPrompt = goal
      ? localizedText(
        language,
        `Je stuurt dit gesprek naar het doel van de gebruiker: "${goal}". Schrijf op basis van het gesprek precies het volgende gebruikersbericht dat de meeste voortgang naar dat doel maakt. Wees concreet en bouw voort op eerdere antwoorden. Geef ALLEEN de prompttekst terug, zonder inleiding.`,
        `You are driving this conversation toward the user's goal: "${goal}". Based on the conversation so far, write the single next user message that makes the most progress toward that goal. Be concrete and build on previous answers. Return ONLY the prompt text, no preamble.`,
      )
      : localizedText(language, 'Genereer de volgende nuttige gebruikersprompt voor dit gesprek. Geef alleen de prompttekst terug.', 'Generate the next useful user prompt for this conversation. Return only the prompt text.');
    let promptResult: AdapterChatResult;
    let promptDraft = '';
    let lastPreviewUpdate = 0;
    try {
      promptResult = await prompter.sendChat({
        modelRef: config.prompterModelRef,
        messages,
        systemPrompt: prompterSystemPrompt,
        attachments: [],
        signal: controller.signal,
        onDelta: (delta) => {
          promptDraft = `${promptDraft}${delta}`.slice(0, 4_000);
          const now = Date.now();
          if (now - lastPreviewUpdate < 150 || autoModeRunId !== runId || autoModeState.status !== 'running') return;
          lastPreviewUpdate = now;
          publishAutoModeState(win, { lastPromptPreview: autoModePromptPreview(promptDraft) });
        },
        language,
      });
    } finally {
      activeRequests.delete(prompterRequestId);
      autoModeRequestIds.delete(prompterRequestId);
    }

    if (autoModeRunId !== runId || autoModeStopRequested) return;
    const promptText = promptResult.text.trim();
    if (!promptText) throw new Error(localizedText(language, 'De prompter gaf een lege prompt terug. Kies een ander promptermodel of probeer opnieuw.', 'The prompter returned an empty prompt. Choose another prompter model or try again.'));
    const promptPreview = autoModePromptPreview(promptText);

    const userMessage = insertMessage({
      id: crypto.randomUUID(),
      chatId: config.chatId,
      role: 'user',
      content: promptText,
      modelId: config.prompterModelRef.modelId,
      provider: config.prompterModelRef.provider,
      inputTokens: promptResult.usage.inputTokens,
      outputTokens: promptResult.usage.outputTokens,
      fallbackFrom: null,
      attachments: null,
      runConfig: serializeRunConfig({
        ...(promptResult.runConfig || config.prompterModelRef.runConfig || {}),
        autoModePrompt: true,
      }),
      createdAt: new Date().toISOString(),
    });
    void generateChatTitleIfNeeded(
      win,
      config.chatId,
      userMessage.content,
      config.responderModelRef,
      language,
    ).catch(() => { });
    win?.webContents.send('chat:refresh', { chatId: config.chatId });
    recordUsage(config.chatId, userMessage.id, config.prompterModelRef, promptResult.usage);
    sendUsageUpdate(win, config.chatId);

    await waitWhileAutoModePaused(runId);
    if (autoModeRunId !== runId || autoModeStopRequested || autoModeState.status !== 'running') return;
    publishAutoModeState(win, {
      phase: 'responder',
      detail: localizedText(language, `Antwoordmodel reageert op prompt ${iterationLabel}.`, `Responder model is answering prompt ${iterationLabel}.`),
      lastPromptPreview: promptPreview,
    });

    const responderRequestId = `auto-responder-${crypto.randomUUID()}`;
    autoModeRequestIds.add(responderRequestId);
    activeRequestChatIds.set(responderRequestId, config.chatId);
    const responderMessage = await runAssistantForExistingChat(win, {
      requestId: responderRequestId,
      chat,
      modelRef: config.responderModelRef,
      language,
    }).finally(() => {
      autoModeRequestIds.delete(responderRequestId);
      activeRequestChatIds.delete(responderRequestId);
    });
    void retryChatTitleAfterTurn(win, config.chatId, userMessage.content, language).catch(() => { });
    win?.webContents.send('chat:refresh', { chatId: config.chatId });
    if (autoModeRunId !== runId || autoModeStopRequested) return;

    const iteration = autoModeState.iteration + 1;
    const totalTokens = autoModeState.totalTokens
      + promptResult.usage.totalTokens
      + Number(responderMessage.inputTokens || 0)
      + Number(responderMessage.outputTokens || 0);
    const hasNextIteration = unlimitedIterations || iteration < config.maxIterations;
    const budgetAvailable = !config.tokenBudget || totalTokens < config.tokenBudget;
    publishAutoModeState(win, {
      iteration,
      totalTokens,
      phase: hasNextIteration && budgetAvailable ? 'waiting' : 'completed',
      detail: hasNextIteration && budgetAvailable
        ? localizedText(
          language,
          `Iteratie ${iteration}${unlimitedIterations ? '' : `/${config.maxIterations}`} klaar. Volgende prompt over ${Math.max(1, Math.round((config.delayMs || 2000) / 1000))} sec.`,
          `Iteration ${iteration}${unlimitedIterations ? '' : `/${config.maxIterations}`} complete. Next prompt in ${Math.max(1, Math.round((config.delayMs || 2000) / 1000))} sec.`,
        )
        : localizedText(language, `Iteratie ${iteration}${unlimitedIterations ? '' : `/${config.maxIterations}`} klaar.`, `Iteration ${iteration}${unlimitedIterations ? '' : `/${config.maxIterations}`} complete.`),
    });
    if (hasNextIteration && budgetAvailable) await delay(config.delayMs || 2000);
  }

  if (autoModeRunId !== runId) return;
  autoModeRunId = null;
  publishAutoModeState(win, {
    status: autoModeStopRequested ? 'stopped' : 'idle',
    phase: autoModeStopRequested ? 'stopped' : 'completed',
    detail: autoModeStopRequested ? localizedText(language, 'Auto Mode is gestopt.', 'Auto Mode is stopped.') : completionDetail,
  });
}

function sendStreamEvent(win: BrowserWindow | null, event: ChatStreamEvent) {
  const routedEvent: ChatStreamEvent = event.chatId
    ? event
    : { ...event, chatId: activeRequestChatIds.get(event.requestId) };
  win?.webContents.send('chat:streamEvent', routedEvent);
  if (routedEvent.type === 'delta') {
    win?.webContents.send('chat:streamChunk', { delta: routedEvent.delta || '', done: false });
  }
  if (routedEvent.type === 'done') {
    win?.webContents.send('chat:streamChunk', { delta: '', done: true, usage: routedEvent.usage });
  }
  if (routedEvent.type === 'error') {
    win?.webContents.send('chat:streamChunk', { delta: `\n\nError: ${routedEvent.error}`, done: true });
  }
}

function cancelRequest(requestId?: string) {
  if (requestId) {
    activeRequests.get(requestId)?.abort();
    activeRequests.delete(requestId);
    cancelPendingAgentApprovals(requestId);
    return true;
  }
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
  cancelPendingAgentApprovals();
  return true;
}

function cancelPendingAgentApprovals(requestId?: string) {
  for (const [id, pending] of pendingAgentApprovals) {
    if (requestId && pending.requestId !== requestId) continue;
    pendingAgentApprovals.delete(id);
    pending.resolve(false, 'cancelled');
  }
}

function assertProvider(provider: ProviderType): asserts provider is ProviderType {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
}

function assertString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
}

function validateChatRequest(request: ChatRequest) {
  assertString(request.requestId, 'requestId');
  assertString(request.chatId, 'chatId');
  assertString(request.input, 'input');
  if (!request.modelRef?.provider || !request.modelRef.modelId) throw new Error('modelRef is required.');
  assertProvider(request.modelRef.provider);
}

async function detectChatGptDesktop() {
  return findExecutablePath([
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ChatGPT', 'ChatGPT.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'ChatGPT', 'ChatGPT.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'ChatGPT.exe') : '',
    'ChatGPT.exe',
  ].filter(Boolean));
}

async function readAntigravityStatuslineState() {
  const store = await getStore();
  const configured = store.get('antigravity.statusJsonPath') as string | undefined;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    configured,
    home ? path.join(home, '.gemini', 'antigravity-cli', 'statusline-state.json') : '',
    home ? path.join(home, '.gemini', 'antigravity-cli', 'statusline.json') : '',
    home ? path.join(home, '.gemini', 'antigravity-cli', 'state.json') : '',
  ].filter(Boolean) as string[];

  for (const rawCandidate of candidates) {
    const candidate = expandPath(rawCandidate);
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return {
        email: stringOrUndefined(parsed.email || parsed.account_email || parsed.account?.email),
        plan_tier: stringOrUndefined(parsed.plan_tier || parsed.planTier || parsed.subscription?.tier),
        model: stringOrUndefined(parsed.model || parsed.active_model),
        context_window: numberOrUndefined(parsed.context_window || parsed.contextWindow || parsed.model_context_window),
      };
    } catch {
      // Ignore unreadable optional statusline state.
    }
  }

  return null;
}

function expandPath(value: string) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, process.env.APPDATA || '');
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function detectProvider(key: string): ProviderType | 'unknown' {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  if (key.startsWith('AI')) return 'google';
  return 'unknown';
}

function maskKey(key: string) {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function mimeFromExt(ext: string) {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.html': 'text/html',
    '.css': 'text/css',
  };
  return map[ext] || 'application/octet-stream';
}

function kindFromExt(ext: string): AttachmentKind {
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.txt', '.csv', '.json', '.md', '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css'].includes(ext)) return 'text';
  return 'binary';
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
