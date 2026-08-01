import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
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
  ReasoningEffort,
  ServiceTier,
  TokenUsage,
  ValidationReasonCode,
  ValidationResult,
} from '../src/providers/types';
import { getCredential, saveCredential } from './credential-store';
import { getStore } from './settings-store';
import { chatgptScraper } from './chatgpt-scraper';
import { claudeCliEnvironment, runClaudeNative } from './claude-native';
import { runCodexNative } from './codex-native';
import { runOllamaNative } from './ollama-native';
import { ollamaChatRequestBody, parseOllamaNdjson } from './ollama-stream';
import { runGeminiApiNative, type GeminiContent } from './gemini-api-native';
import { runAntigravityNative } from './antigravity-native';
import type {
  NativePermissionHandler,
  NativeToolActivity,
  NativeToolExecutor,
} from './native-tools';
import {
  antigravityExecutableCandidates,
  claudeExecutableCandidates,
  codexExecutableCandidates,
  findCliExecutable as findExecutable,
} from './cli-discovery';
import { codexCliServiceTier, codexSafePreflightArgs, codexServiceTiersFromCatalog } from '../src/components/codex-utils';
import { cliSpawnSpec, terminateProcessTree } from './process-utils';
import { agentCommandEnvironment } from './agent-command-environment';

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

export interface AdapterChatRequest {
  modelRef: ModelRef;
  messages: ChatMessage[];
  systemPrompt?: string;
  attachments: AttachmentRecord[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  // Native provider-tools. De runner vertaalt zijn eigen protocol naar gedeelde events;
  // approvals en app-side tools lopen via deze callbacks naar de IPC-laag.
  cwd?: string;
  agentMode?: AgentApprovalMode;
  nativeTools?: boolean;
  requireToolUse?: boolean;
  requestPermission?: NativePermissionHandler;
  executeTool?: NativeToolExecutor;
  onToolActivity?: (activity: NativeToolActivity) => void;
}

export interface AttachmentRecord extends AttachmentRef {
  textContent?: string | null;
  base64Content?: string | null;
}

export interface AdapterChatResult {
  text: string;
  usage: TokenUsage;
  rateLimit?: RateLimitSnapshot;
  runConfig?: ModelRunConfig;
}

export interface ProviderAdapter {
  id: ProviderType;
  listModels(): Promise<AIModel[]>;
  invalidateModelCache?(): void;
  validateCredential(secret?: string, options?: { probeGeneration?: boolean }): Promise<ValidationResult>;
  sendChat(request: AdapterChatRequest): Promise<AdapterChatResult>;
  countTokens(modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number>;
  getRateLimitState(modelId?: string): Promise<RateLimitSnapshot>;
}

const DEFAULT_CONTEXT: Record<ProviderType, number> = {
  openai: 128000,
  anthropic: 200000,
  google: 1000000,
  ollama: 8192,
  codex: 400000,
  antigravity: 400000,
  remote: 8192,
};

const DEFAULT_OUTPUT: Record<ProviderType, number> = {
  openai: 16384,
  anthropic: 8192,
  google: 8192,
  ollama: 4096,
  codex: 128000,
  antigravity: 64000,
  remote: 4096,
};

const SUPPORTED_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function nowIso() {
  return new Date().toISOString();
}

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = 'high'): ReasoningEffort {
  return SUPPORTED_REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : fallback;
}

function normalizeReasoningEfforts(value: unknown): ReasoningEffort[] {
  const raw = Array.isArray(value) ? value : [];
  const efforts = raw
    .map((level: any) => (typeof level === 'string' ? level : level?.effort))
    .filter((effort): effort is ReasoningEffort => SUPPORTED_REASONING_EFFORTS.includes(effort as ReasoningEffort));
  return Array.from(new Set(efforts.length ? efforts : DEFAULT_REASONING_EFFORTS));
}

let codexTiersLogged = false;

function normalizeServiceTier(value: unknown): ServiceTier | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v || undefined;
}

// Codex' selectable speed tiers. The CLI's `service_tier` config ONLY accepts the
// values in additional_speed_tiers (e.g. "fast") — NOT the catalog service_tiers ids
// like "priority"/"default" (passing those makes Codex reject config.toml). "standard"
// is implicit (no service_tier passed) and always offered first.
function codexServiceTiers(model: any): ServiceTier[] {
  return codexServiceTiersFromCatalog(model);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function modelKey(provider: ProviderType, modelId?: string) {
  return `${provider}:${modelId || '*'}`;
}

function limitScopeFor(provider: ProviderType, modelId?: string): RateLimitSnapshot['limitScope'] {
  if (provider === 'ollama' || provider === 'remote') return 'local';
  if (provider === 'codex') return 'account';
  if (provider === 'openai' && modelId?.startsWith('chatgpt:')) return 'account';
  if (provider === 'anthropic' && modelId?.startsWith('claude-cli:')) return 'account';
  if (provider === 'google') return 'project';
  if (provider === 'openai' || provider === 'anthropic') return 'model';
  return 'unknown';
}

function limitGroupKey(provider: ProviderType, modelId?: string) {
  const scope = limitScopeFor(provider, modelId);
  if (scope === 'account') return `${provider}:account`;
  if (scope === 'project') return `${provider}:project`;
  if (scope === 'local') return `${provider}:local`;
  return modelKey(provider, modelId);
}

function makeUnknownLimit(provider: ProviderType, modelId?: string, note?: string): RateLimitSnapshot {
  const scope = limitScopeFor(provider, modelId);
  return {
    provider,
    modelId,
    known: false,
    source: provider === 'ollama' ? 'local' : 'unknown',
    limitScope: scope,
    limitGroupKey: limitGroupKey(provider, modelId),
    displayState: scope === 'local' ? 'unlimited' : scope === 'account' ? 'not_exposed' : 'unknown',
    note: note || 'No official machine-readable limit is available for this provider path.',
    updatedAt: nowIso(),
  };
}

function parseResetDuration(value: string | null) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const absolute = Date.parse(trimmed);
  if (!Number.isNaN(absolute)) return new Date(absolute).toISOString();

  const match = trimmed.match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match) return undefined;
  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2] || 0);
  return new Date(Date.now() + (minutes * 60 + seconds) * 1000).toISOString();
}

function readOpenAIRateLimit(headers: Headers, provider: ProviderType, modelId?: string): RateLimitSnapshot | undefined {
  const requestsLimit = Number(headers.get('x-ratelimit-limit-requests') || NaN);
  const requestsRemaining = Number(headers.get('x-ratelimit-remaining-requests') || NaN);
  const tokensLimit = Number(headers.get('x-ratelimit-limit-tokens') || NaN);
  const tokensRemaining = Number(headers.get('x-ratelimit-remaining-tokens') || NaN);

  if ([requestsLimit, requestsRemaining, tokensLimit, tokensRemaining].every(Number.isNaN)) {
    return undefined;
  }

  return {
    provider,
    modelId,
    known: true,
    source: 'headers',
    limitScope: limitScopeFor(provider, modelId),
    limitGroupKey: limitGroupKey(provider, modelId),
    displayState: 'known',
    requestsLimit: Number.isNaN(requestsLimit) ? undefined : requestsLimit,
    requestsRemaining: Number.isNaN(requestsRemaining) ? undefined : requestsRemaining,
    tokensLimit: Number.isNaN(tokensLimit) ? undefined : tokensLimit,
    tokensRemaining: Number.isNaN(tokensRemaining) ? undefined : tokensRemaining,
    resetRequestsAt: parseResetDuration(headers.get('x-ratelimit-reset-requests')),
    resetTokensAt: parseResetDuration(headers.get('x-ratelimit-reset-tokens')),
    updatedAt: nowIso(),
  };
}

function readAnthropicRateLimit(headers: Headers, modelId?: string): RateLimitSnapshot | undefined {
  const inputLimit = Number(headers.get('anthropic-ratelimit-input-tokens-limit') || NaN);
  const inputRemaining = Number(headers.get('anthropic-ratelimit-input-tokens-remaining') || NaN);
  const requestLimit = Number(headers.get('anthropic-ratelimit-requests-limit') || NaN);
  const requestRemaining = Number(headers.get('anthropic-ratelimit-requests-remaining') || NaN);
  const retryAfter = Number(headers.get('retry-after') || NaN);

  if ([inputLimit, inputRemaining, requestLimit, requestRemaining, retryAfter].every(Number.isNaN)) {
    return undefined;
  }

  return {
    provider: 'anthropic',
    modelId,
    known: true,
    source: 'headers',
    limitScope: 'model',
    limitGroupKey: limitGroupKey('anthropic', modelId),
    displayState: 'known',
    tokensLimit: Number.isNaN(inputLimit) ? undefined : inputLimit,
    tokensRemaining: Number.isNaN(inputRemaining) ? undefined : inputRemaining,
    requestsLimit: Number.isNaN(requestLimit) ? undefined : requestLimit,
    requestsRemaining: Number.isNaN(requestRemaining) ? undefined : requestRemaining,
    resetTokensAt: headers.get('anthropic-ratelimit-input-tokens-reset') || undefined,
    resetRequestsAt: headers.get('anthropic-ratelimit-requests-reset') || undefined,
    retryAfterMs: Number.isNaN(retryAfter) ? undefined : retryAfter * 1000,
    updatedAt: nowIso(),
  };
}

function reasonFromStatus(status: number): FallbackReason {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 408 || status === 425 || status === 502 || status === 503 || status === 504) return 'network';
  if (status === 413 || status === 400) return 'context_exceeded';
  if (status === 429) return 'rate_limit';
  return 'provider_error';
}

// TTL-cache voor dure CLI-spawns (agy models / codex catalog). Het verversen van
// Settings riep die anders elke keer opnieuw aan -> op Windows soms een korte
// console-flits. Nu wordt binnen het TTL-venster het gecachte resultaat hergebruikt.
const cliResultCache = new Map<string, { value: unknown; expires: number }>();
const cliResultPending = new Map<string, Promise<unknown>>();

/**
 * Verwijder alleen resultaten uit het procesgeheugen. Live catalogi worden niet
 * persistent opgeslagen, maar zonder deze stap kon "Modellen vernieuwen" binnen
 * de TTL exact dezelfde eerste (soms nog verouderde) CLI-snapshot teruggeven.
 */
export function invalidateCachedCliResults(prefix: string) {
  for (const key of cliResultCache.keys()) {
    if (key.startsWith(prefix)) cliResultCache.delete(key);
  }
}

export async function cachedCliResult<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  isCacheable: (value: T) => boolean = () => true,
  options: { persist?: boolean } = {},
): Promise<T> {
  const pending = cliResultPending.get(key);
  if (pending) return pending as Promise<T>;

  const request = readCachedCliResult(key, ttlMs, fn, isCacheable, options.persist !== false);
  cliResultPending.set(key, request);
  try {
    return await request;
  } finally {
    if (cliResultPending.get(key) === request) cliResultPending.delete(key);
  }
}

