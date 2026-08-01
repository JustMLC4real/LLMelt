import type {
  ModelRef,
  ProviderQuotaSnapshot,
  ProviderSurface,
  ProviderType,
  QuotaBucket,
  QuotaSource,
  QuotaState,
} from '../src/providers/types';

const LIVE_SOURCE_MAX_AGE_MS = 10 * 60_000;
const DELAYED_SOURCE_MAX_AGE_MS = 30 * 60_000;

export function quotaSnapshotId(provider: ProviderType, surface: ProviderSurface, limitGroupKey: string) {
  return `${provider}:${surface}:${limitGroupKey}`;
}

export function quotaStateForBuckets(buckets: QuotaBucket[]): QuotaState {
  if (!buckets.length) return 'unknown';
  if (buckets.some((bucket) => bucket.state === 'exhausted')) return 'exhausted';
  if (buckets.some((bucket) => bucket.state === 'cooldown')) return 'cooldown';
  if (buckets.some((bucket) => bucket.state === 'limited')) return 'limited';
  if (buckets.every((bucket) => bucket.state === 'unlimited')) return 'unlimited';
  if (buckets.some((bucket) => bucket.state === 'available')) return 'available';
  if (buckets.every((bucket) => bucket.state === 'unavailable')) return 'unavailable';
  return 'unknown';
}

export function stateFromPercent(usedPercent?: number, resetAt?: string): QuotaState {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return 'unknown';
  if (usedPercent >= 100) {
    return resetAt && new Date(resetAt).getTime() > Date.now() ? 'cooldown' : 'exhausted';
  }
  if (usedPercent >= 80) return 'limited';
  return 'available';
}

export function parseCodexRateLimitsResponse(payload: any, observedAt = new Date().toISOString()): ProviderQuotaSnapshot[] {
  const container = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.values(payload.rateLimitsByLimitId)
    : payload?.rateLimits
      ? [payload.rateLimits]
      : [];
  return container
    .map((raw: any, index) => {
      const limitId = String(raw?.limitId || `account-${index}`);
      const buckets: QuotaBucket[] = [];
      const addWindow = (window: any, fallbackLabel: string) => {
        if (!window || typeof window !== 'object') return;
        const usedPercent = numberOrUndefined(window.usedPercent);
        const resetAt = epochSecondsToIso(window.resetsAt);
        const windowSeconds = numberOrUndefined(window.windowDurationMins) != null
          ? Number(window.windowDurationMins) * 60
          : undefined;
        buckets.push({
          id: `${limitId}:${fallbackLabel.toLowerCase()}`,
          label: windowLabel(windowSeconds, fallbackLabel),
          meter: 'provider',
          state: stateFromPercent(usedPercent, resetAt),
          usedPercent,
          remainingFraction: usedPercent == null ? undefined : Math.max(0, (100 - usedPercent) / 100),
          resetAt,
          windowSeconds,
        });
      };
      addWindow(raw?.primary, 'Primair');
      addWindow(raw?.secondary, 'Secundair');
      if (!buckets.length && raw?.rateLimitReachedType) {
        buckets.push({
          id: `${limitId}:provider`, label: String(raw.limitName || limitId), meter: 'provider',
          state: 'exhausted',
        });
      }
      const group = limitId === 'account' ? 'codex:account' : `codex:${limitId}`;
      return {
        id: quotaSnapshotId('codex', 'cli', group),
        provider: 'codex' as const,
        surface: 'cli' as const,
        limitGroupKey: group,
        planTier: stringOrUndefined(raw?.planType),
        state: quotaStateForBuckets(buckets),
        source: 'codex-app-server' as const,
        accuracy: 'live' as const,
        observedAt,
        staleAfter: new Date(new Date(observedAt).getTime() + LIVE_SOURCE_MAX_AGE_MS).toISOString(),
        note: stringOrUndefined(raw?.limitName),
        buckets,
      } satisfies ProviderQuotaSnapshot;
    })
    .filter((snapshot: ProviderQuotaSnapshot) => snapshot.buckets.length > 0);
}

