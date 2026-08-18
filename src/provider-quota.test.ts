import { describe, expect, it } from 'vitest';
import {
  blockingQuotaForModel,
  makeUnknownQuota,
  parseAntigravityStatuslinePayload,
  parseClaudeStatuslinePayload,
  parseCodexRateLimitsResponse,
  parseGoogleMonitoringQuotas,
  parseGoogleServiceUsageQuotas,
} from '../electron/provider-quota';

describe('providerneutrale quota', () => {
  it('behoudt de aparte Codex-vensters en resetmomenten', () => {
    const snapshots = parseCodexRateLimitsResponse({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'account', limitName: 'Codex', planType: 'pro',
          primary: { usedPercent: 25, resetsAt: 1_800_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 100, resetsAt: 1_800_604_800, windowDurationMins: 10080 },
        },
      },
    }, '2026-08-01T00:00:00.000Z');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].buckets.map((bucket) => bucket.label)).toEqual(['5 uur', '7 dagen']);
    expect(snapshots[0].state).toBe('cooldown');
    expect(snapshots[0].planTier).toBe('pro');
    expect(snapshots[0].buckets[0].resetAt).toBe('2027-01-15T08:00:00.000Z');
  });

  it('presenteert ontbrekende quotatelemetrie niet als een onbeschikbaar model', () => {
    const snapshot = makeUnknownQuota(
      'openai',
      'subscription-web',
      'openai:account',
      'ChatGPT publiceert geen abonnementsquotum.',
    );
    expect(snapshot.state).toBe('unknown');
    expect(snapshot.accuracy).toBe('unavailable');
    expect(snapshot.buckets).toEqual([]);
  });

  it('leest Claude 5-uur- en 7-dagenvelden uit de statusregel', () => {
    const snapshot = parseClaudeStatuslinePayload({
      plan: 'max',
      rate_limits: {
        five_hour: { used_percentage: 81, resets_at: '2030-01-01T00:00:00Z' },
        seven_day: { used_percentage: 20, resets_at: '2030-01-05T00:00:00Z' },
      },
    });
    expect(snapshot?.buckets).toHaveLength(2);
    expect(snapshot?.state).toBe('limited');
    expect(snapshot?.source).toBe('claude-statusline');
  });

  it('groepeert Antigravity-buckets per model', () => {
    const snapshots = parseAntigravityStatuslinePayload({
      quota: {
        flash: { model_id: 'gemini-flash', remaining_fraction: 0.5, reset_time: '2030-01-01T00:00:00Z' },
        pro: { model_id: 'gemini-pro', remaining_fraction: 0, reset_time: '2030-01-01T00:00:00Z' },
      },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((item) => item.modelId === 'gemini-pro')?.state).toBe('cooldown');
  });

  it('slaat Google Service Usage-limieten op als vertraagd en blokkeert daar niet preventief op', () => {
    const snapshots = parseGoogleServiceUsageQuotas({
      metrics: [{ metric: 'generativelanguage.googleapis.com/generate_content_requests', consumerQuotaLimits: [{
        name: 'requests-per-minute', unit: '1/min/{project}', quotaBuckets: [{ effectiveLimit: 0 }],
      }] }],
    }, 'project-een');
    expect(snapshots[0].accuracy).toBe('delayed');
    expect(blockingQuotaForModel({ provider: 'google', modelId: 'gemini' }, snapshots, 'google:project:project-een')).toBeNull();
  });

  it('blokkeert alleen een actuele live cooldown', () => {
    const snapshots = parseClaudeStatuslinePayload({
      rate_limits: { five_hour: { used_percentage: 100, resets_at: '2030-01-01T00:00:00Z' } },
    }, '2029-12-31T23:59:00.000Z');
    expect(blockingQuotaForModel({ provider: 'anthropic', modelId: 'claude-cli:x' }, snapshots ? [snapshots] : [], 'anthropic:account', Date.parse('2029-12-31T23:59:30Z'))).not.toBeNull();
    expect(blockingQuotaForModel({ provider: 'anthropic', modelId: 'claude-cli:x' }, snapshots ? [snapshots] : [], 'anthropic:account', Date.parse('2030-01-02T00:00:00Z'))).toBeNull();
  });

  it('laat een webabonnement-cooldown niet lekken naar de API-verbinding', () => {
    const snapshot = makeUnknownQuota('openai', 'subscription-web', 'openai:account', 'Geen quotum.', 'runtime-error');
    snapshot.state = 'cooldown';
    snapshot.buckets = [{ id: 'runtime', label: 'Runtime', meter: 'provider', state: 'cooldown' }];

    expect(blockingQuotaForModel(
      { provider: 'openai', modelId: 'gpt-api-model' },
      [snapshot],
      'openai:gpt-api-model',
    )).toBeNull();
    expect(blockingQuotaForModel(
      { provider: 'openai', modelId: 'chatgpt:gpt-web-model' },
      [snapshot],
      'openai:account',
    )).not.toBeNull();
  });

  it('combineert Gemini Monitoring-limiet en vertraagd werkelijk verbruik per model', () => {
    const type = 'generativelanguage.googleapis.com/quota/generate_content_free_tier_requests';
    const snapshots = parseGoogleMonitoringQuotas({
      metricDescriptors: [
        { type: `${type}/limit`, metricKind: 'GAUGE', displayName: 'Requests per model per minuut' },
        { type: `${type}/usage`, metricKind: 'DELTA' },
      ],
      timeSeries: [
        { metric: { type: `${type}/limit`, labels: { limit_name: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', model: 'gemini-test' } }, points: [{ interval: { endTime: '2026-08-01T12:00:00Z' }, value: { int64Value: '15' } }] },
        { metric: { type: `${type}/usage`, labels: { limit_name: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', model: 'gemini-test', method: 'GenerateContent' } }, points: [
          { interval: { endTime: '2026-08-01T11:59:50Z' }, value: { int64Value: '3' } },
          { interval: { endTime: '2026-08-01T11:59:20Z' }, value: { int64Value: '2' } },
          { interval: { endTime: '2026-08-01T11:57:00Z' }, value: { int64Value: '9' } },
        ] },
      ],
    }, 'gemini-project', '2026-08-01T12:02:30Z');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].modelId).toBe('gemini-test');
    expect(snapshots[0].source).toBe('google-monitoring');
    expect(snapshots[0].accuracy).toBe('delayed');
    expect(snapshots[0].buckets[0]).toMatchObject({ used: 5, limit: 15, remaining: 10, windowSeconds: 60 });
  });
});
