import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { query as queryClaudeCode, type ModelInfo as ClaudeModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentApprovalMode,
  AIModel,
  ChatMessage,
  ContextSource,
  FallbackReason,
  ProviderType,
  RateLimitSnapshot,
  ReasoningEffort,
  ServiceTier,
  TokenUsage,
  UiLanguage,
  ValidationReasonCode,
  ValidationResult,
} from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import { normalizeLegacyModelId } from '../src/providers/model-ref-normalization';
import { getCredential, saveCredential } from './credential-store';
import { getStore } from './settings-store';
import { chatgptScraper } from './chatgpt-scraper';
import { claudeCliEnvironment, runClaudeNative } from './claude-native';
import { claudeCliModelsFromHelp, claudeCliModelsFromSupportedModels } from './claude-cli-catalog';
import {
  additionalRegistryModels,
  catalogAnchor,
  catalogWindowBytes,
  findRegistryModel,
  parseClaudeModelCatalog,
  reasoningEffortsFromCapabilities,
  type ClaudeRegistryModel,
} from './claude-model-registry';
import { claudeCliLoggedInFromStatus } from './claude-cli-status';
import { cliOptionChoicesFromHelp, reasoningEffortsFromCliHelp } from './cli-run-capabilities';
import { runCodexNative } from './codex-native';
import { codexAppServer } from './codex-app-server';
import { normalizeAntigravityModelCatalog, parseAntigravityModelCatalog } from './antigravity-model-catalog';
import { runOllamaNative } from './ollama-native';
import { ollamaChatRequestBody, parseOllamaNdjson } from './ollama-stream';
import { runGeminiApiNative, type GeminiContent } from './gemini-api-native';
import { runAntigravityNative } from './antigravity-native';
import {
  ProviderRuntimeError,
  type AdapterChatRequest,
  type AdapterChatResult,
  type AttachmentRecord,
  type CredentialValidationOptions,
  type ProviderAdapter,
} from './provider-runtime';
import type { NativeToolActivity } from './native-tools';
export {
  ProviderRuntimeError,
  classifyProviderError,
  rateLimitKey,
  type AdapterChatRequest,
  type AdapterChatResult,
  type AttachmentRecord,
  type CredentialValidationOptions,
  type ProviderAdapter,
} from './provider-runtime';
import {
  antigravityExecutableCandidates,
  claudeExecutableCandidates,
  codexExecutableCandidates,
  findCliExecutable as findExecutable,
} from './cli-discovery';
import { codexCliServiceTier, codexRecoveredPreflightArgs, codexSafePreflightArgs, codexServiceTiersFromCatalog } from '../src/components/codex-utils';
import { cliSpawnSpec, terminateProcessTree } from './process-utils';
import { agentCommandEnvironment } from './agent-command-environment';
import { runCodexAgent, runProviderProcess as runProcess } from './provider-process';

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

function nowIso() {
  return new Date().toISOString();
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const effort = value.trim();
  return /^[a-z][a-z0-9._-]*$/i.test(effort) ? effort : undefined;
}

function normalizeReasoningEfforts(value: unknown): ReasoningEffort[] {
  const raw = Array.isArray(value) ? value : [];
  const efforts = raw
    .map((level: any) => (typeof level === 'string' ? level : level?.effort))
    .map((effort) => normalizeReasoningEffort(effort))
    .filter((effort): effort is ReasoningEffort => !!effort);
  return Array.from(new Set(efforts));
}

export function selectAdvertisedReasoningEffort(
  supported: ReasoningEffort[],
  requested?: unknown,
  advertisedDefault?: unknown,
): ReasoningEffort | undefined {
  const requestedEffort = normalizeReasoningEffort(requested);
  if (requestedEffort && supported.includes(requestedEffort)) return requestedEffort;
  const defaultEffort = normalizeReasoningEffort(advertisedDefault);
  return defaultEffort && supported.includes(defaultEffort) ? defaultEffort : undefined;
}

let codexTiersLogged = false;

function normalizeServiceTier(value: unknown): ServiceTier | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v || undefined;
}

// Codex publiceert instelbare snelheden in `additional_speed_tiers`; alleen die
// live waarden worden als configoverride aangeboden. `standard` is het expliciete
// UI-pad waarmee geen service_tier-override wordt meegestuurd.
function codexServiceTiers(model: any): ServiceTier[] {
  return codexServiceTiersFromCatalog(model);
}