export function parseClaudeStatuslinePayload(payload: any, observedAt = new Date().toISOString()): ProviderQuotaSnapshot | null {
  const limits = payload?.rate_limits || payload?.rateLimits;
  if (!limits || typeof limits !== 'object') return null;
  const buckets = [
    claudeWindowBucket('five-hour', '5 uur', limits.five_hour || limits.fiveHour),
    claudeWindowBucket('seven-day', '7 dagen', limits.seven_day || limits.sevenDay),
  ].filter(Boolean) as QuotaBucket[];
  if (!buckets.length) return null;
  return {
    id: quotaSnapshotId('anthropic', 'cli', 'anthropic:account'),
    provider: 'anthropic',
    surface: 'cli',
    limitGroupKey: 'anthropic:account',
    planTier: stringOrUndefined(payload?.account?.plan || payload?.plan || payload?.subscription_type),
    state: quotaStateForBuckets(buckets),
    source: 'claude-statusline',
    accuracy: 'live',
    observedAt,
    staleAfter: new Date(new Date(observedAt).getTime() + LIVE_SOURCE_MAX_AGE_MS).toISOString(),
    buckets,
  };
}

export function parseAntigravityStatuslinePayload(payload: any, observedAt = new Date().toISOString()): ProviderQuotaSnapshot[] {
  const quota = payload?.quota || payload?.quotas || payload?.quota_summary?.buckets;
  if (!quota || typeof quota !== 'object') return [];
  const values: Array<[string, any]> = Array.isArray(quota)
    ? quota.map((value: any, index: number) => [String(value?.bucket_id || index), value])
    : Object.entries(quota);
  const grouped = new Map<string, QuotaBucket[]>();
  for (const [key, raw] of values) {
    const modelId = stringOrUndefined(raw?.model_id || raw?.modelId || raw?.model || key);
    const remainingFraction = fractionOrUndefined(raw?.remaining_fraction ?? raw?.remainingFraction);
    const remaining = numberOrUndefined(raw?.remaining_amount ?? raw?.remainingAmount);
    const resetAt = timestampToIso(raw?.reset_time ?? raw?.resetTime ?? raw?.resets_at);
    const usedPercent = remainingFraction == null ? undefined : Math.max(0, Math.min(100, (1 - remainingFraction) * 100));
    const state = remainingFraction != null && remainingFraction <= 0
      ? (resetAt && new Date(resetAt).getTime() > Date.now() ? 'cooldown' : 'exhausted')
      : stateFromPercent(usedPercent, resetAt);
    const group = modelId ? `antigravity:${modelId}` : 'antigravity:account';
    const bucket: QuotaBucket = {
      id: String(raw?.bucket_id || raw?.bucketId || key),
      label: String(raw?.display_name || raw?.displayName || raw?.window || key),
      meter: 'provider', state, modelId, remainingFraction, remaining, usedPercent, resetAt,
    };
    grouped.set(group, [...(grouped.get(group) || []), bucket]);
  }
  return [...grouped.entries()].map(([group, buckets]) => ({
    id: quotaSnapshotId('antigravity', 'cli', group),
    provider: 'antigravity', surface: 'cli', limitGroupKey: group,
    modelId: group === 'antigravity:account' ? undefined : group.slice('antigravity:'.length),
    planTier: stringOrUndefined(payload?.account?.plan || payload?.plan || payload?.subscription_type),
    state: quotaStateForBuckets(buckets), source: 'antigravity-statusline', accuracy: 'live', observedAt,
    staleAfter: new Date(new Date(observedAt).getTime() + LIVE_SOURCE_MAX_AGE_MS).toISOString(), buckets,
  }));
}

