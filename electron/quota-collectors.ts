import fs from 'fs';
import { spawn } from 'child_process';
import type { AIModel, ProviderQuotaSnapshot, RateLimitSnapshot } from '../src/providers/types';
import {
  makeLocalUnlimitedQuota,
  makeUnavailableQuota,
  parseAntigravityStatuslinePayload,
  parseClaudeStatuslinePayload,
  parseCodexRateLimitsResponse,
  quotaSnapshotId,
  quotaStateForBuckets,
} from './provider-quota';
import { collectGeminiQuotaSnapshots } from './gemini-quota-auth';
import { statuslineStatePath } from './statusline-bridge';

export interface QuotaCollectorOptions {
  codexExecutable?: string | null;
  antigravityStatusPath?: string | null;
  models?: AIModel[];
  legacyRateLimits?: RateLimitSnapshot[];
}

export async function collectProviderQuotaSnapshots(options: QuotaCollectorOptions) {
  const snapshots: ProviderQuotaSnapshot[] = [];
  const [codexResult, statuslineResult, geminiResult] = await Promise.allSettled([
    options.codexExecutable
      ? collectCodexQuota(options.codexExecutable)
      : Promise.reject(new Error('Codex CLI is niet gevonden.')),
    collectStatuslineQuotas(options.antigravityStatusPath),
    collectGeminiQuotaSnapshots(),
  ]);
  if (codexResult.status === 'fulfilled' && codexResult.value.length) snapshots.push(...codexResult.value);
  else snapshots.push(makeUnavailableQuota(
    'codex', 'cli', 'codex:account',
    quotaErrorNote(codexResult, 'Codex publiceerde geen machineleesbaar accountquotum.'),
    'codex-app-server',
  ));
  if (statuslineResult.status === 'fulfilled') snapshots.push(...statuslineResult.value);
  else {
    const note = quotaErrorNote(statuslineResult, 'Statusregel-quota kon niet worden gelezen.');
    snapshots.push(makeUnavailableQuota('anthropic', 'cli', 'anthropic:account', note, 'claude-statusline'));
    snapshots.push(makeUnavailableQuota('antigravity', 'cli', 'antigravity:account', note, 'antigravity-statusline'));
  }
  if (geminiResult.status === 'fulfilled' && geminiResult.value.length) snapshots.push(...geminiResult.value);
  else snapshots.push(makeUnavailableQuota(
    'google', 'api', 'google:project',
    quotaErrorNote(geminiResult, 'Verplichte Google Cloud-quota is nog niet gekoppeld.'),
    'google-service-usage',
  ));
  const modelIds = new Set((options.models || []).filter((model) => model.provider === 'ollama').map((model) => model.id));
  if (!modelIds.size) snapshots.push(makeLocalUnlimitedQuota());
  else for (const modelId of modelIds) snapshots.push(makeLocalUnlimitedQuota(modelId));
  snapshots.push(chatGptUnavailable());
  snapshots.push(...legacyLimitsToQuotas(options.legacyRateLimits || []));
  return dedupeSnapshots(snapshots);
}