async function runCodexPreflight(exe: string, command: string[], signal: AbortSignal) {
  try {
    return await runProcess(exe, codexSafePreflightArgs(...command), signal, () => { });
  } catch (error) {
    const retryArgs = codexRecoveredPreflightArgs(error instanceof Error ? error.message : String(error), ...command);
    if (!retryArgs) throw error;
    return runProcess(exe, retryArgs, signal, () => { });
  }
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
export function classifyKeyFailure(check: KeyCheckHttp, language: UiLanguage = 'nl'): KeyFailure {
  const { httpStatus, bodyText } = check;
  if (httpStatus === null) {
    return {
      status: 'invalid',
      reasonCode: 'network',
      error: localizedText(language, `Netwerkfout — key niet kunnen controleren (${bodyText}).`, `Network error — could not validate the key (${bodyText}).`),
    };
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
    return { status: 'expired', reasonCode: 'expired_key', error: localizedText(language, `Key is verlopen — maak een nieuwe aan. (${detail})`, `The key has expired — create a new one. (${detail})`) };
  }
  if (text.includes('deactivated') || text.includes('account has been disabled') || text.includes('suspended')) {
    return { status: 'invalid', reasonCode: 'account_deactivated', error: localizedText(language, `Account gedeactiveerd — deze key werkt niet meer. (${detail})`, `The account is deactivated — this key no longer works. (${detail})`) };
  }
  if (httpStatus === 401 || text.includes('api_key_invalid') || text.includes('api key not valid') || text.includes('invalid x-api-key')) {
    return { status: 'invalid', reasonCode: 'invalid_key', error: localizedText(language, `Key ongeldig of ingetrokken. (${detail})`, `The key is invalid or revoked. (${detail})`) };
  }
  if (httpStatus === 402 || text.includes('credit balance is too low') || text.includes('insufficient_quota') || text.includes('billing')) {
    return { status: 'limited', reasonCode: 'billing', error: localizedText(language, `Key is echt, maar tegoed/billing ontbreekt — genereren faalt. (${detail})`, `The key is valid, but credit or billing is unavailable — generation fails. (${detail})`) };
  }
  if (httpStatus === 403) {
    return { status: 'invalid', reasonCode: 'permission_denied', error: localizedText(language, `Key heeft geen toegang (geblokkeerd, projectrechten, of API niet ingeschakeld). (${detail})`, `The key has no access (blocked, insufficient project permissions, or API disabled). (${detail})`) };
  }
  if (httpStatus === 404) {
    return { status: 'limited', reasonCode: 'model_unavailable', error: localizedText(language, `Testmodel bestaat niet (meer) voor deze key — verouderd of niet beschikbaar. (${detail})`, `The test model no longer exists for this key — it is outdated or unavailable. (${detail})`) };
  }
  if (httpStatus === 429) {
    const quota = text.includes('quota') || text.includes('resource_exhausted');
    return quota
      ? { status: 'limited', reasonCode: 'quota_exceeded', error: localizedText(language, `Key is echt, maar het quotum is op (dag-/minuutlimiet of tegoed). (${detail})`, `The key is valid, but its quota is exhausted (daily/minute limit or credit). (${detail})`) }
      : { status: 'limited', reasonCode: 'rate_limited', error: localizedText(language, `Key is echt, maar tijdelijk rate-limited — probeer straks opnieuw. (${detail})`, `The key is valid, but temporarily rate-limited — try again later. (${detail})`) };
  }
  if (httpStatus >= 500) {
    return { status: 'limited', reasonCode: 'server_error', error: localizedText(language, `Providerstoring (HTTP ${httpStatus}) — zegt niets over de key; probeer later opnieuw.`, `Provider outage (HTTP ${httpStatus}) — this does not indicate a problem with the key; try again later.`) };
  }
  return { status: 'invalid', reasonCode: 'unknown', error: localizedText(language, `Onverwachte fout (HTTP ${httpStatus}): ${detail}`, `Unexpected error (HTTP ${httpStatus}): ${detail}`) };
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

  async validateCredential(secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const id = cryptoId();
    const language = options?.language || 'nl';

    const key = secret || (await getCredential('openai')).value;
    const keyMasked = maskKey(key || '');
    if (!key) {
      return {
        id,
        keyMasked: '',
        provider: 'openai',
        status: 'invalid',
        error: localizedText(language, 'OpenAI API-key nodig; ChatGPT Subscription heeft een aparte sessiestatus.', 'An OpenAI API key is required; ChatGPT Subscription has a separate session status.'),
      };
    }

    const listCheck = await keyCheckFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'openai', ...classifyKeyFailure(listCheck, language) };
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
        error: localizedText(language, 'Key authenticeert, maar dit project heeft geen chat-modellen beschikbaar.', 'The key authenticates, but this project has no chat models available.'),
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
        details: localizedText(language, 'API-key en modelcatalogus zijn bereikbaar.', 'The API key and model catalog are reachable.'),
      };
    }
    const smoke = await keyCheckFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: smokeModel, input: 'Reply with OK.', max_output_tokens: 16 }),
    });
    if (smoke.httpStatus !== 200) {
      const failure = classifyKeyFailure(smoke, language);
      return {
        id,
        keyMasked,
        provider: 'openai',
        ...failure,
        models: topModels(models),
        checkedModel: smokeModel,
        error: localizedText(language, `models.list werkt, maar echte generatie faalt op ${smokeModel}: ${failure.error}`, `models.list works, but an actual generation request fails on ${smokeModel}: ${failure.error}`),
      };
    }
    return {
      id,
      keyMasked,
      provider: 'openai',
      status: 'valid',
      models: topModels(models),
      checkedModel: smokeModel,
      details: localizedText(language, `Echte generatie-smoketest geslaagd met ${smokeModel}.`, `Actual generation smoke test passed with ${smokeModel}.`),
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    // Check if this is a browser session model (chatgpt: prefix)
    const isChatGptSession = request.modelRef.modelId.startsWith('chatgpt:');
    const sessionActive = await chatgptScraper.isSessionActive();

    if (isChatGptSession || (sessionActive && !(await getCredential('openai')).value)) {
      // Use browser session scraper
      if (!sessionActive) {
        throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'ChatGPT web-sessie is niet ingelogd. Open Instellingen -> ChatGPT Subscription -> Inloggen.', 'The ChatGPT web session is not signed in. Open Settings -> ChatGPT Subscription -> Sign in.'), 'auth_failed');
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
        language: request.language,
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
      throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'OpenAI API-key nodig voor OpenAI API. ChatGPT Subscription werkt via een chatgpt:-model.', 'An OpenAI API key is required for the OpenAI API. ChatGPT Subscription works through a chatgpt: model.'), 'auth_failed');
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
        throw new ProviderRuntimeError(event.response?.error?.message || localizedText(request.language || 'nl', 'OpenAI-respons mislukt.', 'OpenAI response failed.'), 'provider_error');
      }
    }

    if (!usage.totalTokens) {
      usage = {
        inputTokens: estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments)),
        outputTokens: estimateTokens(text),
        totalTokens: estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments)) + estimateTokens(text),
        contextWindowSize: modelFromOpenAI(request.modelRef.modelId).contextWindow,
        contextUsedPercent: 0,
        source: 'estimate',
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

  async validateCredential(secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const id = cryptoId();
    const language = options?.language || 'nl';
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
        error: cliAvailable
          ? localizedText(language, 'Claude CLI gevonden, maar niet ingelogd.', 'Claude CLI was found, but it is not signed in.')
          : localizedText(language, 'API key of Claude CLI nodig', 'An API key or Claude CLI is required'),
      };
    }

    const listCheck = await keyCheckFetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'anthropic', ...classifyKeyFailure(listCheck, language) };
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
        error: localizedText(language, 'Key authenticeert, maar er zijn geen modellen beschikbaar voor deze key.', 'The key authenticates, but no models are available for it.'),
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
        details: localizedText(language, 'API-key en modelcatalogus zijn bereikbaar.', 'The API key and model catalog are reachable.'),
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
      const failure = classifyKeyFailure(smoke, language);
      return {
        id,
        keyMasked,
        provider: 'anthropic',
        ...failure,
        models: topModels(models),
        checkedModel: smokeModel,
        error: localizedText(language, `models.list werkt, maar echte generatie faalt op ${smokeModel}: ${failure.error}`, `models.list works, but an actual generation request fails on ${smokeModel}: ${failure.error}`),
      };
    }
    return {
      id,
      keyMasked,
      provider: 'anthropic',
      status: 'valid',
      models: topModels(models),
      checkedModel: smokeModel,
      details: localizedText(language, `Echte generatie-smoketest geslaagd met ${smokeModel}.`, `Actual generation smoke test passed with ${smokeModel}.`),
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
        providerMode: request.modelRef.runConfig?.nativeProviderCommand?.kind === 'collaboration-mode'
          ? request.modelRef.runConfig.nativeProviderCommand.mode
          : undefined,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        cwd: request.cwd,
        agentMode: request.agentMode,
        nativeTools: request.nativeTools,
        requestPermission: request.requestPermission,
        onToolActivity: request.onToolActivity,
        language: request.language,
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
          providerMode: request.modelRef.runConfig?.nativeProviderCommand?.kind === 'collaboration-mode'
            ? request.modelRef.runConfig.nativeProviderCommand.mode
            : undefined,
          signal: request.signal,
          onDelta: request.onDelta,
          onStatus: request.onStatus,
          language: request.language,
        });
        return {
          text: result.text,
          usage: result.usage,
          rateLimit: makeUnknownLimit('anthropic', request.modelRef.modelId, 'Claude CLI fallback — limits depend on your Claude account/plan.'),
        };
      }
      throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Anthropic API-key of Claude CLI nodig. Installeer de CLI of voeg een API-key toe.', 'An Anthropic API key or Claude CLI is required. Install the CLI or add an API key.'), 'auth_failed');
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
    let providerUsageSeen = false;

    for await (const data of parseSse(response)) {
      const event = JSON.parse(data);
      if (event.type === 'message_start' && event.message?.usage) {
        providerUsageSeen = true;
        inputTokens = event.message.usage.input_tokens || inputTokens;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        request.onDelta(event.delta.text);
      }
      if (event.type === 'message_delta' && event.usage) {
        providerUsageSeen = true;
        outputTokens = event.usage.output_tokens || outputTokens;
      }
      if (event.type === 'error') {
        throw new ProviderRuntimeError(event.error?.message || localizedText(request.language || 'nl', 'Anthropic-stream mislukt.', 'Anthropic stream failed.'), 'provider_error');
      }
    }

    let estimatedUsage = false;
    if (!inputTokens) {
      inputTokens = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      estimatedUsage = true;
    }
    if (!outputTokens) {
      outputTokens = estimateTokens(text);
      estimatedUsage = true;
    }
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: DEFAULT_CONTEXT.anthropic,
        contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.anthropic) * 100),
        source: providerUsageSeen ? (estimatedUsage ? 'mixed' : 'provider') : 'estimate',
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

  async validateCredential(secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const id = cryptoId();
    const language = options?.language || 'nl';

    // Gemini gebruikt uitsluitend de directe Developer API met API-key.
    const key = secret || (await getCredential('google')).value;
    const keyMasked = maskKey(key || '');
    if (!key) {
      return {
        id,
        keyMasked: '',
        provider: 'google',
        status: 'invalid',
        error: localizedText(language, 'Gemini API-key nodig', 'A Gemini API key is required'),
      };
    }

    const listCheck = await keyCheckFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (listCheck.httpStatus !== 200) {
      return { id, keyMasked, provider: 'google', ...classifyKeyFailure(listCheck, language) };
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
        error: localizedText(language, 'Key authenticeert, maar er zijn geen generateContent-modellen beschikbaar.', 'The key authenticates, but no generateContent models are available.'),
      };
    }
    if (!options?.probeGeneration) {
      return {
        id,
        keyMasked,
        provider: 'google',
        status: 'valid',
        models: topModels(supportedModels),
        details: localizedText(language, 'API-key en modelcatalogus zijn bereikbaar.', 'The API key and model catalog are reachable.'),
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
        lastModelIssue = localizedText(language, `${smokeModel} is niet beschikbaar voor dit project.`, `${smokeModel} is not available for this project.`);
        continue;
      }
      if (smoke.httpStatus !== 200) {
        const failure = classifyKeyFailure(smoke, language);
        return {
          id,
          keyMasked,
          provider: 'google',
          ...failure,
          models: topModels(supportedModels),
          checkedModel: smokeModel,
          error: localizedText(language, `models.list werkt, maar generateContent faalt op ${smokeModel}: ${failure.error}`, `models.list works, but generateContent fails on ${smokeModel}: ${failure.error}`),
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
        lastModelIssue = localizedText(language, `${smokeModel} gaf een lege respons.`, `${smokeModel} returned an empty response.`);
        continue;
      }
      return {
        id,
        keyMasked,
        provider: 'google',
        status: 'valid',
        models: topModels(supportedModels),
        checkedModel: smokeModel,
        details: localizedText(language, `Echte generateContent-smoketest geslaagd met ${smokeModel}.`, `Actual generateContent smoke test passed with ${smokeModel}.`),
      };
    }

    return {
      id,
      keyMasked,
      provider: 'google',
      status: 'limited',
      reasonCode: 'no_models',
      models: topModels(supportedModels),
      error: lastModelIssue || localizedText(language, 'Geen van de live Gemini-modellen accepteerde de smoketest.', 'None of the live Gemini models accepted the smoke test.'),
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const credential = await getCredential('google');
    if (!credential.value || credential.method !== 'apikey') {
      throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Voeg eerst een geldige Gemini API-key toe.', 'Add a valid Gemini API key first.'), 'auth_failed');
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
        language: request.language,
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
      const providerCounts = Number(nativeResult.inputTokens > 0) + Number(nativeResult.outputTokens > 0);
      return {
        text: nativeResult.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.google,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.google) * 100),
          source: providerCounts === 2 ? 'provider' : providerCounts === 1 ? 'mixed' : 'estimate',
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
          source: 'provider',
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
        source: 'estimate',
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

export function claudeCliChatArgs(
  modelId: string,
  effort?: string,
  supportedEfforts: ReasoningEffort[] = [],
  executionMode?: string,
  supportedModes: string[] = [],
) {
  const permissionMode = executionMode && supportedModes.includes(executionMode) ? executionMode : 'plan';
  return [
    '-p',
    '--model', modelId,
    // Zonder native PC-tools is Claude hier een chattransport, geen verborgen
    // bestandsagent. Plan + safe-mode blokkeren mutaties en projecthooks.
    '--permission-mode', permissionMode,
    '--safe-mode',
    '--no-session-persistence',
    ...(effort && supportedEfforts.includes(effort as ReasoningEffort) ? ['--effort', effort] : []),
  ];
}

async function readClaudeSupportedModels(executable: string): Promise<ClaudeModelInfo[]> {
  let finishIdlePrompt: (() => void) | undefined;
  const idlePrompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          finishIdlePrompt = () => resolve({ done: true, value: undefined as never });
        }),
      };
    },
  };
  const abortController = new AbortController();
  const cleanEnvironment = Object.fromEntries(
    Object.entries(claudeCliEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const sdkExecutable = claudeAgentSdkExecutable(executable);
  const sdkQuery = queryClaudeCode({
    prompt: idlePrompt,
    options: {
      abortController,
      cwd: os.homedir(),
      env: cleanEnvironment,
      pathToClaudeCodeExecutable: sdkExecutable,
      permissionMode: 'plan',
      persistSession: false,
      settingSources: [],
    },
  });
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      sdkQuery.supportedModels(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Claude supportedModels timed out')), 15_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    finishIdlePrompt?.();
    abortController.abort();
    sdkQuery.close();
  }
}

function claudeAgentSdkExecutable(executable: string) {
  if (process.platform !== 'win32' || executable.toLowerCase().endsWith('.exe')) return executable;

  // npm installeert Claude Code op Windows als shellshim naast de echte binary.
  // De Agent SDK spawnt zonder shell en heeft daarom de aangrenzende .exe nodig.
  const npmBinary = path.join(
    path.dirname(executable),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  try {
    if (fs.statSync(npmBinary).isFile()) return npmBinary;
  } catch {
    // Een standalone/custom executable blijft hieronder ongewijzigd.
  }
  return executable;
}

/**
 * De shellshim naast de echte binary is een paar kilobyte; de gebundelde CLI is
 * honderden megabytes. Zo weten we dat we de bundle scannen en niet een wrapper.
 */
const MIN_CLAUDE_BUNDLE_BYTES = 20 * 1024 * 1024;

function claudeBundleCandidates(executable: string) {
  const sdkExecutable = claudeAgentSdkExecutable(executable);
  const npmBinary = path.join(
    path.dirname(executable),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  return [...new Set([sdkExecutable, npmBinary, executable])];
}

/**
 * Leest Claude Code's ingebakken modelcatalogus uit de geïnstalleerde binary.
 * Wordt de catalogus niet herkend, dan levert dit een lege lijst op en blijft de
 * app volledig op de officiële SDK-catalogus draaien.
 */
async function readClaudeModelRegistry(executable: string): Promise<ClaudeRegistryModel[]> {
  for (const candidate of claudeBundleCandidates(executable)) {
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile() || stats.size < MIN_CLAUDE_BUNDLE_BYTES) continue;
      const models = await scanBundleForModelCatalog(candidate, stats.size);
      if (models.length) return models;
    } catch {
      // Ontbrekende of onleesbare kandidaat: probeer de volgende.
    }
  }
  return [];
}

async function scanBundleForModelCatalog(file: string, size: number): Promise<ClaudeRegistryModel[]> {
  const anchor = catalogAnchor();
  const chunkSize = 16 * 1024 * 1024;
  const overlap = anchor.length;
  const handle = await fs.promises.open(file, 'r');

  try {
    let position = 0;
    let carry = '';

    while (position < size) {
      const length = Math.min(chunkSize, size - position);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      // De bundle is UTF-8, maar we zoeken naar ASCII; latin1 houdt de
      // byte-offsets één-op-één zodat het leesvenster hieronder klopt.
      const text = carry + buffer.toString('latin1');
      const anchorIndex = text.indexOf(anchor);

      if (anchorIndex >= 0) {
        const catalogStart = position - carry.length + anchorIndex;
        const window = Buffer.alloc(Math.min(catalogWindowBytes(), size - catalogStart));
        await handle.read(window, 0, window.length, catalogStart);
        const models = parseClaudeModelCatalog(window.toString('utf8'), 0);
        if (models.length) return models;
      }

      carry = text.slice(-overlap);
      position += length;
    }
  } finally {
    await handle.close();
  }

  return [];
}

class ClaudeCliAdapter {
  invalidateModelCache() {
    invalidateCachedCliResults('claude-models-sdk:');
    invalidateCachedCliResults('claude-registry:');
  }

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

    const isAuthenticated = await this.isAuthenticated(exe);
    if (!isAuthenticated) return [];

    const helpText = await readCliHelpText(exe, claudeCliEnvironment());
    const helpEfforts = reasoningEffortsFromCliHelp(helpText);
    const liveCatalog = await cachedCliResult(
      `claude-models-sdk:${executableFingerprint(exe)}`,
      10 * 60_000,
      async () => claudeCliModelsFromSupportedModels(await readClaudeSupportedModels(exe)),
      (models) => models.length > 0,
      { persist: false },
    ).catch(() => []);
    // Oude Claude Code-versies zonder supportedModels-control response blijven
    // bruikbaar via hun beperkte --help-catalogus. Een lege live probe wordt
    // bewust niet gecachet, zodat inloggen/updaten direct herstelbaar blijft.
    const catalog = liveCatalog.length > 0 ? liveCatalog : claudeCliModelsFromHelp(helpText);
    // Claude Code's eigen catalogus in de binary kent de echte contextvensters
    // en de modellen die `supportedModels()` niet publiceert maar `--model` wel
    // accepteert. Mislukt het lezen ervan, dan blijft alles hierboven staan.
    const registry = await cachedCliResult(
      `claude-registry:${executableFingerprint(exe)}`,
      10 * 60_000,
      async () => readClaudeModelRegistry(exe),
      (models) => models.length > 0,
      { persist: false },
    ).catch((): ClaudeRegistryModel[] => []);

    const published = catalog
      .filter((model) => model.id)
      .map((model) => {
        const entry = findRegistryModel(registry, model.resolvedModel, model.id);
        return {
          id: model.id,
          name: model.name,
          entry,
          // De SDK is leidend; kent die geen effortniveaus, dan beslist de
          // catalogus van dit model — ook als die er geen kent, zoals Haiku.
          // Pas zonder allebei blijft de generieke --help-lijst over.
          efforts: model.supportedReasoningEfforts?.length
            ? model.supportedReasoningEfforts
            : entry
              ? reasoningEffortsFromCapabilities(entry.capabilities)
              : helpEfforts,
        };
      });

    const additional = additionalRegistryModels(
      registry,
      published.flatMap((model) => [model.id, model.entry?.id || '']),
    ).map((entry) => ({
      id: entry.id,
      name: entry.displayName,
      entry,
      efforts: reasoningEffortsFromCapabilities(entry.capabilities),
    }));

    return [...published, ...additional].map((model, catalogPriority) => this.makeModel(
      model.id,
      model.name,
      model.entry?.contextWindow ?? (/\[1m\]/i.test(model.id) ? 1_000_000 : 200_000),
      model.entry?.maxOutputTokens ?? (/haiku/i.test(model.id) ? 32000 : 64000),
      model.efforts,
      catalogPriority,
      model.entry ? 'cli' : 'estimate',
    ));
  }

  async sendChat(options: {
    modelId: string;
    messages: ChatMessage[];
    systemPrompt?: string;
    attachments?: AttachmentRecord[];
    effort?: string;
    providerMode?: string;
    signal: AbortSignal;
    onDelta: (delta: string) => void;
    onStatus?: (status: string) => void;
    // Native tools (Claude Code doet zelf de bestanden in de projectmap):
    cwd?: string;
    agentMode?: AgentApprovalMode;
    nativeTools?: boolean;
    requestPermission?: (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }>;
    onToolActivity?: (activity: NativeToolActivity) => void;
    language?: UiLanguage;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const exe = await this.executable();
    if (!exe) throw new ProviderRuntimeError('Claude CLI niet gevonden. Installeer of open Claude via Instellingen.', 'provider_error');

    const realModelId = options.modelId.replace(/^claude-cli:/, '');
    const prompt = buildHistoryPrompt(options.messages, options.systemPrompt, options.attachments || []);
    const helpText = await readCliHelpText(exe, claudeCliEnvironment());
    const supportedEfforts = reasoningEffortsFromCliHelp(helpText);
    const supportedModes = cliOptionChoicesFromHelp(helpText, 'permission-mode');
    const effort = options.effort && supportedEfforts.includes(options.effort as ReasoningEffort) ? options.effort : undefined;
    const providerMode = options.providerMode && supportedModes.includes(options.providerMode)
      ? options.providerMode
      : undefined;

    // Native pad: Claude Code draait z'n eigen tools in de projectmap; elke
    // toestemmingsplichtige tool gaat via requestPermission langs de approval-popup.
    // Alleen als PC-tools aanstaan en er een projectmap + permissie-callback is —
    // anders het gewone platte-tekst pad.
    if (options.nativeTools && options.cwd && options.requestPermission) {
      const native = await runClaudeNative({
        exe,
        modelId: realModelId,
        prompt,
        cwd: options.cwd,
        effort,
        executionMode: providerMode,
        agentMode: options.agentMode || 'ask',
        signal: options.signal,
        onDelta: options.onDelta,
        onStatus: options.onStatus,
        onToolActivity: options.onToolActivity,
        requestPermission: options.requestPermission,
        language: options.language,
      });
      const inputTokens = native.inputTokens || estimateTokens(prompt);
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      const cliCounts = Number(native.inputTokens > 0) + Number(native.outputTokens > 0);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: 200000,
          contextUsedPercent: Math.round((inputTokens / 200000) * 100),
          source: cliCounts === 2 ? 'cli' : cliCounts === 1 ? 'mixed' : 'estimate',
        },
      };
    }

    // Claude Code CLI print mode (-p) reads the prompt from stdin when no positional
    // query is given; stdin avoids Windows command-line length limits.
    const args = claudeCliChatArgs(realModelId, effort, supportedEfforts, providerMode, supportedModes);

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
        source: 'estimate',
      },
    };
  }

  async isAuthenticated(exe: string): Promise<boolean> {
    return cachedCliResult(`claude-auth:${executableFingerprint(exe)}`, 15_000, async () => {
      try {
        // Officiële, niet-interactieve logincontrole; runProcess ondersteunt ook
        // npm's .cmd-shim zonder een zichtbaar consolevenster te laten flitsen.
        const { text } = await runProcess(
          exe,
          ['auth', 'status'],
          AbortSignal.timeout(10_000),
          () => { },
          undefined,
          os.homedir(),
          claudeCliEnvironment(),
        );
        return claudeCliLoggedInFromStatus(text);
      } catch {
        return false;
      }
    }, (authenticated) => authenticated);
  }

  private makeModel(
    id: string,
    name: string,
    contextWindow: number,
    maxOutput: number,
    supportedReasoningEfforts: ReasoningEffort[],
    catalogPriority: number,
    contextSource: ContextSource = 'estimate',
  ): AIModel {
    return {
      id: `claude-cli:${id}`,
      name,
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
      contextSource,
      supportedReasoningEfforts,
      catalogPriority,
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

  async validateCredential(_secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const id = cryptoId();
    const language = options?.language || 'nl';
    const models = await this.listModels();
    return {
      id,
      keyMasked: 'local',
      provider: 'ollama',
      status: models.length ? 'valid' : 'invalid',
      models: topModels(models.map((model) => model.id)),
      error: models.length ? undefined : localizedText(language, 'Ollama is niet bereikbaar.', 'Ollama is not reachable.'),
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
        language: request.language,
      });
      const inputTokens = native.inputTokens || estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      const localCounts = Number(native.inputTokens > 0) + Number(native.outputTokens > 0);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.ollama,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.ollama) * 100),
          source: localCounts === 2 ? 'local' : localCounts === 1 ? 'mixed' : 'estimate',
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
        localizedText(request.language || 'nl', `Ollama is niet bereikbaar op ${baseUrl}. Start Ollama of kies een ander model.`, `Ollama is not reachable at ${baseUrl}. Start Ollama or choose another model.`),
        'network',
      );
    }
    await ensureOk(response, 'ollama', model);
    if (!response.body) throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Ollama gaf geen responsstream terug.', 'Ollama returned no response stream.'), 'provider_error');

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let localUsageSeen = false;
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
      if (typeof data.prompt_eval_count === 'number') {
        inputTokens = data.prompt_eval_count;
        localUsageSeen = true;
      }
      if (typeof data.eval_count === 'number') {
        outputTokens = data.eval_count;
        localUsageSeen = true;
      }
      if (data.done === true) completed = true;
    }
    if (!completed) {
      throw new ProviderRuntimeError(
        localizedText(request.language || 'nl', 'Ollama-stream eindigde zonder een volledige done-respons.', 'The Ollama stream ended without a complete done response.'),
        'provider_error',
      );
    }

    let estimatedLocalUsage = false;
    if (!inputTokens) {
      inputTokens = estimateTokens(buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments));
      estimatedLocalUsage = true;
    }
    if (!outputTokens) {
      outputTokens = estimateTokens(text);
      estimatedLocalUsage = true;
    }
    const contextWindow = discovered?.contextWindow || DEFAULT_CONTEXT.ollama;

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextWindowSize: contextWindow,
        contextUsedPercent: Math.round((inputTokens / contextWindow) * 100),
        source: localUsageSeen ? (estimatedLocalUsage ? 'mixed' : 'local') : 'estimate',
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
  reasoningEffort?: string,
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
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
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

  async validateCredential(_secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const exe = await this.executable();
    const id = cryptoId();
    const language = options?.language || 'nl';
    if (!exe) {
      return {
        id,
        keyMasked: 'missing',
        provider: 'codex',
        status: 'invalid',
        error: localizedText(language, 'Codex CLI is niet gevonden op PATH of bekende installatiepaden.', 'Codex CLI was not found on PATH or known install paths.'),
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
      error: authenticated ? undefined : localizedText(language, 'Codex CLI is gevonden, maar niet ingelogd. Open Codex één keer en log in.', 'Codex CLI was found, but it is not signed in. Open Codex once and sign in.'),
    };
  }

  async sendChat(request: AdapterChatRequest): Promise<AdapterChatResult> {
    const exe = await this.executable();
    if (!exe) throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Codex CLI is niet gevonden. Installeer of configureer Codex voordat je deze provider gebruikt.', 'Codex CLI was not found. Install or configure Codex before using this provider.'), 'provider_error');
    const store = await getStore();
    const parsed = this.parseModelId(request.modelRef.modelId);
    const catalog = await this.modelCatalog(exe);
    const catalogModel = catalog.find((model: any) => String(model.slug || model.id || model) === parsed.baseModelId);
    const supportedReasoningEfforts = catalogModel ? normalizeReasoningEfforts(catalogModel.supported_reasoning_levels) : [];
    const advertisedDefaultEffort = catalogModel ? normalizeReasoningEffort(catalogModel.default_reasoning_level) : undefined;
    const reasoningEffort = selectAdvertisedReasoningEffort(
      supportedReasoningEfforts,
      request.modelRef.runConfig?.reasoningEffort || parsed.runConfig.reasoningEffort,
      advertisedDefaultEffort,
    );
    const requestedTier = normalizeServiceTier(request.modelRef.runConfig?.serviceTier);
    const timeoutSeconds = Number(request.modelRef.runConfig?.timeoutSeconds || store.get('codex.timeoutSeconds') || 180);
    const prompt = buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments);
    const supportedServiceTiers = catalogModel ? codexServiceTiers(catalogModel) : [];
    // `standard` is the implicit no-override path. Other values are sent only
    // when this exact live model advertised them.
    const serviceTier = codexCliServiceTier(requestedTier, supportedServiceTiers);

    // Codex App Server is de native stateful route: goals, collaboration modes,
    // skills, review, approvals en tool-events blijven één echte Codex-thread.
    if (request.chatId && request.cwd) {
      const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
      const latestPrompt = latestUserMessage
        ? appendTextAttachments(latestUserMessage.content, request.attachments)
        : prompt;
      const native = await codexAppServer.runTurn({
        executable: exe,
        chatId: request.chatId,
        model: parsed.baseModelId,
        serviceTier: serviceTier || undefined,
        reasoningEffort,
        prompt,
        latestPrompt,
        systemPrompt: request.systemPrompt,
        cwd: request.cwd,
        agentMode: request.agentMode || 'ask',
        timeoutSeconds,
        signal: request.signal,
        runConfig: request.modelRef.runConfig,
        requestPermission: request.nativeTools ? request.requestPermission : undefined,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.nativeTools ? request.onToolActivity : undefined,
        language: request.language,
      });
      const inputTokens = native.inputTokens || estimateTokens(latestPrompt);
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedTokens: native.cachedTokens,
          reasoningTokens: native.reasoningTokens,
          contextWindowSize: native.contextWindow || DEFAULT_CONTEXT.codex,
          contextUsedPercent: Math.round((inputTokens / (native.contextWindow || DEFAULT_CONTEXT.codex)) * 100),
          source: native.inputTokens || native.outputTokens ? 'cli' : 'estimate',
        },
        rateLimit: makeUnknownLimit('codex', request.modelRef.modelId, 'Codex App Server publiceert gebruiksvensters wanneer het account ze levert.'),
        runConfig: {
          baseModelId: parsed.baseModelId,
          reasoningEffort,
          ...(serviceTier ? { serviceTier } : {}),
          timeoutSeconds,
        },
      };
    }

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
        language: request.language,
      });
      const inputTokens = native.inputTokens || estimateTokens(prompt);
      const outputTokens = native.outputTokens || estimateTokens(native.text);
      const cliCounts = Number(native.inputTokens > 0) + Number(native.outputTokens > 0);
      return {
        text: native.text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          contextWindowSize: DEFAULT_CONTEXT.codex,
          contextUsedPercent: Math.round((inputTokens / DEFAULT_CONTEXT.codex) * 100),
          source: cliCounts === 2 ? 'cli' : cliCounts === 1 ? 'mixed' : 'estimate',
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
      language: request.language,
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
        source: 'estimate',
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
        // Een verouderde userconfig kan vóór login-status al falen. De helper
        // herstelt uitsluitend met waarden die deze geïnstalleerde CLI zelf noemt.
        await runCodexPreflight(exe, ['login', 'status'], AbortSignal.timeout(10000));
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
        const { text } = await runCodexPreflight(exe, ['debug', 'models'], AbortSignal.timeout(10000));
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

  private toModel(model: any, cliAvailable: boolean): AIModel {
    const slug = String(model.slug || model.id || model);
    const displayName = String(model.display_name || model.displayName || slug);
    const supportedReasoningEfforts = normalizeReasoningEfforts(model.supported_reasoning_levels);
    const supportedServiceTiers = codexServiceTiers(model);
    const catalogPriority = Number(model.priority);
    const defaultReasoningEffort = selectAdvertisedReasoningEffort(
      supportedReasoningEfforts,
      // LLMelt kiest voor nieuwe Codex-chats High wanneer de live catalogus
      // die stand aanbiedt. Ontbreekt High, dan blijft de providerdefault leidend.
      supportedReasoningEfforts.includes('high') ? 'high' : undefined,
      model.default_reasoning_level,
    );
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
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      runConfig: {
        baseModelId: slug,
        ...(defaultReasoningEffort ? { reasoningEffort: defaultReasoningEffort } : {}),
      },
    };
  }

  private parseModelId(modelId: string) {
    const normalized = normalizeLegacyModelId('codex', modelId);
    return {
      baseModelId: normalized.modelId,
      runConfig: normalized.runConfig || { baseModelId: normalized.modelId },
    };
  }
}