export function parseGoogleServiceUsageQuotas(payload: any, projectId: string, observedAt = new Date().toISOString()): ProviderQuotaSnapshot[] {
  const metrics = Array.isArray(payload?.metrics) ? payload.metrics : Array.isArray(payload?.consumerQuotaMetrics) ? payload.consumerQuotaMetrics : [];
  const snapshots: ProviderQuotaSnapshot[] = [];
  for (const metric of metrics) {
    const metricName = String(metric?.metric || metric?.displayName || metric?.name || 'quota');
    for (const limit of metric?.consumerQuotaLimits || metric?.limits || []) {
      const buckets: QuotaBucket[] = (limit?.quotaBuckets || []).map((bucket: any, index: number) => {
        const effectiveLimit = numberOrUndefined(bucket?.effectiveLimit);
        return {
          id: String(bucket?.name || `${limit?.name || metricName}:${index}`),
          label: String(limit?.displayName || metric?.displayName || metricName),
          meter: googleMeter(metricName), state: effectiveLimit === 0 ? 'exhausted' : 'available',
          limit: effectiveLimit,
          windowSeconds: durationToSeconds(limit?.unit || limit?.duration),
        } satisfies QuotaBucket;
      });
      if (!buckets.length) continue;
      const group = `google:project:${projectId}`;
      snapshots.push({
        id: `${quotaSnapshotId('google', 'api', group)}:${String(limit?.name || metricName)}`,
        provider: 'google', surface: 'api', limitGroupKey: group,
        state: quotaStateForBuckets(buckets), source: 'google-service-usage', accuracy: 'delayed', observedAt,
        staleAfter: new Date(new Date(observedAt).getTime() + DELAYED_SOURCE_MAX_AGE_MS).toISOString(),
        delayedBySeconds: 180, note: 'Google Cloud-quota; werkelijk verbruik kan enkele minuten achterlopen.', buckets,
      });
    }
  }
  return snapshots;
}

/**
 * Combineert de officiële Gemini Cloud Monitoring `.../limit`- en
 * `.../usage`-reeksen. De descriptors en model-labels komen live van Google;
 * er staat bewust geen modellen- of quotum-allowlist in LLMelt.
 */
export function parseGoogleMonitoringQuotas(payload: any, projectId: string, observedAt = new Date().toISOString()): ProviderQuotaSnapshot[] {
  const descriptors = Array.isArray(payload?.metricDescriptors) ? payload.metricDescriptors : [];
  const timeSeries = Array.isArray(payload?.timeSeries) ? payload.timeSeries : [];
  const descriptorByType = new Map<string, any>(descriptors.map((descriptor: any) => [String(descriptor?.type || ''), descriptor]));
  type Point = { at: number; value: number };
  type MeterGroup = {
    base: string;
    modelId?: string;
    limitName: string;
    location?: string;
    displayName: string;
    windowSeconds?: number;
    limitSeries: Point[][];
    usageSeries: Array<{ kind: string; points: Point[] }>;
  };
  const groups = new Map<string, MeterGroup>();

  for (const series of timeSeries) {
    const metricType = String(series?.metric?.type || '');
    const match = metricType.match(/^generativelanguage\.googleapis\.com\/quota\/(.+)\/(limit|usage)$/);
    if (!match) continue;
    const [, base, role] = match;
    const labels = series?.metric?.labels || {};
    const resourceLabels = series?.resource?.labels || {};
    const limitName = String(labels.limit_name || base);
    const modelId = stringOrUndefined(labels.model);
    const location = stringOrUndefined(resourceLabels.location || labels.location);
    const key = [base, limitName, modelId || '', location || ''].join('|');
    const descriptor = descriptorByType.get(metricType);
    const group = groups.get(key) || {
      base,
      modelId,
      limitName,
      location,
      displayName: String(descriptor?.displayName || humanizeGoogleQuota(base)),
      windowSeconds: inferGoogleWindowSeconds(limitName, base),
      limitSeries: [],
      usageSeries: [],
    };
    const points = googleSeriesPoints(series?.points);
    if (role === 'limit') group.limitSeries.push(points);
    else group.usageSeries.push({ kind: String(descriptor?.metricKind || ''), points });
    groups.set(key, group);
  }

  const bucketsByModel = new Map<string, QuotaBucket[]>();
  for (const group of groups.values()) {
    const latestLimits = group.limitSeries.map(latestPointValue).filter((value): value is number => value != null);
    const limit = latestLimits.length ? Math.max(...latestLimits) : undefined;
    if (limit == null) continue;
    const used = googleUsageValue(group.usageSeries, group.windowSeconds);
    const usedPercent = used == null || limit <= 0 ? (limit === 0 ? 100 : undefined) : Math.max(0, Math.min(100, used / limit * 100));
    const remaining = used == null ? undefined : Math.max(0, limit - used);
    const labelParts = [group.displayName];
    if (group.modelId) labelParts.push(group.modelId);
    if (group.location && group.location !== 'global') labelParts.push(group.location);
    const bucket: QuotaBucket = {
      id: `google-monitoring:${group.base}:${group.limitName}:${group.modelId || 'project'}:${group.location || 'global'}`,
      label: labelParts.join(' · '),
      meter: googleMeter(group.base),
      state: stateFromPercent(usedPercent),
      modelId: group.modelId,
      used,
      remaining,
      limit,
      usedPercent,
      remainingFraction: remaining == null || limit <= 0 ? undefined : remaining / limit,
      windowSeconds: group.windowSeconds,
    };
    const modelKey = group.modelId || '';
    bucketsByModel.set(modelKey, [...(bucketsByModel.get(modelKey) || []), bucket]);
  }

  return [...bucketsByModel.entries()].map(([modelId, buckets]) => {
    const limitGroupKey = modelId
      ? `google:project:${projectId}:model:${modelId}`
      : `google:project:${projectId}`;
    return {
      id: quotaSnapshotId('google', 'api', limitGroupKey),
      provider: 'google',
      surface: 'api',
      modelId: modelId || undefined,
      limitGroupKey,
      planTier: inferGooglePlanTier(buckets.map((bucket) => bucket.id).join(' ')),
      state: quotaStateForBuckets(buckets),
      source: 'google-monitoring',
      accuracy: 'delayed',
      observedAt,
      staleAfter: new Date(new Date(observedAt).getTime() + DELAYED_SOURCE_MAX_AGE_MS).toISOString(),
      delayedBySeconds: 150,
      note: 'Google Cloud Monitoring; de cijfers kunnen maximaal circa 150 seconden achterlopen.',
      buckets,
    } satisfies ProviderQuotaSnapshot;
  });
}