export async function collectCodexQuota(executable: string): Promise<ProviderQuotaSnapshot[]> {
  const commandFile = /\.(?:cmd|bat)$/i.test(executable);
  const command = commandFile ? (process.env.ComSpec || 'cmd.exe') : executable;
  const args = commandFile ? ['/d', '/s', '/c', `""${executable}" app-server"`] : ['app-server'];
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const responses = new Map<number, any>();
  const completion = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex-quotum ophalen duurde te lang.')), 12_000);
    const finish = () => {
      if (!responses.has(2)) return;
      clearTimeout(timer);
      resolve();
    };
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line);
            if (typeof message?.id === 'number') responses.set(message.id, message);
          } catch { /* Codex kan diagnostiek naast JSON schrijven. */ }
        }
        newline = buffer.indexOf('\n');
      }
      finish();
    });
    child.once('exit', (code) => {
      if (responses.has(2)) return finish();
      clearTimeout(timer);
      reject(new Error(stderr.trim() || `Codex app-server stopte met code ${code}.`));
    });
  });
  const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'llmelt', title: 'LLMelt', version: '1.0.0' }, capabilities: {} } });
  write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  write({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
  try {
    await completion;
    const response = responses.get(2);
    if (response?.error) throw new Error(response.error.message || 'Codex gaf geen quotum terug.');
    return parseCodexRateLimitsResponse(response?.result);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function collectStatuslineQuotas(extraAntigravityPath?: string | null) {
  const snapshots: ProviderQuotaSnapshot[] = [];
  const claude = readRecentJson(statuslineStatePath('claude'));
  const parsedClaude = claude ? parseClaudeStatuslinePayload(claude, claude.observedAt) : null;
  if (parsedClaude) snapshots.push(parsedClaude);
  else snapshots.push(makeUnavailableQuota(
    'anthropic', 'cli', 'anthropic:account',
    'Claude heeft nog geen actuele statusregel-data geleverd. Start eenmaal een Claude CLI-beurt.',
    'claude-statusline',
  ));
  const antigravity = readRecentJson(extraAntigravityPath || statuslineStatePath('antigravity'));
  const parsedAntigravity = antigravity ? parseAntigravityStatuslinePayload(antigravity, antigravity.observedAt) : [];
  if (parsedAntigravity.length) snapshots.push(...parsedAntigravity);
  else snapshots.push(makeUnavailableQuota(
    'antigravity', 'cli', 'antigravity:account',
    'Antigravity heeft nog geen actuele statusregel-data geleverd. Start eenmaal een Antigravity CLI-beurt.',
    'antigravity-statusline',
  ));
  return snapshots;
}

function quotaErrorNote(result: PromiseSettledResult<unknown>, fallback: string) {
  if (result.status === 'fulfilled') return fallback;
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason || '');
  return message.trim().slice(0, 500) || fallback;
}

function readRecentJson(filePath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const observed = new Date(value?.observedAt || 0).getTime();
    if (!Number.isFinite(observed) || Date.now() - observed > 24 * 3600_000) return null;
    return value;
  } catch {
    return null;
  }
}

function chatGptUnavailable(): ProviderQuotaSnapshot {
  return makeUnavailableQuota(
    'openai', 'subscription-web', 'openai:account',
    'ChatGPT publiceert geen machineleesbaar abonnementsquotum. LLMelt schakelt door na een echte limietfout.',
  );
}

function legacyLimitsToQuotas(limits: RateLimitSnapshot[]): ProviderQuotaSnapshot[] {
  return limits
    .filter((limit) => limit.known && (limit.requestsLimit != null || limit.tokensLimit != null))
    .map((limit) => {
      const buckets = [];
      if (limit.requestsLimit != null) {
        const used = Math.max(0, limit.requestsLimit - (limit.requestsRemaining || 0));
        const usedPercent = limit.requestsLimit ? used / limit.requestsLimit * 100 : 100;
        buckets.push({ id: 'requests', label: 'Requests', meter: 'requests' as const, state: usedPercent >= 100 ? 'exhausted' as const : usedPercent >= 80 ? 'limited' as const : 'available' as const, used, remaining: limit.requestsRemaining, limit: limit.requestsLimit, usedPercent, resetAt: limit.resetRequestsAt });
      }
      if (limit.tokensLimit != null) {
        const used = Math.max(0, limit.tokensLimit - (limit.tokensRemaining || 0));
        const usedPercent = limit.tokensLimit ? used / limit.tokensLimit * 100 : 100;
        buckets.push({ id: 'tokens', label: 'Tokens', meter: 'tokens' as const, state: usedPercent >= 100 ? 'exhausted' as const : usedPercent >= 80 ? 'limited' as const : 'available' as const, used, remaining: limit.tokensRemaining, limit: limit.tokensLimit, usedPercent, resetAt: limit.resetTokensAt });
      }
      const group = limit.limitGroupKey || `${limit.provider}:${limit.modelId || 'account'}`;
      return {
        id: quotaSnapshotId(limit.provider, 'api', group), provider: limit.provider, surface: 'api' as const,
        modelId: limit.modelId, limitGroupKey: group, state: quotaStateForBuckets(buckets),
        source: 'headers' as const, accuracy: 'live' as const, observedAt: limit.updatedAt,
        staleAfter: new Date(new Date(limit.updatedAt).getTime() + 10 * 60_000).toISOString(), note: limit.note, buckets,
      };
    });
}

function dedupeSnapshots(snapshots: ProviderQuotaSnapshot[]) {
  const result = new Map<string, ProviderQuotaSnapshot>();
  for (const snapshot of snapshots) {
    const previous = result.get(snapshot.id);
    if (!previous || new Date(snapshot.observedAt).getTime() >= new Date(previous.observedAt).getTime()) result.set(snapshot.id, snapshot);
  }
  return [...result.values()];
}
