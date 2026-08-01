import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { PROVIDER_INFO, type ProviderType, type TokenDashboard as TokenDashboardData } from '../providers/types';

const TokenDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { currentChatId } = useChatStore();
  const [dashboard, setDashboard] = useState<TokenDashboardData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return;
      const data = await window.electronAPI.tokens.getDashboard(currentChatId || undefined);
      setDashboard(data);
      useProviderStore.getState().setQuotaSnapshots(data.quotas || []);
    };
    load();
    const off = window.electronAPI?.tokens.onUsageUpdate((data) => {
      if (Array.isArray(data?.quotas)) useProviderStore.getState().setQuotaSnapshots(data.quotas);
      if (!currentChatId || data?.context?.chatId === currentChatId) setDashboard(data);
    });
    return () => off?.();
  }, [currentChatId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const context = dashboard?.context || { used: 0, total: 128000, percent: 0, source: 'estimate' };
  const usageRows = Object.values(dashboard?.usageByModel || {});
  const quotas = dashboard?.quotas || [];

  const refreshQuotas = async () => {
    if (!window.electronAPI || refreshing) return;
    setRefreshing(true);
    try {
      const snapshots = await window.electronAPI.tokens.refreshQuotas();
      useProviderStore.getState().setQuotaSnapshots(snapshots);
      setDashboard(await window.electronAPI.tokens.getDashboard(currentChatId || undefined));
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
            : 'Geen actief model'}
          {' · '}
          {contextSourceLabel(context.source)}
        </div>
        <div className="flex items-center justify-between text-sm mb-2">
          <span>{t('tokens.contextUsed')}</span>
          <span className="font-semibold">{context.percent}%</span>
        </div>
        <div className="context-bar">
          <div className={`context-bar-fill ${context.percent > 80 ? 'warning' : ''}`} style={{ width: `${Math.min(context.percent, 100)}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted mt-2">
          <span>{context.used.toLocaleString()} tokens</span>
          <span>{context.total.toLocaleString()} max</span>
        </div>
      </div>

      <div className="glass-card mb-4">
        <div className="glass-card-title">{t('tokens.model')}verbruik</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('tokens.model')}</th>
              <th>{t('tokens.input')}</th>
              <th>{t('tokens.output')}</th>
              <th>{t('tokens.total')}</th>
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
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={4} className="text-center text-muted py-4">
                  {t('tokens.noUsage')}
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
                  <td><span className={`quota-accuracy quota-accuracy-${quota.accuracy}`}>{t(`tokens.${quota.accuracy}`)}</span></td>
                  <td>{bucket.label}</td>
                  <td>{quotaBucketStatus(bucket)}</td>
                  <td>{bucket.resetAt ? formatCountdown(bucket.resetAt, now) : '—'}</td>
                </tr>
              ))
              : [(
                <tr key={quota.id}>
                  <td>{PROVIDER_INFO[quota.provider]?.name || quota.provider}</td>
                  <td><span className={`quota-accuracy quota-accuracy-${quota.accuracy}`}>{t(`tokens.${quota.accuracy}`)}</span></td>
                  <td>—</td>
                  <td>{quota.note || quota.state}</td>
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

function formatCountdown(resetAt: string, now: number) {
  const diff = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return 'Available';
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function contextSourceLabel(source?: string) {
  if (source === 'provider') return 'context uit provider-metadata';
  if (source === 'cli') return 'context uit CLI/status';
  if (source === 'estimate') return 'context geschat';
  return 'context onbekend';
}

function quotaBucketStatus(bucket: TokenDashboardData['quotas'][number]['buckets'][number]) {
  if (bucket.state === 'unlimited') return 'Onbeperkt';
  if (bucket.usedPercent != null) return `${Math.round(bucket.usedPercent)}% gebruikt`;
  if (bucket.remaining != null && bucket.limit != null) return `${bucket.remaining.toLocaleString()} / ${bucket.limit.toLocaleString()} resterend`;
  return bucket.state;
}

export default TokenDashboard;
