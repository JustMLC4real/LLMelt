export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'codex'
  | 'antigravity'
  | 'remote';

export type AuthMethod = 'apikey' | 'oauth' | 'session' | 'browser' | 'none' | 'cli' | 'manual';
export type CredentialMethod = 'apikey' | 'oauth' | 'session' | 'none' | 'cli' | 'manual';
export type ProviderHealth = 'online' | 'offline' | 'limited';
export type ProviderCategory = 'api' | 'local' | 'agent';
export type ProviderAccountId = ProviderType | 'chatgpt' | 'claude-cli';
export type ProviderSurface = 'subscription-web' | 'api' | 'cli' | 'desktop' | 'local' | 'remote';
export type ContextSource = 'provider' | 'cli' | 'estimate' | 'unknown';
export type TokenUsageSource = 'provider' | 'cli' | 'local' | 'estimate' | 'mixed' | 'unknown';
export type LimitScope = 'model' | 'account' | 'project' | 'local' | 'unknown';
export type LimitDisplayState = 'known' | 'unknown' | 'not_exposed' | 'unlimited' | 'cooldown';
export type QuotaAccuracy = 'live' | 'delayed' | 'estimated' | 'unavailable' | 'local';
export type QuotaSource =
  | 'headers'
  | 'codex-app-server'
  | 'claude-statusline'
  | 'antigravity-statusline'
  | 'google-service-usage'
  | 'google-monitoring'
  | 'runtime-error'
  | 'local'
  | 'unknown';
export type QuotaState = 'available' | 'limited' | 'exhausted' | 'cooldown' | 'unknown' | 'unlimited' | 'unavailable';
export type QuotaMeter = 'requests' | 'tokens' | 'input_tokens' | 'output_tokens' | 'context' | 'provider';
export type ChatRole = 'user' | 'assistant' | 'system';
export type AttachmentKind = 'text' | 'image' | 'pdf' | 'binary';
// CLI-providers publiceren hun effortwaarden live. Dit type moet daarom open
// blijven: een nieuwe CLI-waarde mag niet door een LLMelt-allowlist verdwijnen.
export type ReasoningEffort = string;
export type AgentShell = 'powershell' | 'cmd' | 'pwsh';
export type AgentApprovalMode = 'ask' | 'auto-project' | 'full';
export type UiLanguage = 'nl' | 'en';
// Codex service/speed tiers come live from the CLI catalog (service_tiers +
// additional_speed_tiers), so this is an open string — not a fixed allowlist.
export type ServiceTier = string;
export type FallbackReason =
  | 'rate_limit'
  | 'context_exceeded'
  | 'auth_failed'
  | 'network'
  | 'cancelled'
  | 'provider_error';

export interface ModelRef {
  provider: ProviderType;
  modelId: string;
  runConfig?: ModelRunConfig;
}

export type NativeProviderCommandKind =
  | 'collaboration-mode'
  | 'goal'
  | 'review'
  | 'skill';

/** Een echte provideractie uit Codex App Server of live CLI-help. */
export interface NativeProviderCommand {
  id: string;
  provider: ProviderType;
  slash: string;
  aliases?: string[];
  label: string;
  description: string;
  source: 'app-server' | 'cli-help';
  kind: NativeProviderCommandKind;
  requiresArgument?: boolean;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  name?: string;
  path?: string;
}

/** Eenmalige native actie die met de eerstvolgende providerbeurt meegaat. */
export interface NativeProviderCommandSelection {
  id: string;
  kind: Exclude<NativeProviderCommandKind, 'goal'>;
  args?: string;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  name?: string;
  path?: string;
}