async function readCachedCliResult<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  isCacheable: (value: T) => boolean,
  persist: boolean,
): Promise<T> {
  const now = Date.now();
  const mem = cliResultCache.get(key);
  if (mem && mem.expires > now && isCacheable(mem.value as T)) return mem.value as T;
  if (mem) cliResultCache.delete(key);
  if (!persist) {
    const value = await fn();
    if (isCacheable(value)) {
      cliResultCache.set(key, { value, expires: now + ttlMs });
    }
    return value;
  }

  // Persistente cache (overleeft app-herstart) blijft geschikt voor trage,
  // stabiele probes. Live modelcatalogi gebruiken deze tak bewust niet.
  const store = await getStore();
  const all = (store.get('cliCache') as Record<string, { value: unknown; expires: number }> | undefined) || {};
  if (all[key] && all[key].expires > now && isCacheable(all[key].value as T)) {
    cliResultCache.set(key, all[key]);
    return all[key].value as T;
  }
  if (all[key]) {
    delete all[key];
    try { store.set('cliCache', all); } catch { /* cache is best-effort */ }
  }
  const value = await fn();
  // A failed CLI probe must be retried on the next refresh. Persisting an empty
  // result made a just-updated or newly signed-in Codex app look offline for hours.
  if (!isCacheable(value)) return value;
  const entry = { value, expires: now + ttlMs };
  cliResultCache.set(key, entry);
  all[key] = entry;
  try { store.set('cliCache', all); } catch { /* cache is best-effort */ }
  return value;
}

async function readErrorBody(response: Response) {
  try {
    const json = await response.json();
    return json?.error?.message || json?.message || JSON.stringify(json);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

type KeyCheckHttp = { httpStatus: number | null; bodyText: string };

async function keyCheckFetch(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<KeyCheckHttp> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text().catch(() => '');
    return { httpStatus: response.status, bodyText };
  } catch (error: any) {
    const message = error?.name === 'AbortError' ? `timeout na ${Math.round(timeoutMs / 1000)}s` : (error?.message || String(error));
    return { httpStatus: null, bodyText: message };
  } finally {
    clearTimeout(timeout);
  }
}

type KeyFailure = {
  status: 'invalid' | 'limited' | 'expired';
  reasonCode: ValidationReasonCode;
  error: string;
};

// Vertaalt een HTTP-fout van OpenAI/Anthropic/Google naar een duidelijke reden.
// 'limited' betekent: de key zelf is echt, maar genereren lukt nu niet.
function classifyKeyFailure(check: KeyCheckHttp): KeyFailure {
  const { httpStatus, bodyText } = check;
  if (httpStatus === null) {
    return { status: 'invalid', reasonCode: 'network', error: `Netwerkfout — key niet kunnen controleren (${bodyText}).` };
  }

  let apiMessage = bodyText;
  let hint = '';
  try {
    const json = JSON.parse(bodyText);
    const err = Array.isArray(json) ? json[0]?.error : json?.error;
    apiMessage = err?.message || json?.message || bodyText;
    const reasons = Array.isArray(err?.details) ? err.details.map((d: any) => String(d?.reason || '')).filter(Boolean) : [];
    hint = `${err?.code ?? ''} ${err?.type ?? ''} ${err?.status ?? ''} ${reasons.join(' ')}`;
  } catch {
    // geen JSON-body; val terug op ruwe tekst
  }
  const text = `${hint} ${apiMessage}`.toLowerCase();
  const detail = apiMessage && apiMessage.length < 400 ? apiMessage : `HTTP ${httpStatus}`;

  if (text.includes('expired')) {
    return { status: 'expired', reasonCode: 'expired_key', error: `Key is verlopen — maak een nieuwe aan. (${detail})` };
  }
  if (text.includes('deactivated') || text.includes('account has been disabled') || text.includes('suspended')) {
    return { status: 'invalid', reasonCode: 'account_deactivated', error: `Account gedeactiveerd — deze key werkt niet meer. (${detail})` };
  }
  if (httpStatus === 401 || text.includes('api_key_invalid') || text.includes('api key not valid') || text.includes('invalid x-api-key')) {
    return { status: 'invalid', reasonCode: 'invalid_key', error: `Key ongeldig of ingetrokken. (${detail})` };
  }
  if (httpStatus === 402 || text.includes('credit balance is too low') || text.includes('insufficient_quota') || text.includes('billing')) {
    return { status: 'limited', reasonCode: 'billing', error: `Key is echt, maar tegoed/billing ontbreekt — genereren faalt. (${detail})` };
  }
  if (httpStatus === 403) {
    return { status: 'invalid', reasonCode: 'permission_denied', error: `Key heeft geen toegang (geblokkeerd, projectrechten, of API niet ingeschakeld). (${detail})` };
  }
  if (httpStatus === 404) {
    return { status: 'limited', reasonCode: 'model_unavailable', error: `Testmodel bestaat niet (meer) voor deze key — verouderd of niet beschikbaar. (${detail})` };
  }
  if (httpStatus === 429) {
    const quota = text.includes('quota') || text.includes('resource_exhausted');
    return quota
      ? { status: 'limited', reasonCode: 'quota_exceeded', error: `Key is echt, maar het quotum is op (dag-/minuutlimiet of tegoed). (${detail})` }
      : { status: 'limited', reasonCode: 'rate_limited', error: `Key is echt, maar tijdelijk rate-limited — probeer straks opnieuw. (${detail})` };
  }
  if (httpStatus >= 500) {
    return { status: 'limited', reasonCode: 'server_error', error: `Providerstoring (HTTP ${httpStatus}) — zegt niets over de key; probeer later opnieuw.` };
  }
  return { status: 'invalid', reasonCode: 'unknown', error: `Onverwachte fout (HTTP ${httpStatus}): ${detail}` };
}

async function ensureOk(response: Response, provider: ProviderType, modelId?: string) {
  if (response.ok) return;
  const message = await readErrorBody(response);
  const rateLimit =
    provider === 'anthropic'
      ? readAnthropicRateLimit(response.headers, modelId)
      : readOpenAIRateLimit(response.headers, provider, modelId);
  throw new ProviderRuntimeError(`${provider}: ${message}`, reasonFromStatus(response.status), response.status, rateLimit);
}

async function* parseSse(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data && data !== '[DONE]') yield data;
    }
  }
}

function appendTextAttachments(input: string, attachments: AttachmentRecord[]) {
  const textAttachments = attachments
    .filter((attachment) => attachment.kind === 'text' || attachment.kind === 'pdf')
    .filter((attachment) => attachment.textContent)
    .map((attachment) => `\n\n[Attachment: ${attachment.name}]\n${attachment.textContent}`);

  return textAttachments.length ? `${input}${textAttachments.join('')}` : input;
}

function imageAttachments(attachments: AttachmentRecord[]) {
  return attachments.filter((attachment) => attachment.kind === 'image' && attachment.base64Content);
}

function messageAttachmentRecords(message: ChatMessage): AttachmentRecord[] {
  const raw = Array.isArray(message.attachments) ? message.attachments : [];
  return raw.filter((attachment): attachment is AttachmentRecord => !!attachment && typeof attachment === 'object') as AttachmentRecord[];
}

function attachmentsForMessage(message: ChatMessage, fallback: AttachmentRecord[], useFallback: boolean) {
  const own = messageAttachmentRecords(message);
  return own.length ? own : useFallback ? fallback : [];
}

function normalizeMessages(messages: ChatMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant');
}

function buildHistoryPrompt(messages: ChatMessage[], systemPrompt?: string, attachments: AttachmentRecord[] = []) {
  const lines: string[] = [];
  if (systemPrompt) lines.push(`System:\n${systemPrompt}`);
  const normalized = normalizeMessages(messages);
  const lastUserIndex = [...normalized].reverse().findIndex((message) => message.role === 'user');
  const actualLastUserIndex = lastUserIndex === -1 ? -1 : normalized.length - 1 - lastUserIndex;
  for (let index = 0; index < normalized.length; index++) {
    const message = normalized[index];
    const attached = message.role === 'user' ? attachmentsForMessage(message, attachments, index === actualLastUserIndex) : [];
    lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${appendTextAttachments(message.content, attached)}`);
  }
  return lines.join('\n\n');
}

function executableFingerprint(executable: string) {
  try {
    const stat = fs.statSync(executable);
    return `${executable}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return executable;
  }
}

function modelFromOpenAI(id: string): AIModel {
  return {
    id,
    name: id,
    provider: 'openai',
    contextWindow: DEFAULT_CONTEXT.openai,
    maxOutputTokens: DEFAULT_OUTPUT.openai,
    supportsVision: true,
    supportsFiles: true,
    supportsStreaming: true,
    source: 'api',
    sourceLabel: 'OpenAI API',
    surfaceLabel: 'OpenAI API',
    providerSurface: 'api',
    limitScope: 'model',
    limitGroupKey: limitGroupKey('openai', id),
    providerCategory: 'api',
    executionMode: 'chat',
    canChat: true,
    contextSource: 'estimate',
  };
}

function isOpenAITextModel(id: string) {
  const lower = id.toLowerCase();
  if (/(embedding|tts|whisper|dall|image|audio|realtime|moderation|transcribe|sora|video)/.test(lower)) return false;
  return lower.includes('gpt') || lower.startsWith('o') || lower.includes('codex');
}

class OpenAIAdapter implements ProviderAdapter {
  id: ProviderType = 'openai';
  private latestRateLimit?: RateLimitSnapshot;

  invalidateModelCache() {
    chatgptScraper.invalidateModelCatalog();
  }