class AntigravityAdapter implements ProviderAdapter {
  id: ProviderType = 'antigravity';

  invalidateModelCache() {
    invalidateCachedCliResults('agy-models-v2:');
  }

  // Haalt de modellen live op via `agy models`. Recente CLI-versies leveren slugs
  // zoals `gemini-3.6-flash-medium`; oudere versies leverden displaynamen. De
  // renderer begrijpt beide vormen en deze ongewijzigde waarde blijft het --model-id.
  private async fetchModels(exe: string) {
    const cached = await cachedCliResult(`agy-models-v2:${executableFingerprint(exe)}`, 3 * 60 * 60 * 1000, async () => {
      const { text } = await runProcess(exe, ['models'], AbortSignal.timeout(20000), () => { }, undefined, os.homedir());
      return parseAntigravityModelCatalog(text);
    });
    return normalizeAntigravityModelCatalog(cached);
  }

  async listModels(): Promise<AIModel[]> {
    const exe = await this.executable();
    if (!exe) return [];
    let catalog = [] as Awaited<ReturnType<typeof this.fetchModels>>;
    try {
      catalog = await this.fetchModels(exe);
    } catch {
      return [];
    }
    return catalog.map((model, catalogPriority) => ({
      id: model.id,
      name: model.name,
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
      limitGroupKey: limitGroupKey('antigravity', model.id),
      providerCategory: 'agent',
      executionMode: 'agent',
      canChat: true,
      contextSource: 'estimate',
      catalogPriority,
    }));
  }