export function makeUnavailableQuota(
  provider: ProviderType,
  surface: ProviderSurface,
  limitGroupKey: string,
  note: string,
  source: QuotaSource = 'unknown',
): ProviderQuotaSnapshot {
  const observedAt = new Date().toISOString();
  return {
    id: quotaSnapshotId(provider, surface, limitGroupKey), provider, surface, limitGroupKey,
    state: 'unavailable', source, accuracy: 'unavailable', observedAt, note, buckets: [],
  };
}

export function makeLocalUnlimitedQuota(modelId?: string): ProviderQuotaSnapshot {
  const observedAt = new Date().toISOString();
  return {
    id: quotaSnapshotId('ollama', 'local', modelId ? `ollama:${modelId}` : 'ollama:local'),
    provider: 'ollama', surface: 'local', modelId, limitGroupKey: modelId ? `ollama:${modelId}` : 'ollama:local',
    state: 'unlimited', source: 'local', accuracy: 'local', observedAt,
    note: 'Lokaal model zonder providerquotum.',
    buckets: [{ id: 'local', label: 'Lokaal', meter: 'provider', state: 'unlimited' }],
  };
}

export function blockingQuotaForModel(
  modelRef: ModelRef,
  snapshots: ProviderQuotaSnapshot[],
  limitGroupKey: string,
  now = Date.now(),
) {
  const relevant = snapshots.filter((snapshot) => (
    snapshot.limitGroupKey === limitGroupKey
    || (snapshot.provider === modelRef.provider && (!snapshot.modelId || snapshot.modelId === modelRef.modelId))
  ));
  for (const snapshot of relevant) {
    const staleAt = snapshot.staleAfter ? new Date(snapshot.staleAfter).getTime() : 0;
    if (staleAt && staleAt <= now) continue;
    // Vertraagde Cloud Monitoring-cijfers mogen een provider niet preventief
    // blokkeren; een actuele runtime-429 mag dat wel.
    if (snapshot.accuracy === 'delayed' && snapshot.source !== 'runtime-error') continue;
    const bucket = snapshot.buckets.find((candidate) => {
      if (!['exhausted', 'cooldown'].includes(candidate.state)) return false;
      if (!candidate.resetAt) return true;
      return new Date(candidate.resetAt).getTime() > now;
    });
    if (bucket) return { snapshot, bucket };
  }
  return null;
}