  async listModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // 1. API key models
    const credential = await getCredential('openai');
    if (credential.value && credential.method === 'apikey') {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${credential.value}` },
        });
        await ensureOk(response, 'openai');
        const data = (await response.json()) as { data?: Array<{ id: string }> };
        const apiModels = (data.data || [])
          .map((model) => model.id)
          .filter(isOpenAITextModel)
          .sort()
          .map(modelFromOpenAI);
        models.push(...apiModels);
      } catch {
        // API key models failed, continue
      }
    }

    // 2. Browser session models
    try {
      const sessionModels = await chatgptScraper.listSessionModels();
      // Avoid duplicates — session models have chatgpt: prefix
      models.push(...sessionModels);
    } catch {
      // session not active, skip
    }

    return models;
  }

  async validateCredential(secret?: string, options?: { probeGeneration?: boolean }): Promise<ValidationResult> {
    const id = cryptoId();

    const key = secret || (await getCredential('openai')).value;
    const keyMasked = maskKey(key || '');
    if (!key) {
      return {
        id,
        keyMasked: '',
        provider: 'openai',
        status: 'invalid',
        error: 'OpenAI API-key nodig; ChatGPT Subscription heeft een aparte sessiestatus.',
      };
    }

    const listCheck = await keyCheckFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'openai', ...classifyKeyFailure(listCheck) };
    }
    let models: string[] = [];
    try {
      const data = JSON.parse(listCheck.bodyText) as { data?: Array<{ id: string }> };
      models = (data.data || []).map((model) => model.id).filter(isOpenAITextModel);
    } catch {
      // lijst niet leesbaar; de smoketest hieronder geeft het echte oordeel
    }
    const smokeModel = pickOpenAISmokeModel(models);
    if (!smokeModel) {
      return {
        id,
        keyMasked,
        provider: 'openai',
        status: 'limited',
        reasonCode: 'no_models',
        error: 'Key authenticeert, maar dit project heeft geen chat-modellen beschikbaar.',
      };
    }
    if (!options?.probeGeneration) {
      return {
        id,
        keyMasked,
        provider: 'openai',
        status: 'valid',
        models: topModels(models),
        checkedModel: smokeModel,
        details: 'API-key en modelcatalogus zijn bereikbaar.',
      };
    }
    const smoke = await keyCheckFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: smokeModel, input: 'Reply with OK.', max_output_tokens: 16 }),
    });
    if (smoke.httpStatus !== 200) {
      const failure = classifyKeyFailure(smoke);
      return {
        id,
        keyMasked,
        provider: 'openai',
        ...failure,
        models: topModels(models),
        checkedModel: smokeModel,
        error: `models.list werkt, maar echte generatie faalt op ${smokeModel}: ${failure.error}`,
      };
    }
    return {
      id,
      keyMasked,
      provider: 'openai',
      status: 'valid',
      models: topModels(models),
      checkedModel: smokeModel,
      details: `Echte generatie-smoketest geslaagd met ${smokeModel}.`,
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    // Check if this is a browser session model (chatgpt: prefix)
    const isChatGptSession = request.modelRef.modelId.startsWith('chatgpt:');
    const sessionActive = await chatgptScraper.isSessionActive();

    if (isChatGptSession || (sessionActive && !(await getCredential('openai')).value)) {
      // Use browser session scraper
      if (!sessionActive) {
        throw new ProviderRuntimeError('ChatGPT web-sessie is niet ingelogd. Open Instellingen -> ChatGPT Subscription -> Inloggen.', 'auth_failed');
      }
      const result = await chatgptScraper.sendChatViaSession({
        modelSlug: request.modelRef.modelId,
        thinkingEffort: request.modelRef.runConfig?.chatgptThinkingEffort,
        messages: request.messages,
        systemPrompt: request.systemPrompt,
        attachments: request.attachments,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
      });
      return {
        text: result.text,
        usage: result.usage,
        rateLimit: makeUnknownLimit('openai', request.modelRef.modelId, 'ChatGPT Subscription limits depend on your account plan.'),
      };
    }

    // Use API key
    const credential = await getCredential('openai');
    if (!credential.value || credential.method !== 'apikey') {
      throw new ProviderRuntimeError('OpenAI API key nodig voor OpenAI API. ChatGPT Subscription werkt via een chatgpt: model.', 'auth_failed');
    }

    const input = this.toResponsesInput(request.messages, request.attachments);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.value}`,
        'Content-Type': 'application/json',
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.modelRef.modelId,
        input,
        instructions: request.systemPrompt || undefined,
        stream: true,
      }),
    });
    await ensureOk(response, 'openai', request.modelRef.modelId);

    this.latestRateLimit = readOpenAIRateLimit(response.headers, 'openai', request.modelRef.modelId);
    let text = '';
    let usage = emptyUsage(request.modelRef.provider, request.modelRef.modelId);

    for await (const data of parseSse(response)) {
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
        request.onDelta(event.delta);
      }
      if (event.type === 'response.completed' && event.response?.usage) {
        usage = usageFromOpenAI(event.response.usage, request.modelRef.modelId);
      }
      if (event.type === 'response.failed') {
        throw new ProviderRuntimeError(event.response?.error?.message || 'OpenAI response failed', 'provider_error');
      }
    }

    if (!usage.totalTokens) {
      usage = {
        inputTokens: estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments)),
        outputTokens: estimateTokens(text),
        totalTokens: estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments)) + estimateTokens(text),
        contextWindowSize: modelFromOpenAI(request.modelRef.modelId).contextWindow,
        contextUsedPercent: 0,
      };
      usage.contextUsedPercent = Math.round((usage.inputTokens / usage.contextWindowSize) * 100);
    }

    return { text, usage, rateLimit: this.latestRateLimit };
  }

  async countTokens(modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return this.latestRateLimit || makeUnknownLimit('openai', modelId, 'OpenAI rate limits are captured from response headers after API calls.');
  }

  private toResponsesInput(messages: ChatMessage[], attachments: AttachmentRecord[]) {
    const normalized = normalizeMessages(messages);
    const lastUserIndex = [...normalized].reverse().findIndex((message) => message.role === 'user');
    const actualLastUserIndex = lastUserIndex === -1 ? -1 : normalized.length - 1 - lastUserIndex;

    return normalized.map((message, index) => {
      const attached = message.role === 'user' ? attachmentsForMessage(message, attachments, index === actualLastUserIndex) : [];
      if (!attached.length) {
        return { role: message.role, content: message.content };
      }

      const parts: any[] = [{ type: 'input_text', text: appendTextAttachments(message.content, attached) }];
      for (const attachment of imageAttachments(attached)) {
        parts.push({
          type: 'input_image',
          image_url: `data:${attachment.mimeType};base64,${attachment.base64Content}`,
        });
      }
      return { role: message.role, content: parts };
    });
  }
}

class AnthropicAdapter implements ProviderAdapter {
  id: ProviderType = 'anthropic';
  private latestRateLimit?: RateLimitSnapshot;