export interface ModelRunConfig {
  baseModelId?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  timeoutSeconds?: number;
  commandPresetId?: string;
  commandGoal?: string;
  commandInstruction?: string;
  // Auto Mode bewaart de prompt semantisch als user-bericht voor het antwoordmodel,
  // maar de renderer toont hem als door de prompter-AI gegenereerd bericht.
  autoModePrompt?: boolean;
  // ChatGPT browser: the chosen thinking effort value (e.g. 'standard' | 'extended'),
  // taken live from the model's thinking_efforts — not hardcoded.
  chatgptThinkingEffort?: string;
  nativeProviderCommand?: NativeProviderCommandSelection;
}

/**
 * ChatGPT levert z'n eigen modelkiezer aan in `/backend-api/models` onder
 * `versions[]`. Elk item is één regel in de Model-lijst ("GPT-5.6 Sol") met
 * daarin de Intelligentie-niveaus ("Direct", "Gemiddeld", "Hoog", "Pro").
 * We nemen dat één-op-één over i.p.v. modelnamen te parsen: dan tonen we exact
 * wat ChatGPT toont, en verschijnen interne varianten (Terra, Luna, CCA) niet.
 */
export interface ChatgptIntelligencePreset {
  title: string;
  // Staat er een ander model achter dit niveau, dan zet ChatGPT de versie erbij
  // (bv. Direct op GPT-5.6 Sol draait op 5.5).
  subtitle?: string;
  modelSlug: string;
  lane?: string;
  thinkingEffort?: string;
  available: boolean;
}

export interface ChatgptVersion {
  id: string;
  title: string;
  shortTitle?: string;
  enabled: boolean;
  // Modellen zonder intelligentie-keuze (zoals o3) hebben geen presets; dan valt
  // de app terug op de eerste slug van deze versie.
  slugs: string[];
  presets: ChatgptIntelligencePreset[];
}