  async validateCredential(_secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const exe = await this.executable();
    const language = options?.language || 'nl';
    if (!exe) {
      return {
        id: cryptoId(),
        keyMasked: 'missing',
        provider: 'antigravity',
        status: 'invalid',
        reasonCode: 'invalid_key',
        error: localizedText(language, 'Antigravity CLI (agy) niet gevonden. Installeer via https://antigravity.google/cli of stel antigravity.executable in.', 'Antigravity CLI (agy) was not found. Install it from https://antigravity.google/cli or configure antigravity.executable.'),
      };
    }
    try {
      const catalog = await this.fetchModels(exe);
      if (!catalog.length) {
        return {
          id: cryptoId(),
          keyMasked: path.basename(exe),
          provider: 'antigravity',
          status: 'limited',
          reasonCode: 'no_models',
          error: localizedText(language, 'agy gevonden, maar geen modellen — waarschijnlijk niet ingelogd. Draai `agy` één keer in een terminal om in te loggen.', 'agy was found, but returned no models — it is probably not signed in. Run `agy` once in a terminal to sign in.'),
        };
      }
      return {
        id: cryptoId(),
        keyMasked: path.basename(exe),
        provider: 'antigravity',
        status: 'valid',
        models: topModels(catalog.map((model) => model.id)),
        details: localizedText(language, `Antigravity CLI werkt — ${catalog.length} modellen beschikbaar.`, `Antigravity CLI works — ${catalog.length} models available.`),
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
      throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Antigravity CLI (agy) niet gevonden. Installeer via https://antigravity.google/cli.', 'Antigravity CLI (agy) was not found. Install it from https://antigravity.google/cli.'), 'provider_error');
    }
    const prompt = buildHistoryPrompt(request.messages, request.systemPrompt, request.attachments);
    const helpText = await readCliHelpText(exe).catch(() => '');
    const supportedModes = cliOptionChoicesFromHelp(helpText, 'mode');
    const requestedMode = request.modelRef.runConfig?.nativeProviderCommand?.kind === 'collaboration-mode'
      ? request.modelRef.runConfig.nativeProviderCommand.mode
      : undefined;
    const executionMode = requestedMode && supportedModes.includes(requestedMode) ? requestedMode : undefined;
    if (request.nativeTools && request.cwd && request.agentMode && request.requestPermission) {
      const native = await runAntigravityNative({
        exe,
        modelId: request.modelRef.modelId,
        executionMode,
        prompt,
        cwd: request.cwd,
        agentMode: request.agentMode,
        signal: request.signal,
        onDelta: request.onDelta,
        onStatus: request.onStatus,
        onToolActivity: request.onToolActivity,
        requestPermission: request.requestPermission,
        language: request.language,
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
          source: 'estimate',
        },
        rateLimit: makeUnknownLimit('antigravity', request.modelRef.modelId, 'Antigravity CLI-account met native tools en app-approvalhooks.'),
      };
    }
    // Antigravity's print mode expects the prompt as the value of -p/--print.
    // Keep -p last so --model is parsed as a flag instead of accidentally
    // becoming the prompt. Do not pipe stdin here: on Windows agy headless runs
    // are sensitive to non-TTY stdin and can return empty or stale output.
    const promptTransport = await createAntigravityPromptTransport(prompt, request.language);
    let text = '';
    try {
      const args = [
        '--mode', executionMode || 'plan',
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
        undefined,
        request.language,
      ));
    } finally {
      await promptTransport.cleanup();
    }
    const cleanText = text.trim();
    if (!cleanText) {
      throw new ProviderRuntimeError(
        localizedText(request.language || 'nl', 'Antigravity CLI gaf geen uitvoer terug in headless print mode. Open `agy` een keer handmatig of kies voorlopig Codex/ChatGPT voor normale chat.', 'Antigravity CLI returned no output in headless print mode. Open `agy` manually once, or use Codex/ChatGPT for regular chat for now.'),
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
        source: 'estimate',
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

  async validateCredential(_secret?: string, options?: CredentialValidationOptions): Promise<ValidationResult> {
    const { Client } = await import('ssh2');
    const store = await getStore();
    const config = await getRemoteSshConfig();
    const language = options?.language || 'nl';
    if (!config?.host || !config?.user) {
      return {
        id: cryptoId(),
        keyMasked: localizedText(language, 'ontbreekt', 'missing'),
        provider: 'remote',
        status: 'invalid',
        error: localizedText(language, 'Remote SSH is niet ingesteld.', 'Remote SSH is not configured.'),
      };
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
          details: status === 'valid' ? localizedText(language, 'SSH-verbinding en hostvingerafdruk zijn gecontroleerd.', 'The SSH connection and host fingerprint were verified.') : undefined,
        });
      };
      conn.on('ready', () => finish('valid'))
        .on('error', (error: Error) => finish('invalid', localizedText(language, `SSH-verbinding mislukt: ${error.message}`, `SSH connection failed: ${error.message}`)))
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
      throw new ProviderRuntimeError(localizedText(request.language || 'nl', 'Remote SSH is niet ingesteld.', 'Remote SSH is not configured.'), 'auth_failed');
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

      request.signal.addEventListener('abort', () => finish(new ProviderRuntimeError(localizedText(request.language || 'nl', 'Remote verzoek geannuleerd.', 'Remote request cancelled.'), 'cancelled')));

      conn
        .on('ready', () => {
          conn.exec(command, (error: any, stream: any) => {
            if (error) return finish(error);
            stream
              .on('exit', (code: number) => { exitCode = code; })
              .on('close', () => {
                if (exitCode && exitCode !== 0) finish(new ProviderRuntimeError(localizedText(request.language || 'nl', `Remote Ollama stopte met code ${exitCode}: ${errorOutput.slice(0, 4000)}`, `Remote Ollama exited with code ${exitCode}: ${errorOutput.slice(0, 4000)}`), 'provider_error'));
                else finish();
              })
              .on('data', (data: Buffer) => {
                const delta = data.toString();
                output += delta;
                if (Buffer.byteLength(output, 'utf8') > 5 * 1024 * 1024) return finish(new ProviderRuntimeError(localizedText(request.language || 'nl', 'Remote antwoord is groter dan 5 MB.', 'The remote response exceeds 5 MB.'), 'provider_error'));
                request.onDelta(delta);
              });
            stream.stderr.on('data', (data: Buffer) => { errorOutput = `${errorOutput}${data.toString()}`.slice(-100_000); });
            stream.end(prompt);
          });
        })
        .on('error', (error: any) => finish(new ProviderRuntimeError(localizedText(request.language || 'nl', `SSH-verbinding mislukt: ${error.message}`, `SSH connection failed: ${error.message}`), 'network')))
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
        source: 'estimate',
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
    source: 'unknown',
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
    source: 'provider',
  };
}

export async function readCliHelpText(executable: string, env: NodeJS.ProcessEnv = agentCommandEnvironment()) {
  return cachedCliResult(`cli-help:${executableFingerprint(executable)}`, 5 * 60_000, async () => (
    new Promise<string>((resolve, reject) => {
      const spawnSpec = cliSpawnSpec(executable, ['--help']);
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        windowsHide: true,
        cwd: os.homedir(),
        env,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          terminateProcessTree(proc);
          reject(error);
          return;
        }
        // Sommige CLIs (waaronder huidige agy-builds) schrijven geldige help
        // volledig naar stderr. De exitcode is voor capability-discovery niet
        // autoritatief; de daadwerkelijk gepubliceerde helptekst is dat wel.
        const text = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (!text) reject(new Error(`${path.basename(executable)} publiceerde geen helptekst.`));
        else resolve(text);
      };
      const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-250_000);
      proc.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
      proc.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
      proc.on('error', (error) => finish(error));
      proc.on('close', () => finish());
      const timeout = setTimeout(() => finish(new Error(`${path.basename(executable)} --help timed out.`)), 10_000);
    })
  ), (text) => !!text.trim(), { persist: false });
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

export function antigravityPromptFileInstruction(file: string, language: UiLanguage = 'nl') {
  return localizedText(
    language,
    `Lees de volledige gebruikersopdracht uit dit UTF-8-bestand en beantwoord die exact: ${file}`,
    `Read the complete user request from this UTF-8 file and answer it exactly: ${file}`,
  );
}

async function createAntigravityPromptTransport(prompt: string, language: UiLanguage = 'nl') {
  if (process.platform !== 'win32' || prompt.length <= 20_000) {
    return { prompt, file: undefined as string | undefined, cleanup: async () => { } };
  }
  const file = path.join(os.tmpdir(), `ai-superapp-agy-prompt-${crypto.randomBytes(8).toString('hex')}.txt`);
  await fs.promises.writeFile(file, prompt, { encoding: 'utf8', flag: 'wx' });
  return {
    prompt: antigravityPromptFileInstruction(file, language),
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

export async function createPromptTempFile(prompt: string) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-'));
  const file = path.join(dir, 'prompt.txt');
  await fs.promises.writeFile(file, prompt, 'utf8');
  return file;
}