  async listModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // 1. API key models
    const credential = await getCredential('anthropic');
    if (credential.value && credential.method === 'apikey') {
      try {
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': credential.value,
            'anthropic-version': '2023-06-01',
          },
        });
        await ensureOk(response, 'anthropic');
        const data = (await response.json()) as { data?: any[] };
        models.push(...(data.data || []).map((model) => ({
          id: model.id,
          name: model.display_name || model.id,
          provider: 'anthropic' as const,
          contextWindow: model.max_input_tokens || model.context_window || DEFAULT_CONTEXT.anthropic,
          maxOutputTokens: model.max_tokens || DEFAULT_OUTPUT.anthropic,
          supportsVision: true,
          supportsFiles: true,
          supportsStreaming: true,
          source: 'api' as const,
          sourceLabel: 'Anthropic API',
          surfaceLabel: 'Claude API',
          providerSurface: 'api' as const,
          limitScope: 'model' as const,
          limitGroupKey: limitGroupKey('anthropic', model.id),
          providerCategory: 'api' as const,
          executionMode: 'chat' as const,
          canChat: true,
          contextSource: (model.max_input_tokens || model.context_window ? 'provider' : 'estimate') as any,
        })));
      } catch {
        // API key models failed, continue
      }
    }

    // 2. Claude Code CLI models
    try {
      const cliModels = await claudeCli.listModels();
      models.push(...cliModels);
    } catch {
      // CLI not available
    }

    return models;
  }

  async validateCredential(secret?: string, options?: { probeGeneration?: boolean }): Promise<ValidationResult> {
    const id = cryptoId();
    const storedKey = secret || (await getCredential('anthropic')).value;

    // Alleen een geauthenticeerde CLI telt als verbinding. Het executable alleen
    // aantreffen is niet genoeg: anders verschijnen Claude-modellen vóór login.
    const cliAvailable = await claudeCli.isAvailable();
    if (cliAvailable && !storedKey) {
      const cliModels = await claudeCli.listModels();
      if (cliModels.length) {
        return { id, keyMasked: 'claude-cli', provider: 'anthropic', status: 'valid', models: topModels(cliModels.map((model) => model.id)) };
      }
    }

    // Then check API key
    const key = storedKey;
    const keyMasked = maskKey(key || '');
    if (!key) {
      return {
        id,
        keyMasked: cliAvailable ? 'claude-cli' : '',
        provider: 'anthropic',
        status: 'invalid',
        error: cliAvailable ? 'Claude CLI gevonden, maar niet ingelogd.' : 'API key of Claude CLI nodig',
      };
    }

    const listCheck = await keyCheckFetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'anthropic', ...classifyKeyFailure(listCheck) };
    }
    let models: string[] = [];
    try {
      const data = JSON.parse(listCheck.bodyText) as { data?: Array<{ id: string }> };
      models = (data.data || []).map((model) => model.id);
    } catch {
      // lijst niet leesbaar; de smoketest hieronder geeft het echte oordeel
    }
    const smokeModel = pickAnthropicSmokeModel(models);
    if (!smokeModel) {
      return {
        id,
        keyMasked,
        provider: 'anthropic',
        status: 'limited',
        reasonCode: 'no_models',
        error: 'Key authenticeert, maar er zijn geen modellen beschikbaar voor deze key.',
      };
    }
    if (!options?.probeGeneration) {
      return {
        id,
        keyMasked,
        provider: 'anthropic',
        status: 'valid',
        models: topModels(models),
        checkedModel: smokeModel,
        details: 'API-key en modelcatalogus zijn bereikbaar.',
      };
    }
    const smoke = await keyCheckFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: smokeModel, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
    if (smoke.httpStatus !== 200) {
      const failure = classifyKeyFailure(smoke);
      return {
        id,
        keyMasked,
        provider: 'anthropic',
        ...failure,
        models: topModels(models),
        checkedModel: smokeModel,
        error: `models.list werkt, maar echte generatie faalt op ${smokeModel}: ${failure.error}`,
      };
    }
    return {
      id,
      keyMasked,
      provider: 'anthropic',
      status: 'valid',
      models: topModels(models),
      checkedModel: smokeModel,
      details: `Echte generatie-smoketest geslaagd met ${smokeModel}.`,
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    // Check if this is a Claude CLI model
    const isCliModel = request.modelRef.modelId.startsWith('claude-cli:');
    if (isCliModel) {
      const result = await claudeCli.sendChat({
        modelId: request.modelRef.modelId,
        messages: request.messages,
        systemPrompt: request.systemPrompt,
        attachments: request.attachments,
        effort: request.modelRef.runConfig?.reasoningEffort,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        cwd: request.cwd,
        agentMode: request.agentMode,
        nativeTools: request.nativeTools,
        requestPermission: request.requestPermission,
        onToolActivity: request.onToolActivity,
      });
      return {
        text: result.text,
        usage: result.usage,
        rateLimit: makeUnknownLimit('anthropic', request.modelRef.modelId, 'Claude CLI — limits depend on your Claude account/plan.'),
      };
    }

    const credential = await getCredential('anthropic');
    if (!credential.value || credential.method !== 'apikey') {
      // Try CLI as fallback
      if (await claudeCli.isAvailable()) {
        const result = await claudeCli.sendChat({
          modelId: request.modelRef.modelId,
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          attachments: request.attachments,
          effort: request.modelRef.runConfig?.reasoningEffort,
          signal: request.signal,
          onDelta: request.onDelta,
          onStatus: request.onStatus,
        });
        return {
          text: result.text,
          usage: result.usage,
          rateLimit: makeUnknownLimit('anthropic', request.modelRef.modelId, 'Claude CLI fallback — limits depend on your Claude account/plan.'),
        };
      }
      throw new ProviderRuntimeError('Anthropic API key of Claude CLI nodig. Installeer de CLI of voeg een API key toe.', 'auth_failed');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': credential.value,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.modelRef.modelId,
        max_tokens: Math.min(DEFAULT_OUTPUT.anthropic, 8192),
        stream: true,
        system: request.systemPrompt || undefined,
        messages: this.toAnthropicMessages(request.messages, request.attachments),
      }),
    });
    await ensureOk(response, 'anthropic', request.modelRef.modelId);

    this.latestRateLimit = readAnthropicRateLimit(response.headers, request.modelRef.modelId);
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const data of parseSse(response)) {
      const event = JSON.parse(data);
      if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens || inputTokens;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        request.onDelta(event.delta.text);
      }
      if (event.type === 'message_delta') outputTokens = event.usage?.output_tokens || outputTokens;
      if (event.type === 'error') {
        throw new ProviderRuntimeError(event.error?.message || 'Anthropic stream failed', 'provider_error');
      }
    }

    if (!inputTokens) inputTokens = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
    if (!outputTokens) outputTokens = estimateTokens(text);
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.anthropic,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.anthropic) * 100),
      },
      rateLimit: this.latestRateLimit,
    };
  }

  async countTokens(modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    const credential = await getCredential('anthropic');
    if (!credential.value || credential.method !== 'apikey') return estimateTokens(buildHistoryPrompt(messages, systemPrompt));

    const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': credential.value,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        system: systemPrompt || undefined,
        messages: this.toAnthropicMessages(messages, []),
      }),
    });
    if (!response.ok) return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
    const data = (await response.json()) as { input_tokens?: number };
    return data.input_tokens || estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return this.latestRateLimit || makeUnknownLimit('anthropic', modelId, 'Anthropic limits are captured from response headers after API calls.');
  }

  private toAnthropicMessages(messages: ChatMessage[], attachments: AttachmentRecord[]) {
    const normalized = normalizeMessages(messages);
    const result: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    const lastUserIndex = [...normalized].reverse().findIndex((message) => message.role === 'user');
    const actualLastUserIndex = lastUserIndex === -1 ? -1 : normalized.length - 1 - lastUserIndex;

    for (let index = 0; index < normalized.length; index++) {
      const message = normalized[index];
      const role = message.role as 'user' | 'assistant';
      let content: any = message.content;

      const attached = role === 'user' ? attachmentsForMessage(message, attachments, index === actualLastUserIndex) : [];
      if (attached.length) {
        const blocks: any[] = [{ type: 'text', text: appendTextAttachments(message.content, attached) }];
        for (const attachment of imageAttachments(attached)) {
          const mediaType = attachment.mimeType === 'image/jpg' ? 'image/jpeg' : attachment.mimeType;
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: attachment.base64Content,
            },
          });
        }
        content = blocks;
      }

      const previous = result[result.length - 1];
      if (previous?.role === role) {
        previous.content = Array.isArray(previous.content)
          ? [...previous.content, { type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }]
          : `${previous.content}\n\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
      } else {
        result.push({ role, content });
      }
    }

    if (!result.length || result[0].role !== 'user') {
      result.unshift({ role: 'user', content: 'Continue the conversation.' });
    }
    return result;
  }
}

class GoogleAdapter implements ProviderAdapter {
  id: ProviderType = 'google';
  private latestRateLimit?: RateLimitSnapshot;

  async listModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // 1. API key models
    const credential = await getCredential('google');
    if (credential.value && credential.method === 'apikey') {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential.value)}`);
        await ensureOk(response, 'google');
        const data = (await response.json()) as { models?: any[] };
        const apiModels = (data.models || [])
          .filter((model) => (model.supportedGenerationMethods || []).includes('generateContent'))
          .map((model) => {
            const id = String(model.name || '').replace(/^models\//, '');
            const capabilities = googleCatalogCapabilities(model);
            return {
              id,
              name: model.displayName || id,
              provider: 'google' as const,
              contextWindow: model.inputTokenLimit || DEFAULT_CONTEXT.google,
              maxOutputTokens: model.outputTokenLimit || DEFAULT_OUTPUT.google,
              supportsVision: capabilities.vision,
              // Tekst en PDF worden door de app als tekstcontext ingevoegd en zijn dus
              // niet afhankelijk van een provider-specifieke uploadcapability.
              supportsFiles: true,
              supportsStreaming: true,
              // Alleen claimen wat Google daadwerkelijk in de live catalogus meldt.
              // De native route probeert function calling bij gebruik zelf; de huidige
              // models.list-response publiceert deze capability niet voor ieder model.
              supportsTools: capabilities.tools,
              source: 'api' as const,
              sourceLabel: 'Gemini API',
              surfaceLabel: 'Gemini API',
              providerSurface: 'api' as const,
              limitScope: 'project' as const,
              limitGroupKey: limitGroupKey('google', id),
              providerCategory: 'api' as const,
              executionMode: 'chat' as const,
              canChat: true,
              contextSource: (model.inputTokenLimit ? 'provider' : 'estimate') as any,
              catalogPriority: googleModelCatalogPriority(id),
            };
          });
        models.push(...apiModels);
      } catch {
        // API key failed, continue
      }
    }

    return models;
  }

  async validateCredential(secret?: string, options?: { probeGeneration?: boolean }): Promise<ValidationResult> {
    const id = cryptoId();

    // Gemini gebruikt uitsluitend de directe Developer API met API-key.
    const key = secret || (await getCredential('google')).value;
    const keyMasked = maskKey(key || '');
    if (!key) {
      return {
        id,
        keyMasked: '',
        provider: 'google',
        status: 'invalid',
        error: 'Gemini API-key nodig',
      };
    }

    const listCheck = await keyCheckFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'google', ...classifyKeyFailure(listCheck) };
    }
    let supportedModels: string[] = [];
    try {
      const data = JSON.parse(listCheck.bodyText) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
      supportedModels = (data.models || [])
        .filter((model) => /^models\//.test(model.name) && (model.supportedGenerationMethods || []).includes('generateContent'))
        .map((model) => model.name.replace(/^models\//, ''));
    } catch {
      // lijst niet leesbaar; de smoketest hieronder geeft het echte oordeel
    }
    if (!supportedModels.length) {
      return {
        id,
        keyMasked,
        provider: 'google',
        status: 'limited',
        reasonCode: 'no_models',
        error: 'Key authenticeert, maar er zijn geen generateContent-modellen beschikbaar.',
      };
    }
    if (!options?.probeGeneration) {
      return {
        id,
        keyMasked,
        provider: 'google',
        status: 'valid',
        models: topModels(supportedModels),
        details: 'API-key en modelcatalogus zijn bereikbaar.',
      };
    }
    let lastModelIssue = '';
    for (const smokeModel of geminiSmokeCandidates(supportedModels).slice(0, 6)) {
      const smoke = await keyCheckFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(smokeModel)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
            generationConfig: { maxOutputTokens: 32, temperature: 0 },
          }),
        },
        12000,
      );

      // Een key kan geldig zijn terwijl een model uit models.list voor dit project
      // al is uitgefaseerd. Probeer dan het volgende live model.
      if (smoke.httpStatus === 404) {
        lastModelIssue = `${smokeModel} is niet beschikbaar voor dit project.`;
        continue;
      }
      if (smoke.httpStatus !== 200) {
        const failure = classifyKeyFailure(smoke);
        return {
          id,
          keyMasked,
          provider: 'google',
          ...failure,
          models: topModels(supportedModels),
          checkedModel: smokeModel,
          error: `models.list werkt, maar generateContent faalt op ${smokeModel}: ${failure.error}`,
        };
      }

      let smokeText = '';
      try {
        const json = JSON.parse(smoke.bodyText) as any;
        smokeText = (json?.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join('').trim();
      } catch {
        // Probeer bij een modelspecifieke lege respons het volgende live model.
      }
      if (!smokeText) {
        lastModelIssue = `${smokeModel} gaf een lege respons.`;
        continue;
      }
      return {
        id,
        keyMasked,
        provider: 'google',
        status: 'valid',
        models: topModels(supportedModels),
        checkedModel: smokeModel,
        details: `Echte generateContent-smoketest geslaagd met ${smokeModel}.`,
      };
    }

    return {
      id,
      keyMasked,
      provider: 'google',
      status: 'limited',
      reasonCode: 'no_models',
      models: topModels(supportedModels),
      error: lastModelIssue || 'Geen van de live Gemini-modellen accepteerde de smoketest.',
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const credential = await getCredential('google');
    if (!credential.value || credential.method !== 'apikey') {
      throw new ProviderRuntimeError('Voeg eerst een geldige Gemini API-key toe.', 'auth_failed');
    }

    const model = request.modelRef.modelId.replace(/^models\//, '');
    if (request.nativeTools && request.executeTool) {
      const nativeResult = await runGeminiApiNative({
        apiKey: credential.value,
        model,
        contents: this.toGoogleContents(request.messages, request.attachments),
        systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
        signal: request.signal,
        executeTool: request.executeTool,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.onToolActivity,
      });
      this.latestRateLimit = makeUnknownLimit(
        'google',
        model,
        'Gemini per-project limits zijn zichtbaar in AI Studio; API-responses geven niet altijd resterend quota terug.',
      );
      const estimatedInput = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      const inputTokens = nativeResult.inputTokens || estimatedInput;
      const outputTokens = nativeResult.outputTokens || estimateTokens(nativeResult.text);
      return {
        text: nativeResult.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.google,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.google) * 100),
        },
        rateLimit: this.latestRateLimit,
      };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(credential.value)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify({
          contents: this.toGoogleContents(request.messages, request.attachments),
          systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
        }),
      },
    );
    await ensureOk(response, 'google', model);

    this.latestRateLimit = makeUnknownLimit(
      'google',
      model,
      'Gemini per-project limits are visible in AI Studio; API responses do not consistently expose remaining quota headers.',
    );

    let text = '';
    let usage = emptyUsage('google', model);

    for await (const data of parseSse(response)) {
      const event = JSON.parse(data);
      const chunkText = (event.candidates || [])
        .flatMap((candidate: any) => candidate.content?.parts || [])
        .map((part: any) => part.text || '')
        .join('');
      if (chunkText) {
        text += chunkText;
        request.onDelta(chunkText);
      }
      if (event.usageMetadata) {
        usage = {
          inputTokens: event.usageMetadata.promptTokenCount || 0,
          outputTokens: event.usageMetadata.candidatesTokenCount || 0,
          totalTokens: event.usageMetadata.totalTokenCount || 0,
          contextWindowSize: DEFAULT_CONTEXT.google,
          contextUsedPercent: Math.round(((event.usageMetadata.promptTokenCount || 0) / DEFAULT_CONTEXT.google) * 100),
        };
      }
    }

    if (!usage.totalTokens) {
      const inputTokens = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      const outputTokens = estimateTokens(text);
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.google,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.google) * 100),
      };
    }

    return { text, usage, rateLimit: this.latestRateLimit };
  }

  async countTokens(modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    const credential = await getCredential('google');
    if (!credential.value || credential.method !== 'apikey') return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
    const model = modelId.replace(/^models\//, '');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens?key=${encodeURIComponent(credential.value)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: this.toGoogleContents(messages, []),
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        }),
      },
    );
    if (!response.ok) return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
    const data = (await response.json()) as { totalTokens?: number };
    return data.totalTokens || estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return this.latestRateLimit || makeUnknownLimit('google', modelId, 'Gemini limits are project-level and should be viewed in AI Studio.');
  }

  private toGoogleContents(messages: ChatMessage[], attachments: AttachmentRecord[]): GeminiContent[] {
    const normalized = normalizeMessages(messages);
    const lastUserIndex = [...normalized].reverse().findIndex((message) => message.role === 'user');
    const actualLastUserIndex = lastUserIndex === -1 ? -1 : normalized.length - 1 - lastUserIndex;

    return normalized.map((message, index) => {
      const attached = message.role === 'user' ? attachmentsForMessage(message, attachments, index === actualLastUserIndex) : [];
      const parts: GeminiContent['parts'] = [{ text: appendTextAttachments(message.content, attached) }];
      if (attached.length) {
        for (const attachment of imageAttachments(attached)) {
          parts.push({
            inlineData: {
              mimeType: attachment.mimeType || 'application/octet-stream',
              data: attachment.base64Content || '',
            },
          });
        }
      }
      return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
  }
}

// Claude Code CLI --effort niveaus (uit `claude --help`).
const CLAUDE_CLI_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeCliChatArgs(modelId: string, effort?: string) {
  return [
    '-p',
    '--model', modelId,
    // Zonder native PC-tools is Claude hier een chattransport, geen verborgen
    // bestandsagent. Plan + safe-mode blokkeren mutaties en projecthooks.
    '--permission-mode', 'plan',
    '--safe-mode',
    '--no-session-persistence',
    ...(effort && CLAUDE_CLI_EFFORTS.includes(effort as ReasoningEffort) ? ['--effort', effort] : []),
  ];
}
// De CLI heeft geen "list models"-commando, dus dit is de default-lineup.
// Overschrijfbaar via de store-key `claude.models` — zo is het niet bevroren.
class ClaudeCliAdapter {
  async executable() {
    const store = await getStore();
    const configured = store.get('claude.executable') as string | undefined;
    return findExecutable(claudeExecutableCandidates(configured));
  }

  async isAvailable() {
    return !!(await this.executable());
  }

  async listModels(): Promise<AIModel[]> {
    const exe = await this.executable();
    if (!exe) return [];

    // Claude CLI has no stable models-list JSON command, so we surface the
    // well-known models when the CLI is installed and responds to --version.
    const isAuthenticated = await this.isAuthenticated(exe);
    if (!isAuthenticated) return [];

    const store = await getStore();
    const configured = store.get('claude.models') as Array<{ id: string; name?: string }> | string[] | undefined;
    const discovered = await discoverClaudeCliModels(exe);
    const list = Array.isArray(configured) && configured.length
      ? configured.map((model) => (typeof model === 'string' ? { id: model, name: model } : { id: model.id, name: model.name || model.id }))
      : discovered;
    return list
      .filter((model) => model.id)
      .map((model) => this.makeModel(model.id, model.name, 200000, /haiku/i.test(model.id) ? 32000 : 64000));
  }

  async sendChat(options: {
    modelId: string;
    messages: ChatMessage[];
    systemPrompt?: string;
    attachments?: AttachmentRecord[];
    effort?: string;
    signal: AbortSignal;
    onDelta: (delta: string) => void;
    onStatus?: (status: string) => void;
    // Native tools (Claude Code doet zelf de bestanden in de projectmap):
    cwd?: string;
    agentMode?: AgentApprovalMode;
    nativeTools?: boolean;
    requestPermission?: (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }>;
    onToolActivity?: (activity: NativeToolActivity) => void;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const exe = await this.executable();
    if (!exe) throw new ProviderRuntimeError('Claude CLI niet gevonden. Installeer of open Claude via Instellingen.', 'provider_error');

    const realModelId = options.modelId.replace(/^claude-cli:/, '');
    const prompt = buildHistoryPrompt(options.messages, options.systemPrompt, options.attachments || []);
    const effort = options.effort && CLAUDE_CLI_EFFORTS.includes(options.effort as ReasoningEffort) ? options.effort : undefined;

    // Native pad: Claude Code draait z'n eigen tools in de projectmap; elke tool gaat
    // langs de approval-popup via requestPermission. Alleen als PC-tools aanstaan en er
    // een projectmap + permissie-callback is — anders het gewone platte-tekst pad.
    if (options.nativeTools && options.cwd && options.requestPermission) {
      const native = await runClaudeNative({
        exe,
        modelId: realModelId,
        prompt,
        cwd: options.cwd,
        effort,
        agentMode: options.agentMode || 'ask',
        signal: options.signal,
        onDelta: options.onDelta,
        onStatus: options.onStatus,
        onToolActivity: options.onToolActivity,
        requestPermission: options.requestPermission,
      });
      const inputTokens = native.inputTokens || estimateTokens(prompt);
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: 200000,
          contextUsedPercent: Math.round((inputTokens / 200000) * 100),
        },
      };
    }

    // Claude Code CLI print mode (-p) reads the prompt from stdin when no positional
    // query is given; stdin avoids Windows command-line length limits.
    const args = claudeCliChatArgs(realModelId, options.effort);

    const { text } = await runProcess(
      exe,
      args,
      options.signal,
      (delta) => options.onDelta(delta),
      prompt,
      os.homedir(),
      claudeCliEnvironment(),
    );

    const cleanText = text.trim();
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(cleanText);

    return {
      text: cleanText,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: 200000,
        contextUsedPercent: Math.round((inputTokens / 200000) * 100),
      },
    };
  }

  async isAuthenticated(exe: string): Promise<boolean> {
    return cachedCliResult(`claude-auth:${executableFingerprint(exe)}`, 15_000, async () => {
      try {
        // Officiële, niet-interactieve logincontrole; runProcess ondersteunt ook
        // npm's .cmd-shim zonder een zichtbaar consolevenster te laten flitsen.
        await runProcess(
          exe,
          ['auth', 'status'],
          AbortSignal.timeout(10_000),
          () => { },
          undefined,
          os.homedir(),
          claudeCliEnvironment(),
        );
        return true;
      } catch {
        return false;
      }
    }, (authenticated) => authenticated);
  }

  private makeModel(id: string, name: string, contextWindow: number, maxOutput: number): AIModel {
    return {
      id: `claude-cli:${id}`,
      name: `${name} (CLI)`,
      provider: 'anthropic',
      contextWindow,
      maxOutputTokens: maxOutput,
      supportsVision: false,
      supportsFiles: true,
      supportsStreaming: false,
      source: 'cli',
      sourceLabel: 'Claude Code CLI',
      surfaceLabel: 'Claude CLI',
      providerSurface: 'cli',
      limitScope: 'account',
      limitGroupKey: limitGroupKey('anthropic', `claude-cli:${id}`),
      providerCategory: 'api',
      executionMode: 'chat',
      canChat: true,
      contextSource: 'estimate',
      supportedReasoningEfforts: CLAUDE_CLI_EFFORTS,
      defaultReasoningEffort: 'high',
    };
  }
}

