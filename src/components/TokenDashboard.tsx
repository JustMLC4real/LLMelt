import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { PROVIDER_INFO, type ProviderType, type TokenDashboard as TokenDashboardData } from '../providers/types';
import { formatQuotaCountdown, quotaStatusLabelKey, quotaWindowLabelKey } from '../providers/quota-display';
import { mergeTokenDashboards, quotaSnapshotsForDashboard } from './token-dashboard-utils';

const TokenDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { currentChatId } = useChatStore();
  const models = useProviderStore((state) => state.models);
  const [dashboard, setDashboard] = useState<TokenDashboardData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const dashboardLoadRef = useRef(0);

  const loadDashboard = useCallback(async () => {
    if (!window.electronAPI) return;
    const loadId = ++dashboardLoadRef.current;
    const [appWide, currentChat] = await Promise.all([
      window.electronAPI.tokens.getDashboard(),
      currentChatId
        ? window.electronAPI.tokens.getDashboard(currentChatId)
        : Promise.resolve(null),
    ]);
    if (loadId !== dashboardLoadRef.current) return;
    const data = mergeTokenDashboards(appWide, currentChat);
    setDashboard(data);
    useProviderStore.getState().setQuotaSnapshots(appWide.quotas || []);
  }, [currentChatId]);

  useEffect(() => {
    void loadDashboard();
    const off = window.electronAPI?.tokens.onUsageUpdate((data) => {
      if (Array.isArray(data?.quotas)) useProviderStore.getState().setQuotaSnapshots(data.quotas);
      void loadDashboard();
    });
    return () => {
      dashboardLoadRef.current += 1;
      off?.();
    };
  }, [loadDashboard]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const context = dashboard?.context || { used: 0, total: 0, percent: 0, source: 'unknown', windowSource: 'unknown' };
  const usageRows = Object.values(dashboard?.usageByModel || {});
  const quotas = quotaSnapshotsForDashboard(dashboard?.quotas || [], models, now);
  const exactContextPercent = context.total > 0 ? Math.max(0, context.used / context.total * 100) : 0;

  const refreshQuotas = async () => {
    if (!window.electronAPI || refreshing) return;
    setRefreshing(true);
    try {
      const snapshots = await window.electronAPI.tokens.refreshQuotas();
      useProviderStore.getState().setQuotaSnapshots(snapshots);
      await loadDashboard();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="token-dashboard" style={{ overflowY: 'auto', height: '100%' }}>
      <h2 className="font-semibold" style={{ fontSize: 'var(--font-size-xl)', marginBottom: 'var(--space-6)' }}>
        {t('tokens.dashboard')}
      </h2>

      <div className="glass-card mb-4">
        <div className="glass-card-title">{t('tokens.contextWindow')}</div>
        <div className="text-xs text-muted mb-3">
          {context.provider && context.modelId
            ? `${PROVIDER_INFO[context.provider as ProviderType]?.name || context.provider} - ${context.modelId}`
            : t('tokens.noActiveModel')}
          {' · '}
          {t('tokens.contextCountSource', { source: contextSourceLabel(context.source, t) })}
          {' · '}
          {t('tokens.contextWindowSource', { source: contextSourceLabel(context.windowSource, t) })}
        </div>
        <div className="text-xs text-muted mb-3">{t('tokens.contextHelp')}</div>
        <div className="flex items-center justify-between text-sm mb-2">
          <span>{t('tokens.contextUsed')}</span>
          <span className="font-semibold">{formatPercent(exactContextPercent)}</span>
        </div>
        <div className="context-bar">
          <div className={`context-bar-fill ${exactContextPercent > 80 ? 'warning' : ''}`} style={{ width: `${Math.min(exactContextPercent, 100)}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted mt-2">
          <span>{context.used.toLocaleString()} tokens</span>
          <span>{context.total.toLocaleString()} max</span>
        </div>
      </div>

      <div className="glass-card mb-4">
        <div className="glass-card-title">{t('tokens.modelUsage')}</div>
        <div className="text-xs font-medium mb-1">{t('tokens.usageScope')}</div>
        <div className="text-xs text-muted mb-3">{t('tokens.usageHelp')}</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('tokens.model')}</th>
              <th>{t('tokens.input')}</th>
              <th>{t('tokens.output')}</th>
              <th>{t('tokens.total')}</th>
              <th>{t('tokens.measurement')}</th>
            </tr>
          </thead>
          <tbody>
            {usageRows.length ? (
              usageRows.map((usage) => {
                const info = PROVIDER_INFO[usage.provider as ProviderType];
                return (
                  <tr key={`${usage.provider}:${usage.modelId}`}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span>{info?.icon || usage.provider}</span>
                        <span className="font-medium">{usage.modelId}</span>
                      </div>
                    </td>
                    <td>{usage.inputTokens.toLocaleString()}</td>
                    <td>{usage.outputTokens.toLocaleString()}</td>
                    <td>{usage.totalTokens.toLocaleString()}</td>
                    <td>{usageSourceLabel(usage.source, t)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="text-center text-muted py-4">
                  {t('tokens.noReportedUsage')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="glass-card">
        <div className="flex items-center justify-between mb-3">
          <div className="glass-card-title" style={{ marginBottom: 0 }}>{t('tokens.providerQuota')}</div>
          <button type="button" className="btn btn-secondary" onClick={refreshQuotas} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            {t('tokens.refresh')}
          </button>
        </div>
        <div className="text-xs text-muted mb-3">{t('tokens.quotaHelp')}</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>{t('tokens.source')}</th>
              <th>{t('tokens.window')}</th>
              <th>{t('tokens.status')}</th>
              <th>{t('tokens.reset')}</th>
            </tr>
          </thead>
          <tbody>
            {quotas.flatMap((quota) => quota.buckets.length
              ? quota.buckets.map((bucket) => (
                <tr key={`${quota.id}:${bucket.id}`}>
                  <td>{PROVIDER_INFO[quota.provider]?.name || quota.provider}{quota.planTier ? ` · ${quota.planTier}` : ''}</td>
                  <td>
                    <div className="text-xs">{quotaSurfaceLabel(quota.surface, t)} · {quotaSourceLabel(quota.source, t)}</div>
                    <span className={`quota-accuracy quota-accuracy-${quota.accuracy}`}>{t(`tokens.${quota.accuracy}`)}</span>
                  </td>
                  <td>{quotaBucketLabel(bucket, t)}</td>
                  <td>{quotaBucketStatus(bucket, t)}</td>
                  <td title={bucket.resetAt ? new Date(bucket.resetAt).toLocaleString() : undefined}>
                    {bucket.resetAt ? formatCountdown(bucket.resetAt, now, t) : '—'}
                  </td>
                </tr>
              ))
              : [(
                <tr key={quota.id}>
                  <td>{PROVIDER_INFO[quota.provider]?.name || quota.provider}</td>
                  <td>
                    <div className="text-xs">{quotaSurfaceLabel(quota.surface, t)} · {quotaSourceLabel(quota.source, t)}</div>
                    <span className={`quota-accuracy quota-accuracy-${quota.accuracy}`}>{t(`tokens.${quota.accuracy}`)}</span>
                  </td>
                  <td>—</td>
                  <td>{t(`tokens.${quotaStatusLabelKey(quota)}`)}</td>
                  <td>—</td>
                </tr>
              )])}
            {!quotas.length && (
              <tr><td colSpan={5} className="text-center text-muted py-4">{t('tokens.noQuota')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function formatCountdown(resetAt: string, now: number, t: TFunction) {
  return formatQuotaCountdown(resetAt, now, {
    available: t('tokens.availableNow'),
    day: t('tokens.dayShort'),
    hour: t('tokens.hourShort'),
    minute: t('tokens.minuteShort'),
    second: t('tokens.secondShort'),
  });
}

function contextSourceLabel(source: string | undefined, t: TFunction) {
  if (source === 'provider') return t('tokens.providerMeasured');
  if (source === 'cli') return t('tokens.cliMeasured');
  if (source === 'estimate') return t('tokens.usageEstimated');
  return t('tokens.usageUnknown');
}

function usageSourceLabel(source: string | undefined, t: TFunction) {
  if (source === 'provider') return t('tokens.providerMeasured');
  if (source === 'cli') return t('tokens.cliMeasured');
  if (source === 'local') return t('tokens.localMeasured');
  if (source === 'estimate') return t('tokens.usageEstimated');
  if (source === 'mixed') return t('tokens.usageMixed');
  return t('tokens.usageUnknown');
}

function quotaBucketStatus(bucket: TokenDashboardData['quotas'][number]['buckets'][number], t: TFunction) {
  if (bucket.state === 'unlimited') return t('tokens.localLimit');
  if (bucket.usedPercent != null) {
    const used = Math.round(bucket.usedPercent);
    const remaining = Math.round((bucket.remainingFraction ?? Math.max(0, 1 - bucket.usedPercent / 100)) * 100);
    return t('tokens.usedAndRemainingPercent', { used, remaining });
  }
  if (bucket.remaining != null && bucket.limit != null) {
    return t('tokens.remainingOfLimit', {
      remaining: bucket.remaining.toLocaleString(),
      limit: bucket.limit.toLocaleString(),
    });
  }
  if (bucket.state === 'unknown' || bucket.state === 'unavailable') return t('tokens.limitUnknown');
  return bucket.state;
}

function quotaBucketLabel(bucket: TokenDashboardData['quotas'][number]['buckets'][number], t: TFunction) {
  const key = quotaWindowLabelKey(bucket);
  return key ? t(`tokens.${key}`) : bucket.label;
}

function quotaSurfaceLabel(surface: TokenDashboardData['quotas'][number]['surface'], t: TFunction) {
  return t(`tokens.surface_${surface.replace('-', '_')}`);
}

function quotaSourceLabel(source: TokenDashboardData['quotas'][number]['source'], t: TFunction) {
  return t(`tokens.quotaSource_${source.replaceAll('-', '_')}`);
}

function formatPercent(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export default TokenDashboard;
