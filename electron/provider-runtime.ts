import type {
  AgentApprovalMode,
  AIModel,
  AttachmentRef,
  ChatMessage,
  FallbackReason,
  ModelRef,
  ModelRunConfig,
  ProviderType,
  RateLimitSnapshot,
  TokenUsage,
  UiLanguage,
  ValidationResult,
} from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import type { NativePermissionHandler, NativeToolActivity, NativeToolExecutor } from './native-tools';

export class ProviderRuntimeError extends Error {
  reason: FallbackReason;
  status?: number;
  rateLimit?: RateLimitSnapshot;

  constructor(message: string, reason: FallbackReason = 'provider_error', status?: number, rateLimit?: RateLimitSnapshot) {
    super(message);
    this.name = 'ProviderRuntimeError';
    this.reason = reason;
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

export interface AttachmentRecord extends AttachmentRef {
  textContent?: string | null;
  base64Content?: string | null;
}

export interface AdapterChatRequest {
  chatId?: string;
  modelRef: ModelRef;
  messages: ChatMessage[];
  systemPrompt?: string;
  attachments: AttachmentRecord[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  cwd?: string;
  agentMode?: AgentApprovalMode;
  nativeTools?: boolean;
  requireToolUse?: boolean;
  requestPermission?: NativePermissionHandler;
  executeTool?: NativeToolExecutor;
  onToolActivity?: (activity: NativeToolActivity) => void;
  language?: UiLanguage;
}

export interface AdapterChatResult {
  text: string;
  usage: TokenUsage;
  rateLimit?: RateLimitSnapshot;
  runConfig?: ModelRunConfig;
}

export interface CredentialValidationOptions {
  probeGeneration?: boolean;
  language?: UiLanguage;
}

export interface ProviderAdapter {
  id: ProviderType;
  listModels(): Promise<AIModel[]>;
  invalidateModelCache?(): void;
  validateCredential(secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult>;
  sendChat(request: AdapterChatRequest): Promise<AdapterChatResult>;
  countTokens(modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number>;
  getRateLimitState(modelId?: string): Promise<RateLimitSnapshot>;
}

export function classifyProviderError(error: unknown, language: UiLanguage = 'nl'): { reason: FallbackReason; message: string; rateLimit?: RateLimitSnapshot } {
  const message = (error as any)?.message || String(error);
  if ((error as any)?.preventFallback === true) return { reason: 'provider_error', message };
  if (error instanceof ProviderRuntimeError) {
    return { reason: error.reason, message: error.message, rateLimit: error.rateLimit };
  }
  if ((error as any)?.name === 'AbortError') {
    return { reason: 'cancelled', message: localizedText(language, 'Verzoek geannuleerd.', 'Request cancelled.') };
  }
  if (/\b(?:rate[\s_-]*limit(?:ed|ing|s)?|too many requests|resource[\s_-]*exhausted|usage (?:credits?|limit))\b|\bquota\b|\b429\b/i.test(message)) {
    return { reason: 'rate_limit', message };
  }
  if (/context|token limit|too large/i.test(message)) return { reason: 'context_exceeded', message };
  if (/\b(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden)\b|\b(?:api|access|secret)[\s_-]*key\b|\bkey\b.{0,40}\b(?:invalid|missing|expired|required)\b|\b(?:401|403)\b/i.test(message)) {
    return { reason: 'auth_failed', message };
  }
  if (/network|fetch|timeout|socket|dns/i.test(message)) return { reason: 'network', message };
  return { reason: 'provider_error', message };
}

export function rateLimitKey(snapshot: RateLimitSnapshot) {
  return snapshot.limitGroupKey || `${snapshot.provider}:${snapshot.modelId || '*'}`;
}