const claudeCli = new ClaudeCliAdapter();

export async function getClaudeCliRuntimeStatus() {
  const executablePath = await claudeCli.executable();
  return {
    installed: !!executablePath,
    authenticated: executablePath ? await claudeCli.isAuthenticated(executablePath) : false,
    executablePath: executablePath || undefined,
  };
}

async function discoverClaudeCliModels(exe: string) {
  try {
    const { text } = await runProcess(
      exe,
      ['--help'],
      AbortSignal.timeout(10_000),
      () => { },
      undefined,
      os.homedir(),
      claudeCliEnvironment(),
    );
    const block = text.match(/--model\s+<model>([\s\S]*?)(?=\n\s{2}-[a-zA-Z]|$)/)?.[1] || '';
    const ids = [...block.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9._-]+)['"`]/g)].map((match) => match[1]);
    return [...new Set(ids)]
      .filter((id) => !['model', 'latest'].includes(id.toLowerCase()))
      .map((id) => ({
        id,
        name: id.replace(/^claude-/, 'Claude ').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      }));
  } catch {
    return [];
  }
}

class OllamaAdapter implements ProviderAdapter {
  id: ProviderType = 'ollama';
  private catalogCache?: { baseUrl: string; expiresAt: number; models: AIModel[] };

  invalidateModelCache() {
    this.catalogCache = undefined;
  }

