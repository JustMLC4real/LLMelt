import type { TokenUsage, TokenUsageSource } from './types';

export function hasRecordableUsage(usage: TokenUsage) {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedTokens, usage.reasoningTokens]
    .some((value) => Number.isFinite(value) && Number(value) > 0);
}

export function mergeUsageSources(...sources: Array<TokenUsageSource | undefined>): TokenUsageSource {
  const known = [...new Set(sources.filter((source): source is TokenUsageSource => !!source && source !== 'unknown'))];
  if (!known.length) return 'unknown';
  if (known.length === 1) return known[0];
  return 'mixed';
}

export function usageSourceFromRows(value: unknown): TokenUsageSource {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  return mergeUsageSources(...value.split(',').map((source) => normalizeUsageSource(source)));
}

export function normalizeUsageSource(value: unknown): TokenUsageSource {
  return ['provider', 'cli', 'local', 'estimate', 'mixed'].includes(String(value))
    ? value as TokenUsageSource
    : 'unknown';
}