function claudeWindowBucket(id: string, label: string, raw: any): QuotaBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = numberOrUndefined(raw.used_percentage ?? raw.usedPercent);
  const resetAt = timestampToIso(raw.resets_at ?? raw.resetsAt);
  return {
    id, label, meter: 'provider', state: stateFromPercent(usedPercent, resetAt), usedPercent,
    remainingFraction: usedPercent == null ? undefined : Math.max(0, (100 - usedPercent) / 100), resetAt,
    windowSeconds: id === 'five-hour' ? 5 * 3600 : id === 'seven-day' ? 7 * 86400 : undefined,
  };
}

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function fractionOrUndefined(value: unknown) {
  const number = numberOrUndefined(value);
  if (number == null) return undefined;
  return number > 1 ? number / 100 : number;
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function epochSecondsToIso(value: unknown) {
  const number = numberOrUndefined(value);
  return number == null ? undefined : new Date(number * 1000).toISOString();
}

function timestampToIso(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === 'number') return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function windowLabel(seconds: number | undefined, fallback: string) {
  if (!seconds) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400} dagen`;
  if (seconds % 3600 === 0) return `${seconds / 3600} uur`;
  return fallback;
}

function googleMeter(metric: string): QuotaBucket['meter'] {
  if (/input/i.test(metric)) return 'input_tokens';
  if (/output/i.test(metric)) return 'output_tokens';
  if (/token/i.test(metric)) return 'tokens';
  if (/request/i.test(metric)) return 'requests';
  return 'provider';
}

function durationToSeconds(value: unknown) {
  const text = String(value || '');
  const seconds = text.match(/(\d+)s/);
  if (seconds) return Number(seconds[1]);
  if (/minute/i.test(text)) return 60;
  if (/day/i.test(text)) return 86400;
  return undefined;
}

function googleSeriesPoints(points: any): Array<{ at: number; value: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .map((point: any) => {
      const raw = point?.value?.int64Value ?? point?.value?.doubleValue;
      const value = numberOrUndefined(raw);
      const at = new Date(point?.interval?.endTime || point?.interval?.startTime || 0).getTime();
      return value == null || !Number.isFinite(at) ? null : { at, value };
    })
    .filter((point): point is { at: number; value: number } => !!point)
    .sort((left, right) => right.at - left.at);
}

function latestPointValue(points: Array<{ at: number; value: number }>) {
  return points[0]?.value;
}

function googleUsageValue(series: Array<{ kind: string; points: Array<{ at: number; value: number }> }>, windowSeconds?: number) {
  const populated = series.filter((item) => item.points.length);
  if (!populated.length) return 0;
  const newestPoint = Math.max(...populated.flatMap((item) => item.points.map((point) => point.at)));
  return populated.reduce((total, item) => {
    if (item.kind === 'DELTA' && windowSeconds) {
      const start = newestPoint - windowSeconds * 1000;
      return total + item.points.filter((point) => point.at > start && point.at <= newestPoint).reduce((sum, point) => sum + point.value, 0);
    }
    return total + (item.points[0]?.value || 0);
  }, 0);
}

function inferGoogleWindowSeconds(...values: string[]) {
  const value = values.join(' ').replace(/[_-]/g, ' ');
  if (/per\s*minute|minute|\/min\b/i.test(value)) return 60;
  if (/per\s*hour|hour|\/h\b/i.test(value)) return 3600;
  if (/per\s*day|daily|day|\/d\b/i.test(value)) return 86400;
  return undefined;
}

function humanizeGoogleQuota(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferGooglePlanTier(value: string) {
  const paid = value.match(/paid[_\s-]*tier[_\s-]*(\d+)/i);
  if (paid) return `paid-tier-${paid[1]}`;
  if (/free[_\s-]*tier/i.test(value)) return 'free-tier';
  return undefined;
}