  async listModels(): Promise<AIModel[]> {
    const baseUrl = await this.baseUrl();
    if (this.catalogCache?.baseUrl === baseUrl && this.catalogCache.expiresAt > Date.now()) return this.catalogCache.models;
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      await ensureOk(response, 'ollama');
      const data = (await response.json()) as { models?: any[] };
      const models = data.models || [];
      const details: any[] = new Array(models.length);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < models.length) {
          const index = nextIndex++;
          try {
            const show = await fetch(`${baseUrl}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(5000),
              body: JSON.stringify({ model: models[index].name }),
            });
            if (show.ok) details[index] = await show.json();
          } catch { /* modeldetail blijft onbekend */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, models.length)) }, () => worker()));
      const catalog: AIModel[] = models.map((model, index) => ({
        id: `ollama:${model.name}`,
        name: model.name,
        provider: 'ollama',
        contextWindow: ollamaContextWindow(details[index]) || DEFAULT_CONTEXT.ollama,
        maxOutputTokens: DEFAULT_OUTPUT.ollama,
        supportsVision: Array.isArray(details[index]?.capabilities) && details[index].capabilities.includes('vision'),
        supportsFiles: true,
        supportsStreaming: true,
        supportsTools: Array.isArray(details[index]?.capabilities) && details[index].capabilities.includes('tools'),
        supportsThinking: Array.isArray(details[index]?.capabilities) && details[index].capabilities.includes('thinking'),
        source: 'local',
        sourceLabel: 'Ollama local',
        surfaceLabel: 'Ollama local',
        providerSurface: 'local',
        limitScope: 'local',
        limitGroupKey: limitGroupKey('ollama', `ollama:${model.name}`),
        providerCategory: 'local',
        executionMode: 'chat',
        canChat: true,
        contextSource: ollamaContextWindow(details[index]) ? 'provider' : 'estimate',
      }));
      this.catalogCache = { baseUrl, expiresAt: Date.now() + 30_000, models: catalog };
      return catalog;
    } catch {
      return [];
    }
  }

  async validateCredential(): Promise<ValidationResult> {
    const id = cryptoId();
    const models = await this.listModels();
    return {
      id,
      keyMasked: 'local',
      provider: 'ollama',
      status: models.length ? 'valid' : 'invalid',
      models: topModels(models.map((model) => model.id)),
      error: models.length ? undefined : 'Ollama is not reachable.',
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const baseUrl = await this.baseUrl();
    const model = request.modelRef.modelId.replace(/^ollama:/, '');
    const messages: ChatMessage[] = request.systemPrompt
      ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
      : request.messages;
    const withAttachments = messages.map((message, index) => {
      if (message.role !== 'user') return message;
      const attached = attachmentsForMessage(message, request.attachments, index === messages.length - 1);
      return attached.length ? { ...message, content: appendTextAttachments(message.content, attached) } : message;
    });
    const discovered = (await this.listModels()).find((candidate) => candidate.id === request.modelRef.modelId);

    if (request.nativeTools && request.executeTool) {
      const native = await runOllamaNative({
        baseUrl,
        model,
        messages: withAttachments,
        signal: request.signal,
        executeTool: request.executeTool,
        requireToolUse: request.requireToolUse,
        supportsThinking: discovered?.supportsThinking,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.onToolActivity,
      });
      const inputTokens = native.inputTokens || estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.ollama,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.ollama) * 100),
        },
        rateLimit: makeUnknownLimit('ollama', model, 'Lokaal Ollama-model met native function calling.'),
      };
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify(ollamaChatRequestBody(model, withAttachments)),
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      throw new ProviderRuntimeError(
        `Ollama is not reachable at ${baseUrl}. Start Ollama or choose another model.`,
        'network',
      );
    }
    await ensureOk(response, 'ollama', model);
    if (!response.body) throw new ProviderRuntimeError('Ollama returned no response stream.', 'provider_error');

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let completed = false;

    for await (const data of parseOllamaNdjson(response)) {
      if (typeof data.error === 'string' && data.error) {
        throw new ProviderRuntimeError(data.error, 'provider_error');
      }
      const delta = typeof data.message?.content === 'string' ? data.message.content : '';
      if (delta) {
        text += delta;
        request.onDelta(delta);
      }
      if (typeof data.prompt_eval_count === 'number') inputTokens = data.prompt_eval_count;
      if (typeof data.eval_count === 'number') outputTokens = data.eval_count;
      if (data.done === true) completed = true;
    }
    if (!completed) {
      throw new ProviderRuntimeError(
        'Ollama-stream eindigde zonder een volledige done-respons.',
        'provider_error',
      );
    }

    if (!inputTokens) inputTokens = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
    if (!outputTokens) outputTokens = estimateTokens(text);
    const contextWindow = discovered?.contextWindow || DEFAULT_CONTEXT.ollama;

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: contextWindow,
        contextUsedPercent: Math.round((inputTokens / contextWindow) * 100),
      },
      rateLimit: makeUnknownLimit('ollama', model, 'Local Ollama has no provider quota. Context depends on the local model/runtime settings.'),
    };
  }

  async countTokens(_modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return makeUnknownLimit('ollama', modelId, 'Local Ollama has no subscription or API rate-limit reset.');
  }

  private async baseUrl() {
    const store = await getStore();
    return String(store.get('ollama.url') || 'http://localhost:11434').replace(/\/$/, '');
  }
}

function ollamaContextWindow(detail: any) {
  const modelInfo = detail?.model_info && typeof detail.model_info === 'object' ? detail.model_info : {};
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/context_length$/i.test(key) && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  }
  for (const line of String(detail?.parameters || '').split(/\r?\n/)) {
    const match = line.trim().match(/^num_ctx\s+(\d+)/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function codexCliChatArgs(
  modelId: string,
  reasoningEffort: string,
  serviceTier?: string,
) {
  return [
    'exec',
    // Zonder app-tools is Codex uitsluitend een geïsoleerd chattransport:
    // geen sessie, projectregels, gebruikersplugins of schrijfrechten.
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '-m', modelId,
    '-c', `model_reasoning_effort="${reasoningEffort}"`,
    ...(serviceTier ? ['-c', `service_tier="${serviceTier}"`] : []),
    '--skip-git-repo-check',
    '--json',
    '--color',
    'never',
  ];
}

/**
 * `visibility: "list"` is de autoritatieve Codex-pickerstatus. Een `upgrade`
 * is slechts een aanbeveling en mag een model dat Codex zelf nog toont niet
 * uit LLMelt verwijderen.
 */
export function listableCodexCatalogModels(catalog: unknown): any[] {
  if (!Array.isArray(catalog)) return [];
  return catalog.filter((model: any) => {
    if (model?.visibility && model.visibility !== 'list') return false;
    return !!String(model?.slug || model?.id || model || '');
  });
}

class CodexAdapter implements ProviderAdapter {
  id: ProviderType = 'codex';

  invalidateModelCache() {
    invalidateCachedCliResults('codex-catalog:');
  }

  async listModels(): Promise<AIModel[]> {
    const exe = await this.executable();
    const catalog = exe ? await this.modelCatalog(exe) : [];
    return listableCodexCatalogModels(catalog)
      .map((model: any) => this.toModel(model, !!exe))
      .sort((a: AIModel, b: AIModel) => (a.catalogPriority ?? Number.MAX_SAFE_INTEGER) - (b.catalogPriority ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async validateCredential(): Promise<ValidationResult> {
    const exe = await this.executable();
    const id = cryptoId();
    if (!exe) {
      return {
        id,
        keyMasked: 'missing',
        provider: 'codex',
        status: 'invalid',
        error: 'Codex CLI was not found on PATH or known install paths.',
      };
    }

    // De catalogus kan ook vóór een accountlogin leesbaar zijn. Alleen de
    // officiële `codex login status`-controle mag daarom auth bevestigen.
    const authenticated = await this.loginStatus(exe);
    return {
      id,
      keyMasked: path.basename(exe),
      provider: 'codex',
      status: authenticated ? 'valid' : 'invalid',
      error: authenticated ? undefined : 'Codex CLI was found, but it is not signed in. Open Codex once and sign in.',
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const exe = await this.executable();
    if (!exe) throw new ProviderRuntimeError('Codex CLI was not found. Install/configure Codex before using this provider.', 'provider_error');
    const store = await getStore();
    const parsed = this.parseModelId(request.modelRef.modelId);
    const reasoningEffort = normalizeReasoningEffort(
      request.modelRef.runConfig?.reasoningEffort ||
      parsed.runConfig.reasoningEffort ||
      (store.get('codex.reasoningEffort') as string | undefined),
      'high',
    );
    const requestedTier = normalizeServiceTier(request.modelRef.runConfig?.serviceTier || (store.get('codex.serviceTier') as string | undefined));
    const timeoutSeconds = Number(request.modelRef.runConfig?.timeoutSeconds || store.get('codex.timeoutSeconds') || 180);
    const prompt = buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments);
    // Codex' config.toml only accepts fast/flex for service_tier — anything else
    // (standard/default/priority/stale values) makes the CLI error out. So only ever
    // pass fast/flex; everything else means "use Codex' default" (omit the override).
    const serviceTier = codexCliServiceTier(requestedTier);

    // Native: Codex draait z'n eigen tools in de projectmap via `codex mcp-server`, met
    // per-actie-goedkeuring (elicitation → popup). Alleen als PC-tools aan + projectmap + callback.
    if (request.nativeTools && request.cwd && request.requestPermission) {
      const native = await runCodexNative({
        exe,
        model: parsed.baseModelId,
        prompt,
        cwd: request.cwd,
        agentMode: request.agentMode || 'ask',
        reasoningEffort,
        serviceTier: serviceTier || undefined,
        timeoutSeconds,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.onToolActivity,
        requestPermission: request.requestPermission,
      });
      const inputTokens = native.inputTokens || estimateTokens(prompt);
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.codex,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.codex) * 100),
        },
        rateLimit: makeUnknownLimit('codex', request.modelRef.modelId, 'Codex subscription/CLI limits are not exposed as stable API headers.'),
        runConfig: {
          baseModelId: parsed.baseModelId,
          reasoningEffort,
          ...(serviceTier ? { serviceTier } : {}),
          timeoutSeconds,
        },
      };
    }

    const args = codexCliChatArgs(parsed.baseModelId, reasoningEffort, serviceTier || undefined);
    const { text } = await runCodexAgent({
      exe,
      args,
      prompt,
      signal: request.signal,
      timeoutSeconds,
      onStatus: request.onStatus || (() => { }),
    });
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(text);
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.codex,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.codex) * 100),
      },
      rateLimit: makeUnknownLimit('codex', request.modelRef.modelId, 'Codex subscription/CLI limits are not exposed as stable API headers.'),
      runConfig: {
        baseModelId: parsed.baseModelId,
        reasoningEffort,
        ...(serviceTier ? { serviceTier } : {}),
        timeoutSeconds,
      },
    };
  }

  async countTokens(_modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return makeUnknownLimit('codex', modelId, 'Codex CLI limits are not exposed through this app.');
  }

  private async executable() {
    const store = await getStore();
    const configured = store.get('codex.executable') as string | undefined;
    return findExecutable(codexExecutableCandidates(configured));
  }

  private async loginStatus(exe: string) {
    const cacheKey = `codex-login:${executableFingerprint(exe)}`;
    return cachedCliResult(cacheKey, 60 * 1000, async () => {
      try {
        // Override stale values such as service_tier="default" before Codex parses
        // the user's config. Current desktop builds only accept fast/flex here.
        await runProcess(
          exe,
          codexSafePreflightArgs('login', 'status'),
          AbortSignal.timeout(10000),
          () => { },
        );
        return true;
      } catch {
        return false;
      }
    }, (loggedIn) => loggedIn);
  }

  private async modelCatalog(exe: string) {
    const cacheKey = `codex-catalog:${executableFingerprint(exe)}`;
    return cachedCliResult(cacheKey, 60_000, async () => {
      try {
        const { text } = await runProcess(
          exe,
          codexSafePreflightArgs('debug', 'models'),
          AbortSignal.timeout(10000),
          () => { },
        );
        const parsed = JSON.parse(text);
        const models = Array.isArray(parsed.models) ? parsed.models : [];
        if (!codexTiersLogged && models.length) {
          codexTiersLogged = true;
          console.log('[codex] catalog tiers:', models.map((m: any) => ({
            slug: m.slug || m.id,
            service_tiers: m.service_tiers || m.serviceTiers || m.supported_service_tiers,
            additional_speed_tiers: m.additional_speed_tiers || m.additionalSpeedTiers,
          })));
        }
        return models;
      } catch {
        return [];
      }
    }, (models) => Array.isArray(models) && models.length > 0, { persist: false });
  }

  private async supportedServiceTiers(exe: string, modelId: string): Promise<ServiceTier[]> {
    const catalog = await this.modelCatalog(exe);
    const found = catalog.find((model: any) => String(model.slug || model.id || model) === modelId);
    return found ? codexServiceTiers(found) : ['standard'];
  }

  private toModel(model: any, cliAvailable: boolean): AIModel {
    const slug = String(model.slug || model.id || model);
    const displayName = String(model.display_name || model.displayName || slug);
    const supportedReasoningEfforts = normalizeReasoningEfforts(model.supported_reasoning_levels);
    const supportedServiceTiers = codexServiceTiers(model);
    const catalogPriority = Number(model.priority);
    const cliDefaultReasoningEffort = normalizeReasoningEffort(model.default_reasoning_level, 'high');
    const defaultReasoningEffort = supportedReasoningEfforts.includes(cliDefaultReasoningEffort)
      ? cliDefaultReasoningEffort
      : (supportedReasoningEfforts.includes('high') ? 'high' : supportedReasoningEfforts[0] || 'high');
    const contextWindow = numericCatalogField(model, ['context_window', 'contextWindow', 'max_input_tokens', 'maxInputTokens']) || DEFAULT_CONTEXT.codex;
    const maxOutputTokens = numericCatalogField(model, ['max_output_tokens', 'maxOutputTokens', 'output_token_limit', 'outputTokenLimit']) || DEFAULT_OUTPUT.codex;

    return {
      id: slug,
      name: displayName,
      provider: 'codex',
      contextWindow,
      maxOutputTokens,
      supportsVision: false,
      supportsFiles: true,
      supportsStreaming: false,
      source: cliAvailable ? 'cli' : 'manual',
      sourceLabel: 'Codex CLI agent',
      surfaceLabel: 'Codex CLI',
      providerSurface: 'cli',
      limitScope: 'account',
      limitGroupKey: limitGroupKey('codex', slug),
      isRecommended: Number(model.priority) === 1,
      providerCategory: 'agent',
      executionMode: 'agent',
      canChat: cliAvailable,
      contextSource: contextWindow === DEFAULT_CONTEXT.codex ? 'estimate' : 'cli',
      catalogPriority: Number.isFinite(catalogPriority) ? catalogPriority : undefined,
      supportedReasoningEfforts,
      supportedServiceTiers,
      defaultReasoningEffort,
      runConfig: {
        baseModelId: slug,
        reasoningEffort: defaultReasoningEffort,
        // Default to the model's first tier (Codex' own default is the standard tier).
        ...(supportedServiceTiers.length ? { serviceTier: supportedServiceTiers[0] } : {}),
      },
    };
  }

  private parseModelId(modelId: string) {
    const [baseModelId, mode] = modelId.split('#');
    const modeEffort: Record<string, ReasoningEffort | undefined> = {
      instant: 'low',
      thinking: 'high',
      pro: 'xhigh',
    };
    return {
      baseModelId,
      mode,
      runConfig: {
        baseModelId,
        reasoningEffort: mode ? modeEffort[mode] : undefined,
      } satisfies ModelRunConfig,
    };
  }
}

class AntigravityAdapter implements ProviderAdapter {
  id: ProviderType = 'antigravity';

  invalidateModelCache() {
    invalidateCachedCliResults('agy-models:');
  }

  // Haalt de modellen live op via `agy models`. Recente CLI-versies leveren slugs
  // zoals `gemini-3.6-flash-medium`; oudere versies leverden displaynamen. De
  // renderer begrijpt beide vormen en deze ongewijzigde waarde blijft het --model-id.
  private async fetchModelNames(exe: string): Promise<string[]> {
    return cachedCliResult(`agy-models:${executableFingerprint(exe)}`, 3 * 60 * 60 * 1000, async () => {
      const { text } = await runProcess(exe, ['models'], AbortSignal.timeout(20000), () => { }, undefined, os.homedir());
      return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    });
  }

  async listModels(): Promise<AIModel[]> {
    const exe = await this.executable();
    if (!exe) return [];
    let names: string[] = [];
    try {
      names = await this.fetchModelNames(exe);
    } catch {
      return [];
    }
    return names.map((name) => ({
      id: name,
      name,
      provider: 'antigravity',
      contextWindow: DEFAULT_CONTEXT.antigravity,
      maxOutputTokens: DEFAULT_OUTPUT.antigravity,
      supportsVision: false,
      supportsFiles: true,
      supportsStreaming: false,
      supportsTools: true,
      source: 'cli',
      sourceLabel: 'Antigravity CLI',
      surfaceLabel: 'Antigravity CLI',
      providerSurface: 'cli',
      limitScope: 'account',
      limitGroupKey: limitGroupKey('antigravity', name),
      providerCategory: 'agent',
      executionMode: 'agent',
      canChat: true,
      contextSource: 'estimate',
    }));
  }

  async validateCredential(): Promise<ValidationResult> {
    const exe = await this.executable();
    if (!exe) {
      return {
        id: cryptoId(),
        keyMasked: 'missing',
        provider: 'antigravity',
        status: 'invalid',
        reasonCode: 'invalid_key',
        error: 'Antigravity CLI (agy) niet gevonden. Installeer via https://antigravity.google/cli of stel antigravity.executable in.',
      };
    }
    try {
      const names = await this.fetchModelNames(exe);
      if (!names.length) {
        return {
          id: cryptoId(),
          keyMasked: path.basename(exe),
          provider: 'antigravity',
          status: 'limited',
          reasonCode: 'no_models',
          error: 'agy gevonden, maar geen modellen — waarschijnlijk niet ingelogd. Draai `agy` één keer in een terminal om in te loggen.',
        };
      }
      return {
        id: cryptoId(),
        keyMasked: path.basename(exe),
        provider: 'antigravity',
        status: 'valid',
        models: topModels(names),
        details: `Antigravity CLI werkt — ${names.length} modellen beschikbaar.`,
      };
    } catch (error: any) {
      return {
        id: cryptoId(),
        keyMasked: path.basename(exe),
        provider: 'antigravity',
        status: 'invalid',
        reasonCode: 'unknown',
        error: error?.message || String(error),
      };
    }
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const exe = await this.executable();
    if (!exe) {
      throw new ProviderRuntimeError('Antigravity CLI (agy) niet gevonden. Installeer via https://antigravity.google/cli.', 'provider_error');
    }
    const prompt = buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments);
    if (request.nativeTools && request.cwd && request.agentMode && request.requestPermission) {
      const native = await runAntigravityNative({
        exe,
        modelId: request.modelRef.modelId,
        prompt,
        cwd: request.cwd,
        agentMode: request.agentMode,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.onToolActivity,
        requestPermission: request.requestPermission,
      });
      const inputTokens = estimateTokens(prompt);
      const outputTokens = estimateTokens(native.text);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.antigravity,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.antigravity) * 100),
        },
        rateLimit: makeUnknownLimit('antigravity', request.modelRef.modelId, 'Antigravity CLI-account met native tools en app-approvalhooks.'),
      };
    }
    // Antigravity's print mode expects the prompt as the value of -p/--print.
    // Keep -p last so --model is parsed as a flag instead of accidentally
    // becoming the prompt. Do not pipe stdin here: on Windows agy headless runs
    // are sensitive to non-TTY stdin and can return empty or stale output.
    const promptTransport = await createAntigravityPromptTransport(prompt);
    let text = '';
    try {
      const args = [
        '--mode', 'plan',
        '--sandbox',
        ...(promptTransport.file ? ['--add-dir', path.dirname(promptTransport.file)] : []),
        '--model', request.modelRef.modelId,
        '--print-timeout', '180s',
        '-p', promptTransport.prompt,
      ];
      ({ text } = await runProcess(
        exe,
        args,
        request.signal,
        (delta) => request.onDelta(delta),
        undefined,
        os.homedir(),
      ));
    } finally {
      await promptTransport.cleanup();
    }
    const cleanText = text.trim();
    if (!cleanText) {
      throw new ProviderRuntimeError(
        'Antigravity CLI gaf geen uitvoer terug in headless print mode. Open `agy` een keer handmatig of kies voorlopig Codex/ChatGPT voor normale chat.',
        'provider_error',
      );
    }
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(cleanText);
    return {
      text: cleanText,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.antigravity,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.antigravity) * 100),
      },
      rateLimit: makeUnknownLimit('antigravity', request.modelRef.modelId, 'Antigravity plan limits are not exposed through stable API headers.'),
    };
  }

  async countTokens(_modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return makeUnknownLimit('antigravity', modelId, 'Antigravity plan limits are not exposed through stable API headers.');
  }

  private async executable() {
    const store = await getStore();
    const configured = store.get('antigravity.executable') as string | undefined;
    return findExecutable(antigravityExecutableCandidates(configured));
  }
}

class RemoteAdapter implements ProviderAdapter {
  id: ProviderType = 'remote';

  async listModels(): Promise<AIModel[]> {
    const store = await getStore();
    const configured = store.get('remote.models') as string[] | undefined;
    const config = await getRemoteSshConfig();
    const discovered = config?.host && config?.user ? await discoverRemoteOllamaModels(store, config).catch(() => []) : [];
    return (discovered.length ? discovered : configured?.length ? configured : []).map((model) => ({
      id: model,
      name: model,
      provider: 'remote',
      contextWindow: DEFAULT_CONTEXT.remote,
      maxOutputTokens: DEFAULT_OUTPUT.remote,
      supportsVision: false,
      supportsFiles: true,
      supportsStreaming: true,
      source: 'manual',
      sourceLabel: 'Remote SSH',
      surfaceLabel: 'Remote SSH',
      providerSurface: 'remote',
      limitScope: 'local',
      limitGroupKey: limitGroupKey('remote', model),
      providerCategory: 'local',
      executionMode: 'chat',
      canChat: true,
      contextSource: 'unknown',
    }));
  }

  async validateCredential(): Promise<ValidationResult> {
    const { Client } = await import('ssh2');
    const store = await getStore();
    const config = await getRemoteSshConfig();
    if (!config?.host || !config?.user) {
      return { id: cryptoId(), keyMasked: 'ontbreekt', provider: 'remote', status: 'invalid', error: 'Remote SSH is niet ingesteld.' };
    }
    return new Promise<ValidationResult>((resolve) => {
      const conn = new Client();
      let settled = false;
      const finish = (status: 'valid' | 'invalid', error?: string) => {
        if (settled) return;
        settled = true;
        conn.end();
        resolve({
          id: cryptoId(),
          keyMasked: `${config.user}@${config.host}`,
          provider: 'remote',
          status,
          error,
          details: status === 'valid' ? 'SSH-verbinding en hostvingerafdruk zijn gecontroleerd.' : undefined,
        });
      };
      conn.on('ready', () => finish('valid'))
        .on('error', (error: Error) => finish('invalid', `SSH-verbinding mislukt: ${error.message}`))
        .connect({
          host: config.host,
          port: Number(config.port || 22),
          username: config.user,
          password: config.password || config.key,
          privateKey: config.privateKey,
          readyTimeout: 10_000,
          hostHash: 'sha256',
          hostVerifier: (fingerprint: string) => verifyOrRememberSshHost(store, config, fingerprint),
        });
    });
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const { Client } = await import('ssh2');
    const store = await getStore();
    const config = await getRemoteSshConfig();
    if (!config?.host || !config?.user) {
      throw new ProviderRuntimeError('Remote SSH is not configured.', 'auth_failed');
    }

    const prompt = buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments);
    const command = `ollama run ${posixShellQuote(request.modelRef.modelId)}`;

    const text = await new Promise<string>((resolve, reject) => {
      const conn = new Client();
      let output = '';
      let errorOutput = '';
      let exitCode: number | undefined;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        conn.end();
        if (error) reject(error);
        else resolve(output);
      };

      request.signal.addEventListener('abort', () => finish(new ProviderRuntimeError('Remote request cancelled.', 'cancelled')));

      conn
        .on('ready', () => {
          conn.exec(command, (error: any, stream: any) => {
            if (error) return finish(error);
            stream
              .on('exit', (code: number) => { exitCode = code; })
              .on('close', () => {
                if (exitCode && exitCode !== 0) finish(new ProviderRuntimeError(`Remote Ollama stopte met code ${exitCode}: ${errorOutput.slice(0, 4000)}`, 'provider_error'));
                else finish();
              })
              .on('data', (data: Buffer) => {
                const delta = data.toString();
                output += delta;
                if (Buffer.byteLength(output, 'utf8') > 5 * 1024 * 1024) return finish(new ProviderRuntimeError('Remote antwoord is groter dan 5 MB.', 'provider_error'));
                request.onDelta(delta);
              });
            stream.stderr.on('data', (data: Buffer) => { errorOutput = `${errorOutput}${data.toString()}`.slice(-100_000); });
            stream.end(prompt);
          });
        })
        .on('error', (error: any) => finish(new ProviderRuntimeError(`SSH connection failed: ${error.message}`, 'network')))
        .connect({
          host: config.host,
          port: Number(config.port || 22),
          username: config.user,
          password: config.password || config.key,
          privateKey: config.privateKey,
          readyTimeout: 15_000,
          hostHash: 'sha256',
          hostVerifier: (fingerprint: string) => verifyOrRememberSshHost(store, config, fingerprint),
        });
    });

    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(text);
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.remote,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.remote) * 100),
      },
      rateLimit: makeUnknownLimit('remote', request.modelRef.modelId, 'Remote quota depends on the server runtime.'),
    };
  }

  async countTokens(_modelId: string, messages: ChatMessage[], systemPrompt?: string): Promise<number> {
    return estimateTokens(buildHistoryPrompt(messages, systemPrompt));
  }

  async getRateLimitState(modelId?: string): Promise<RateLimitSnapshot> {
    return makeUnknownLimit('remote', modelId, 'Remote quota depends on the server runtime.');
  }
}

function emptyUsage(provider: ProviderType, modelId: string): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextWindowSize: DEFAULT_CONTEXT[provider],
    contextUsedPercent: 0,
  };
}

function usageFromOpenAI(usage: any, modelId: string): TokenUsage {
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || inputTokens + outputTokens;
  const contextWindowSize = modelFromOpenAI(modelId).contextWindow;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0,
    contextWindowSize,
    contextUsedPercent: Math.round((inputTokens / contextWindowSize) * 100),
  };
}

async function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  input?: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = agentCommandEnvironment(),
) {
  if (signal.aborted) {
    return Promise.reject(new ProviderRuntimeError('Process request cancelled.', 'cancelled'));
  }
  return new Promise<{ text: string }>((resolve, reject) => {
    // Windows kan een .cmd/.bat (zoals npm's `claude.cmd`) niet direct via spawn
    // starten — dat gooit EINVAL sinds Node's security-fix. Draai die via
    // `cmd.exe /c`; Node quote't de args dan veilig (geen shell-injectie).
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
    const onAbort = () => finish(new ProviderRuntimeError('Process request cancelled.', 'cancelled'));
    const timeoutTimer = setTimeout(() => {
      finish(new ProviderRuntimeError('CLI-proces stopte niet binnen 600 seconden.', 'network'));
    }, 600_000);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }

    if (proc.stdin) {
      // Avoid an unhandled EPIPE crash if the child closes stdin early.
      proc.stdin.on('error', () => { });
      if (input !== undefined) {
        proc.stdin.write(input);
      }
      // Always close stdin. CLIs like `agy models` read stdin and block waiting
      // for EOF; without this they hang until the abort timeout fires.
      proc.stdin.end();
    }

    proc.stdout?.on('data', (data) => {
      const delta = data.toString();
      text += delta;
      if (text.length > 5_000_000) {
        finish(new ProviderRuntimeError('CLI-uitvoer overschreed de limiet van 5 MB.', 'provider_error'));
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
        finish(new ProviderRuntimeError(errorText || `${path.basename(command)} exited with ${code ?? 'onbekend'}`, 'provider_error'));
      } else {
        finish();
      }
    });
  });
}

async function runCodexAgent(options: {
  exe: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  timeoutSeconds: number;
  onStatus: (status: string) => void;
}) {
  if (options.signal.aborted) throw new ProviderRuntimeError('Codex request cancelled.', 'cancelled');
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
        options.onStatus(`Codex draait: ${seconds}s`);
      };

      const statusTimer = setInterval(publishStatus, 1000);
      const timeoutTimer = setTimeout(() => {
        finish(new ProviderRuntimeError(`Codex timed out after ${options.timeoutSeconds}s.`, 'network'));
      }, Math.max(1, options.timeoutSeconds) * 1000);
      const abortHandler = () => finish(new ProviderRuntimeError('Codex request cancelled.', 'cancelled'));

      options.signal.addEventListener('abort', abortHandler);
      publishStatus();

      proc.stdin.on('error', () => {
        // Een vroeg gestopte npm-shim mag geen onbehandelde EPIPE veroorzaken.
      });

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) parseCodexJsonStatus(line, options.onStatus);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => finish(new ProviderRuntimeError(error.message, 'provider_error')));
      proc.on('close', (code) => {
        if (stdoutBuffer) parseCodexJsonStatus(stdoutBuffer, options.onStatus);
        if (code !== 0) {
          const codexError = extractCodexError(stdout) || extractCodexError(stderr);
          finish(new ProviderRuntimeError(
            codexError || cleanProcessError(stderr || stdout || `Codex exited with ${code ?? 'onbekend'}`),
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
        codexError || cleanProcessError(result.stderr || result.stdout || 'Codex returned no final message.'),
        codexError && /usage limit|rate limit|quota/i.test(codexError) ? 'rate_limit' : 'provider_error',
      );
    }
    return { text };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

function parseCodexJsonStatus(line: string, onStatus: (status: string) => void) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const type = String(event.type || event.event || event.msg?.type || '');
    if (/error/i.test(type)) {
      const message = event.message || event.error?.message || event.msg?.message;
      if (message) onStatus(`Codex fout: ${message}`);
      return;
    }
    if (/tool|exec|command|turn|task|agent/i.test(type)) {
      onStatus(`Codex agent: ${type}`);
    }
  } catch {
    // Non-JSON output is intentionally ignored; the final answer comes from --output-last-message.
  }
}

function extractCodexError(output: string): string | null {
  // Codex exec emits a JSON event stream. On failure it includes error /
  // turn.failed events with the real message (e.g. "You've hit your usage limit…").
  // Pull that out instead of dumping the whole stream.
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      const type = String(event.type || '');
      const candidate =
        event.error?.message ||
        (type === 'error' ? event.message : undefined) ||
        (type === 'item.completed' && event.item?.type === 'error' ? event.item?.message : undefined);
      // The "malformed agent role" line is a non-fatal config warning, not the cause.
      if (candidate && !/malformed agent role/i.test(String(candidate))) {
        return String(candidate);
      }
    } catch {
      // ignore non-JSON lines
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
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
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

function cleanProcessError(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  // Strip Codex/CLI log noise (timestamped WARN/INFO/DEBUG lines) so the real
  // error surfaces instead of a wall of warnings.
  const cleaned = normalized
    .split('\n')
    .filter((line) => !/\b(WARN|INFO|DEBUG|TRACE)\b/.test(line))
    .filter((line) => !/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s/.test(line.trim()))
    .join('\n')
    .trim();
  if (cleaned) return cleaned.slice(0, 2000);
  return 'De CLI gaf geen leesbaar antwoord, alleen waarschuwingen. Controleer je CLI-configuratie/plugins en of het gekozen model beschikbaar is.';
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function geminiSmokeCandidates(models: string[]) {
  return [...new Set(models)].sort((a, b) =>
    googleModelCatalogPriority(a) - googleModelCatalogPriority(b)
    || a.localeCompare(b, undefined, { numeric: true }),
  );
}

async function discoverRemoteOllamaModels(store: any, config: Record<string, any>) {
  const { Client } = await import('ssh2');
  return new Promise<string[]>((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      conn.end();
      if (error) reject(error);
      else resolve(output.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
    };
    conn.on('ready', () => {
      conn.exec('ollama list', (error: Error | undefined, stream: any) => {
        if (error) return finish(error);
        stream.on('data', (data: Buffer) => { output = `${output}${data.toString()}`.slice(0, 1_000_000); });
        stream.stderr.on('data', (data: Buffer) => { stderr = `${stderr}${data.toString()}`.slice(-20_000); });
        stream.on('close', (code: number) => finish(code ? new Error(stderr || `ollama list stopte met code ${code}`) : undefined));
      });
    }).on('error', (error: Error) => finish(error)).connect({
      host: config.host,
      port: Number(config.port || 22),
      username: config.user,
      password: config.password || config.key,
      privateKey: config.privateKey,
      readyTimeout: 10_000,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => verifyOrRememberSshHost(store, config, fingerprint),
    });
  });
}

function googleModelCatalogPriority(id: string) {
  // De Google-endpoint levert ook Gemma en gespecialiseerde modellen. Binnen de
  // Gemini-provider krijgt de Gemini-familie voorrang; versies blijven volledig live.
  const familyOffset = /^gemini-/i.test(id) ? 0 : 100;
  return familyOffset - modelVersionRank(id);
}

export function pickOpenAISmokeModel(models: string[]) {
  return [...new Set(models)].sort((a, b) =>
    Number(!/mini|nano/i.test(a)) - Number(!/mini|nano/i.test(b))
    || modelVersionRank(b) - modelVersionRank(a)
    || a.localeCompare(b, undefined, { numeric: true }),
  )[0];
}

function pickAnthropicSmokeModel(models: string[]) {
  return models.find((id) => id.includes('haiku')) || models.find((id) => id.includes('sonnet')) || models[0];
}

// Sorteert modellen nieuwste-eerst op het versienummer in de naam
// (bv. 3.5 > 3.1 > 3 > 2.5). Volledig generiek — leest live uit de provider,
// geen hardcoded lijst. Datum-achtige achtervoegsels tellen niet als versie.
function modelVersionRank(id: string): number {
  // Eerst een expliciete decimale versie zoals 3.5, 2.5, 4.1.
  const decimal = id.match(/(?<!\d)(\d{1,2})\.(\d+)(?!\d)/);
  if (decimal) return Number(decimal[1]) + Number(decimal[2]) / 1000;
  // Anders het eerste losse getal 1-99 (geen jaartal, geen leading zero zoals -04-2026).
  const single = id.match(/(?<![\d.])([1-9]\d?)(?![\d])/);
  if (single) return Number(single[1]);
  return -1;
}

function topModels(models: string[], limit = 24): string[] {
  return [...new Set(models)]
    .sort((a, b) => modelVersionRank(b) - modelVersionRank(a))
    .slice(0, limit);
}

function numericCatalogField(model: any, keys: string[]) {
  for (const key of keys) {
    const value = Number(model?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function maskKey(key: string) {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function posixShellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function googleCatalogCapabilities(model: any) {
  const raw = [
    ...(Array.isArray(model?.capabilities) ? model.capabilities : []),
    ...(Array.isArray(model?.supportedCapabilities) ? model.supportedCapabilities : []),
    ...(Array.isArray(model?.supportedInputModalities) ? model.supportedInputModalities : []),
    ...(Array.isArray(model?.inputModalities) ? model.inputModalities : []),
  ].map((value) => String(value).toLowerCase().replace(/[^a-z]/g, ''));
  return {
    vision: raw.some((value) => value === 'image' || value === 'vision' || value === 'multimodal'),
    tools: raw.some((value) => value === 'tools' || value === 'functioncalling' || value === 'functioncall'),
  };
}

async function createAntigravityPromptTransport(prompt: string) {
  if (process.platform !== 'win32' || prompt.length <= 20_000) {
    return { prompt, file: undefined as string | undefined, cleanup: async () => { } };
  }
  const file = path.join(os.tmpdir(), `ai-superapp-agy-prompt-${crypto.randomBytes(8).toString('hex')}.txt`);
  await fs.promises.writeFile(file, prompt, { encoding: 'utf8', flag: 'wx' });
  return {
    prompt: `Lees de volledige gebruikersopdracht uit dit UTF-8-bestand en beantwoord die exact: ${file}`,
    file,
    cleanup: () => fs.promises.rm(file, { force: true }).then(() => undefined),
  };
}

async function getRemoteSshConfig() {
  const store = await getStore();
  const raw = (store.get('sshConfig') || {}) as Record<string, any>;
  let secret: Record<string, string> = {};
  const protectedCredential = await getCredential('remote');
  if (protectedCredential.value) {
    try { secret = JSON.parse(protectedCredential.value); } catch { /* oude waarde negeren */ }
  }
  if ((raw.password || raw.privateKey || raw.key) && !protectedCredential.value) {
    secret = { password: raw.password || raw.key || '', privateKey: raw.privateKey || '' };
    await saveCredential('remote', JSON.stringify(secret), 'apikey');
    store.set('sshConfig', { host: raw.host || '', port: raw.port || '22', user: raw.user || '' });
  }
  return { ...raw, ...secret };
}

function verifyOrRememberSshHost(store: any, config: Record<string, any>, fingerprint: string) {
  const id = `${String(config.host || '').toLowerCase()}:${Number(config.port || 22)}`;
  const fingerprints = { ...((store.get('sshHostFingerprints') || {}) as Record<string, string>) };
  const known = fingerprints[id];
  if (known) {
    const left = Buffer.from(known);
    const right = Buffer.from(fingerprint);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
  fingerprints[id] = fingerprint;
  store.set('sshHostFingerprints', fingerprints);
  return true;
}

export function createAdapters(): Record<ProviderType, ProviderAdapter> {
  return {
    openai: new OpenAIAdapter(),
    anthropic: new AnthropicAdapter(),
    google: new GoogleAdapter(),
    ollama: new OllamaAdapter(),
    codex: new CodexAdapter(),
    antigravity: new AntigravityAdapter(),
    remote: new RemoteAdapter(),
  };
}

export function classifyProviderError(error: unknown): { reason: FallbackReason; message: string; rateLimit?: RateLimitSnapshot } {
  const message = (error as any)?.message || String(error);
  // Een gedeeltelijk uitgevoerde native beurt mag naar een fallback, omdat de
  // IPC-laag de uitgevoerde acties nu duurzaam bijhoudt en duplicaten blokkeert.
  // Een expliciet safety-signaal blijft echter altijd leidend; adapters zetten
  // dit alleen wanneer hervatten aantoonbaar onveilig is.
  if ((error as any)?.preventFallback === true) return { reason: 'provider_error', message };
  if (error instanceof ProviderRuntimeError) {
    return { reason: error.reason, message: error.message, rateLimit: error.rateLimit };
  }
  if ((error as any)?.name === 'AbortError') {
    return { reason: 'cancelled', message: 'Request cancelled.' };
  }
  if (/rate|quota|429/i.test(message)) return { reason: 'rate_limit', message };
  if (/context|token limit|too large/i.test(message)) return { reason: 'context_exceeded', message };
  if (/auth|key|unauthor|forbidden/i.test(message)) return { reason: 'auth_failed', message };
  if (/network|fetch|timeout|socket|dns/i.test(message)) return { reason: 'network', message };
  return { reason: 'provider_error', message };
}

export function rateLimitKey(snapshot: RateLimitSnapshot) {
  return snapshot.limitGroupKey || modelKey(snapshot.provider, snapshot.modelId);
}

export async function createPromptTempFile(prompt: string) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-'));
  const file = path.join(dir, 'prompt.txt');
  await fs.promises.writeFile(file, prompt, 'utf8');
  return file;
}