export interface AIModel {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsFiles: boolean;
  supportsStreaming: boolean;
  // Live door de provider gemeld (bv. Ollama /api/show capabilities).
  supportsTools?: boolean;
  supportsThinking?: boolean;
  source?: 'api' | 'cli' | 'local' | 'manual' | 'fallback';
  sourceLabel?: string;
  surfaceLabel?: string;
  providerSurface?: ProviderSurface;
  limitScope?: LimitScope;
  limitGroupKey?: string;
  isRecommended?: boolean;
  providerCategory?: ProviderCategory;
  executionMode?: 'chat' | 'agent' | 'connector';
  canChat?: boolean;
  contextSource?: ContextSource;
  // Provider-supplied picker order. Lower values appear first.
  catalogPriority?: number;
  supportedReasoningEfforts?: ReasoningEffort[];
  supportedServiceTiers?: ServiceTier[];
  defaultReasoningEffort?: ReasoningEffort;
  // ChatGPT browser: live thinking-effort options for this exact model, straight
  // from /backend-api/models (configurable_thinking_effort + thinking_efforts).
  chatgptConfigurableEffort?: boolean;
  chatgptThinkingEfforts?: { value: string; label: string; description?: string }[];
  chatgptReasoningType?: string;
  // ChatGPT meldt zélf of dit een work-mode (workspace) model is, bv. "GPT-5.6 Sol".
  // Die slugs (gpt-5.6-sol-wm) hebben een afwijkende vorm, dus we vertrouwen op deze
  // vlag i.p.v. op de slug-vorm — anders vallen ze uit de picker.
  chatgptWorkMode?: boolean;
  runConfig?: ModelRunConfig;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

export interface ProviderInfo {
  id: ProviderType;
  name: string;
  icon: string;
  color: string;
  authMethods: AuthMethod[];
  isLocal: boolean;
}

export interface CredentialStatus {
  provider: ProviderType;
  authenticated: boolean;
  method: CredentialMethod;
  label?: string;
  error?: string;
  expiresAt?: string;
  statusLabel?: string;
  category?: ProviderCategory;
  canChat?: boolean;
  sessionActive?: boolean;
  cliAuthenticated?: boolean;
  preferredMethod?: AuthMethod;
}

export interface ProviderAccountStatus {
  provider: ProviderAccountId;
  displayName: string;
  surface: ProviderSurface;
  installed: boolean;
  authenticated: boolean;
  accountLabel?: string;
  planTier?: string;
  executablePath?: string;
  statusLabel: string;
  statusSource: 'api' | 'cli' | 'desktop' | 'local' | 'config' | 'statusline' | 'unknown';
  canChat: boolean;
  limitsKnown: boolean;
  error?: string;
}

export interface OllamaTitleSetupProgress {
  phase:
    | 'checking'
    | 'downloading-runtime'
    | 'verifying-runtime'
    | 'installing-runtime'
    | 'starting-runtime'
    | 'downloading-model'
    | 'ready'
    | 'error';
  status: string;
  model: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface OllamaInstalledModel {
  name: string;
  size: number;
  digest?: string;
  modifiedAt?: string;
  format?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  capabilities: string[];
  contextWindow?: number;
}

export interface OllamaLibraryModel {
  name: string;
  description: string;
  libraryPath: string;
  capabilities: string[];
  variants: string[];
  pulls?: string;
  tagCount?: string;
  updated?: string;
}

export interface OllamaLibraryTag {
  name: string;
  tag: string;
  sizeLabel?: string;
  contextLabel?: string;
  inputLabel?: string;
  digest?: string;
  updated?: string;
}

export interface OllamaModelPullProgress {
  model: string;
  phase: 'resolving' | 'downloading' | 'verifying' | 'writing' | 'success' | 'cancelled' | 'error';
  status: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface OllamaModelManagerStatus {
  online: boolean;
  baseUrl: string;
  models: OllamaInstalledModel[];
  error?: string;
}

export type RuntimeSetupId = 'ollama' | 'python';
export type RuntimeSetupTarget = RuntimeSetupId | 'codex' | 'claude' | 'antigravity';
export type RuntimeSetupPhase =
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'configuring'
  | 'awaiting-login'
  | 'starting'
  | 'pulling-model'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface RuntimeSetupProgress {
  runtime: RuntimeSetupTarget;
  phase: RuntimeSetupPhase;
  status: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface RuntimeStatus {
  runtime: RuntimeSetupId;
  ready: boolean;
  executablePath?: string;
  version?: string;
  detail: string;
  model?: string;
  installedModels?: string[];
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  attachments?: AttachmentRef[];
}

export interface AttachmentRef {
  id: string;
  chatId?: string | null;
  messageId?: string | null;
  name: string;
  path?: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  tokenEstimate: number;
  contentPreview?: string;
  createdAt: string;
}

export interface ChatRequest {
  requestId: string;
  chatId: string;
  modelRef: ModelRef;
  input: string;
  attachmentIds?: string[];
  systemPrompt?: string;
  /** Taal voor zichtbare runtime-status en verborgen host-/toolinstructies. */
  language?: UiLanguage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowSize: number;
  contextUsedPercent: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  /**
   * Herkomst van de tokenaantallen. Dit staat los van accountquota en van de
   * actuele contextschatting: provider/CLI/local zijn gemeten, estimate is een
   * lokale tekenschatting en mixed is een optelsom met meerdere bronnen.
   */
  source?: TokenUsageSource;
}

export interface UsageEvent {
  id: string;
  chatId?: string | null;
  messageId?: string | null;
  provider: ProviderType;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  source?: TokenUsageSource;
  createdAt: string;
}

export interface RateLimitSnapshot {
  provider: ProviderType;
  modelId?: string;
  known: boolean;
  source: 'headers' | 'dashboard' | 'local' | 'unknown';
  limitScope?: LimitScope;
  limitGroupKey?: string;
  displayState?: LimitDisplayState;
  requestsLimit?: number;
  requestsRemaining?: number;
  tokensLimit?: number;
  tokensRemaining?: number;
  resetRequestsAt?: string;
  resetTokensAt?: string;
  retryAfterMs?: number;
  note?: string;
  updatedAt: string;
}

/**
 * Eén provider kan meerdere onafhankelijke quotavensters hebben (bijvoorbeeld
 * Codex 5 uur + 7 dagen). Daarom is een quota een snapshot met losse buckets,
 * niet één generieke remaining-counter.
 */
export interface QuotaBucket {
  id: string;
  label: string;
  meter: QuotaMeter;
  state: QuotaState;
  modelId?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  usedPercent?: number;
  remainingFraction?: number;
  windowSeconds?: number;
  resetAt?: string;
}

export interface ProviderQuotaSnapshot {
  id: string;
  provider: ProviderType;
  surface: ProviderSurface;
  modelId?: string;
  limitGroupKey: string;
  planTier?: string;
  state: QuotaState;
  source: QuotaSource;
  accuracy: QuotaAccuracy;
  observedAt: string;
  staleAfter?: string;
  delayedBySeconds?: number;
  note?: string;
  buckets: QuotaBucket[];
}

export interface ChatStreamEvent {
  requestId: string;
  type:
    | 'delta'
    | 'status'
    | 'usage'
    | 'model_switch'
    | 'message_saved'
    | 'done'
    | 'error'
    // Native provider: het assistent-bericht bestaat vooraf als anker en groeit live,
    // zodat de tools eronder live kunnen streamen (i.p.v. de zwevende bubbel).
    | 'assistant_start'
    | 'assistant_delta'
    | 'tool_run_started'
    | 'tool_run_output'
    | 'tool_run_finished'
    | 'tool_activity';
  chatId?: string;
  // Doel-bericht voor 'assistant_delta'.
  messageId?: string;
  delta?: string;
  status?: string;
  usage?: TokenUsage;
  message?: Message;
  from?: ModelRef;
  to?: ModelRef;
  reason?: FallbackReason;
  error?: string;
  runId?: string;
  anchorMessageId?: string;
  run?: CommandRun;
  stream?: 'stdout' | 'stderr';
  activityId?: string;
  phase?: ToolActivityPhase;
  approvalStatus?: 'pending' | 'approved' | 'denied';
  attempt?: number;
  label?: string;
  detail?: string;
  stopReason?: string;
  tone?: 'running' | 'ok' | 'failed' | 'denied';
}

export type ToolActivityPhase =
  | 'planning'
  | 'approval_pending'
  | 'approval_approved'
  | 'approval_denied'
  | 'running'
  | 'sending_output'
  | 'summarizing'
  | 'repairing'
  | 'done'
  | 'stopped';

export type ValidationReasonCode =
  | 'invalid_key'
  | 'expired_key'
  | 'account_deactivated'
  | 'permission_denied'
  | 'billing'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'model_unavailable'
  | 'no_models'
  | 'empty_response'
  | 'server_error'
  | 'network'
  | 'unknown';

export interface ValidationResult {
  id: string;
  keyMasked: string;
  provider: ProviderType | 'unknown';
  // 'limited' = key authenticeert, maar genereren lukt nu niet (quota/tegoed/storing)
  status: 'valid' | 'limited' | 'invalid' | 'expired' | 'checking';
  reasonCode?: ValidationReasonCode;
  models?: string[];
  checkedModel?: string;
  details?: string;
  error?: string;
}

export interface FallbackConfig {
  order: Array<{
    modelRef: ModelRef;
    enabled: boolean;
    /** Betaalde API-oppervlakken mogen nooit impliciet worden ingeschakeld. */
    allowPaidApi?: boolean;
  }>;
  autoSwitchEnabled: boolean;
  /** Alleen true nadat de gebruiker de fallbackschakelaar bewust heeft opgeslagen. */
  autoSwitchConfirmed?: boolean;
}

export interface AutoModeConfig {
  prompterModelRef: ModelRef;
  responderModelRef: ModelRef;
  maxIterations: number;
  delayMs: number;
  chatId: string;
  tokenBudget?: number;
  // What the prompter should drive the conversation toward. Without it the
  // prompter just generates generic "define your goal" prompts.
  goal?: string;
  language?: UiLanguage;
}

export type AutoModeStatus = 'idle' | 'running' | 'paused' | 'stopped';
export type AutoModePhase =
  | 'idle'
  | 'starting'
  | 'prompter'
  | 'responder'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error';

export interface AutoModeState {
  chatId?: string;
  status: AutoModeStatus;
  iteration: number;
  totalTokens: number;
  maxIterations: number;
  tokenBudget?: number;
  detail?: string;
  phase?: AutoModePhase;
  phaseStartedAt?: string;
  lastPromptPreview?: string;
  error?: string;
}

export interface MemoryEntry {
  id: string;
  type: 'global' | 'project' | 'chat';
  scopeId?: string | null;
  title: string;
  content: string;
  maxTokens: number;
  enabled: boolean | number;
  createdAt: string;
}

export interface Chat {
  id: string;
  title: string;
  folderId?: string | null;
  projectPath?: string | null;
  systemPrompt?: string | null;
  activeModelId?: string | null;
  activeProvider?: ProviderType | null;
  activeRunConfig?: ModelRunConfig | null;
  agentMode?: AgentApprovalMode | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  modelId?: string | null;
  provider?: ProviderType | null;
  inputTokens: number;
  outputTokens: number;
  fallbackFrom?: string | null;
  attachments?: string | null;
  runConfig?: string | null;
  toolRun?: string | null;
  createdAt: string;
}

export interface CommandRun {
  id: string;
  source: 'direct' | 'model' | 'manual' | 'test';
  command: string;
  shell: AgentShell;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'denied';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  anchorMessageId?: string | null;
  // Providerneutrale toolmetadata. Hiermee kan de renderer native CLI/API-tools
  // als bestand/diff tonen zonder providerspecifieke UI-logica.
  toolName?: string;
  toolKind?: 'file-read' | 'file-create' | 'file-edit' | 'command';
  toolPath?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string | null;
  projectPath?: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  content: string;
  isDefault: boolean | number;
  createdAt: string;
  updatedAt?: string;
}

export interface TokenDashboard {
  usageEvents: UsageEvent[];
  usageByModel: Record<string, TokenUsage & { provider: ProviderType; modelId: string }>;
  rateLimits: RateLimitSnapshot[];
  quotas: ProviderQuotaSnapshot[];
  context: {
    chatId?: string;
    provider?: ProviderType;
    modelId?: string;
    used: number;
    total: number;
    percent: number;
    /** Bron van het gebruikte tokenaantal. */
    source: ContextSource;
    /** Bron van de maximale contextvenstergrootte. */
    windowSource?: ContextSource;
  };
}

export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'ChatGPT Subscription / OpenAI API',
    icon: 'OAI',
    color: '#10a37f',
    authMethods: ['browser', 'apikey'],
    isLocal: false,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude / Anthropic',
    icon: 'ANT',
    color: '#d4a574',
    authMethods: ['cli', 'apikey'],
    isLocal: false,
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    icon: 'GEM',
    color: '#4285f4',
    authMethods: ['cli', 'apikey', 'oauth'],
    isLocal: false,
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    icon: 'OLL',
    color: '#e2e8f0',
    authMethods: ['none'],
    isLocal: true,
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    icon: 'CDX',
    color: '#00a67e',
    authMethods: ['cli'],
    isLocal: true,
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity CLI',
    icon: 'AGY',
    color: '#669df6',
    authMethods: ['cli', 'manual'],
    isLocal: true,
  },
  remote: {
    id: 'remote',
    name: 'Remote LLM',
    icon: 'SSH',
    color: '#f472b6',
    authMethods: ['manual'],
    isLocal: false,
  },
};
