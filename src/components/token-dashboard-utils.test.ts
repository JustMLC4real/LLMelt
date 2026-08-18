import { describe, expect, it } from 'vitest';
import type { AIModel, ProviderQuotaSnapshot, TokenDashboard } from '../providers/types';
import {
  currentQuotaSnapshots,
  mergeTokenDashboards,
  quotaSnapshotsForDashboard,
} from './token-dashboard-utils';

function dashboard(chatId: string | undefined, totalTokens: number): TokenDashboard {
  return {
    usageEvents: [],
    usageByModel: {
      model: {
        provider: 'openai',
        modelId: 'model',
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens,
        contextWindowSize: 100,
        contextUsedPercent: totalTokens,
        source: 'provider',
      },
    },
    rateLimits: [],
    quotas: [],
    context: {
      chatId,
      used: totalTokens,
      total: 100,
      percent: totalTokens,
      source: 'provider',
      windowSource: 'provider',
    },
  };
}

function model(patch: Partial<AIModel>): AIModel {
  return {
    id: 'model',
    name: 'Model',
    provider: 'openai',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
    ...patch,
  };
}

function quota(patch: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
  return {
    id: 'quota',
    provider: 'openai',
    surface: 'api',
    limitGroupKey: 'openai:api',
    state: 'available',
    source: 'headers',
    accuracy: 'live',
    observedAt: '2026-01-01T00:00:00.000Z',
    buckets: [],
    ...patch,
  };
}

describe('Token Dashboard-scopes', () => {
  it('behoudt appbreed modelverbruik maar gebruikt de context van de huidige chat', () => {
    const merged = mergeTokenDashboards(dashboard(undefined, 40), dashboard('chat-2', 7));
    expect(merged.usageByModel.model.totalTokens).toBe(40);
    expect(merged.context).toMatchObject({ chatId: 'chat-2', used: 7 });
  });

  it('filtert verlopen quota-snapshots uit het dashboard', () => {
    const now = Date.parse('2026-01-02T00:00:00.000Z');
    expect(currentQuotaSnapshots([
      quota({ id: 'fresh', staleAfter: '2026-01-02T00:00:01.000Z' }),
      quota({ id: 'stale', staleAfter: '2026-01-01T23:59:59.000Z' }),
      quota({ id: 'invalid', staleAfter: 'geen-datum' }),
    ], now).map((snapshot) => snapshot.id)).toEqual(['fresh']);
  });

  it('voegt per actieve API/remote-surface hoogstens één expliciete onbekende rij toe', () => {
    const models = [
      model({ id: 'openai-1', provider: 'openai', providerSurface: 'api' }),
      model({ id: 'openai-2', provider: 'openai', providerSurface: 'api' }),
      model({ id: 'claude-api', provider: 'anthropic', providerSurface: 'api' }),
      model({ id: 'remote', provider: 'remote', providerSurface: 'remote' }),
      model({ id: 'chatgpt', provider: 'openai', providerSurface: 'subscription-web' }),
    ];
    const rows = quotaSnapshotsForDashboard([], models, Date.parse('2026-01-02T00:00:00.000Z'));
    expect(rows.map((row) => `${row.provider}:${row.surface}`)).toEqual([
      'openai:api',
      'anthropic:api',
      'remote:remote',
    ]);
    expect(rows.every((row) => row.state === 'unknown' && row.accuracy === 'unavailable')).toBe(true);
  });

  it('vervangt een echte actuele snapshot niet door een synthetische onbekende rij', () => {
    const real = quota({ staleAfter: '2026-01-03T00:00:00.000Z' });
    const rows = quotaSnapshotsForDashboard(
      [real],
      [model({ provider: 'openai', providerSurface: 'api' })],
      Date.parse('2026-01-02T00:00:00.000Z'),
    );
    expect(rows).toEqual([real]);
  });
});
