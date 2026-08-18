import type { AIModel, ProviderQuotaSnapshot, ProviderSurface, QuotaBucket } from './types';

export type QuotaWindowLabelKey = 'primaryWindow' | 'secondaryWindow' | 'fiveHourWindow' | 'sevenDayWindow' | 'localWindow';
export type QuotaStatusLabelKey = 'localLimit' | 'cooldown' | 'quotaExhausted' | 'quotaLimited' | 'available' | 'limitNotPublished' | 'limitUnknown';

export function providerSurfaceForModel(model: AIModel): ProviderSurface {
  if (model.providerSurface) return model.providerSurface;
  if (model.provider === 'ollama') return 'local';
  if (model.provider === 'remote') return 'remote';
  if (model.provider === 'codex' || model.provider === 'antigravity') return 'cli';
  if (model.provider === 'anthropic' && model.id.startsWith('claude-cli:')) return 'cli';
  if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) return 'subscription-web';
  return 'api';
}

export function resolveQuotaForModel(
  model: AIModel | undefined,
  snapshots: ProviderQuotaSnapshot[],
  limitGroupKey: string,
  now = Date.now(),
) {
  if (!model) return undefined;
  const surface = providerSurfaceForModel(model);
  return snapshots
    .filter((snapshot) => (
      snapshot.provider === model.provider
      && snapshot.surface === surface
      && (!snapshot.staleAfter || new Date(snapshot.staleAfter).getTime() > now)
      && (!snapshot.modelId || snapshot.modelId === model.id)
    ))
    .sort((left, right) => quotaMatchScore(right, model, limitGroupKey) - quotaMatchScore(left, model, limitGroupKey))[0];
}

function quotaMatchScore(snapshot: ProviderQuotaSnapshot, model: AIModel, limitGroupKey: string) {
  let score = 0;
  if (snapshot.state === 'cooldown' || snapshot.state === 'exhausted') score += 1_000;
  if (snapshot.limitGroupKey === limitGroupKey) score += 200;
  if (snapshot.modelId === model.id) score += 100;
  if (snapshot.source === 'runtime-error') score += 50;
  if (snapshot.accuracy === 'live' || snapshot.accuracy === 'local') score += 20;
  if (snapshot.buckets.length) score += 10;
  return score;
}

export function formatQuotaCountdown(
  resetAt: string,
  now: number,
  labels: { available: string; day: string; hour: string; minute: string; second: string },
) {
  const diff = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return labels.available;
  const totalSeconds = Math.max(1, Math.ceil(diff / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}${labels.day} ${hours}${labels.hour}`;
  if (hours) return `${hours}${labels.hour} ${minutes}${labels.minute}`;
  if (minutes) return `${minutes}${labels.minute} ${seconds}${labels.second}`;
  return `${seconds}${labels.second}`;
}

/**
 * Herkent uitsluitend structurele, door LLMelt bekende vensters. Dynamische
 * providerlabels blijven ongewijzigd; deze mapping voorkomt dat onze eigen
 * Nederlandse opslaglabels in een Engelse UI terechtkomen.
 */
export function quotaWindowLabelKey(bucket: QuotaBucket): QuotaWindowLabelKey | undefined {
  const id = bucket.id.toLowerCase();
  const label = bucket.label.toLowerCase();
  if (id === 'local') return 'localWindow';
  if (id.endsWith(':primary') || id.endsWith(':primair') || label === 'primary' || label === 'primair') return 'primaryWindow';
  if (id.endsWith(':secondary') || id.endsWith(':secundair') || label === 'secondary' || label === 'secundair') return 'secondaryWindow';
  if (id === 'five-hour' || bucket.windowSeconds === 5 * 3600) return 'fiveHourWindow';
  if (id === 'seven-day' || bucket.windowSeconds === 7 * 86400) return 'sevenDayWindow';
  return undefined;
}

export function quotaStatusLabelKey(snapshot: ProviderQuotaSnapshot): QuotaStatusLabelKey {
  if (snapshot.state === 'unlimited') return 'localLimit';
  if (snapshot.state === 'cooldown') return 'cooldown';
  if (snapshot.state === 'exhausted') return 'quotaExhausted';
  if (snapshot.state === 'limited') return 'quotaLimited';
  if (snapshot.state === 'available') return 'available';
  if (snapshot.accuracy === 'unavailable' || snapshot.state === 'unavailable') return 'limitNotPublished';
  return 'limitUnknown';
}
