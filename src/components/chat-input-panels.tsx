import React from 'react';
import type { TFunction } from 'i18next';
import { Check, Loader2, Pause, Play, Sparkles, Square, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AutoModePhase, AutoModeStatus, TokenDashboard } from '../providers/types';
import type { QueuedAgentApproval } from './approval-queue';
import type { CommandPreset } from './command-presets';

export function DeferredApprovalDock({
  approval,
  total,
  onRespond,
}: {
  approval: QueuedAgentApproval;
  total: number;
  onRespond: (approval: QueuedAgentApproval, approved: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="approval-dock motion-panel" role="status">
      <div className="approval-dock-icon"><Terminal size={16} /></div>
      <div className="approval-dock-content">
        <div className="approval-dock-title">
          <span>{t('chat.approval.waiting', { action: localizedApprovalTitle(approval, t) })}</span>
          <span className="approval-dock-count">
            {total > 1 ? t('chat.approval.position', { current: 1, total }) : t('chat.approval.deferred')}
          </span>
        </div>
        <code className="approval-dock-command" title={approval.command}>{approval.command}</code>
      </div>
      <div className="approval-dock-actions">
        <button className="btn btn-primary" onClick={() => onRespond(approval, true)}>
          <Check size={14} /> {t('chat.approval.allow')}
        </button>
        <button className="btn btn-secondary" onClick={() => onRespond(approval, false)}>
          <X size={14} /> {t('chat.approval.deny')}
        </button>
      </div>
    </div>
  );
}

export function AutoModeComposerDock({
  status,
  detail,
  iteration,
  maxIterations,
  phase,
  promptPreview,
  onAction,
}: {
  status: AutoModeStatus;
  detail: string;
  iteration: number;
  maxIterations: number;
  phase: AutoModePhase;
  promptPreview: string;
  onAction: (action: 'pause' | 'resume' | 'stop') => void;
}) {
  const { t } = useTranslation();
  const currentRound = iteration + (phase === 'waiting' ? 0 : 1);
  return (
    <div className="auto-mode-composer-dock motion-panel" role="status" aria-live="polite">
      <div className={`auto-mode-composer-icon ${status === 'running' ? 'busy' : ''}`}>
        {status === 'running' ? <Loader2 size={16} /> : <Sparkles size={16} />}
      </div>
      <div className="auto-mode-composer-copy">
        <div className="auto-mode-composer-title">
          <strong>{t('autoMode.title')}</strong>
          <span>{status === 'paused' ? t('autoMode.paused') : detail || t('autoMode.running')}</span>
          <small>
            {maxIterations === 0
              ? t('autoMode.roundInfinite', { current: currentRound })
              : t('autoMode.round', { current: Math.min(currentRound, maxIterations), max: maxIterations })}
          </small>
        </div>
        {promptPreview && <p title={promptPreview}>{promptPreview}</p>}
      </div>
      <div className="auto-mode-composer-actions">
        {status === 'running' ? (
          <button type="button" className="btn-icon" onClick={() => onAction('pause')} title={t('autoMode.pause')} aria-label={t('autoMode.pause')}><Pause size={15} /></button>
        ) : (
          <button type="button" className="btn-icon" onClick={() => onAction('resume')} title={t('autoMode.resume')} aria-label={t('autoMode.resume')}><Play size={15} /></button>
        )}
        <button type="button" className="btn-icon danger" onClick={() => onAction('stop')} title={t('autoMode.stop')} aria-label={t('autoMode.stop')}><Square size={14} /></button>
      </div>
    </div>
  );
}

export function CommandPalette({
  matches,
  onPick,
}: {
  matches: CommandPreset[];
  onPick: (preset: CommandPreset) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="command-palette motion-panel">
      {(['provider-native', 'llmelt-workflow'] as const).map((source) => {
        const sourceMatches = matches.filter((preset) => preset.source === source);
        if (!sourceMatches.length) return null;
        return (
          <React.Fragment key={source}>
            <div className="command-palette-section-label">
              {source === 'provider-native' ? t('runSettings.providerNative') : t('runSettings.appWorkflows')}
            </div>
            {sourceMatches.map((preset) => {
              const Icon = preset.icon;
              return (
                <button key={preset.id} type="button" className="command-palette-item" onClick={() => onPick(preset)}>
                  <Icon size={16} />
                  <span>
                    <strong>{preset.slash}</strong>
                    <small>{preset.description}</small>
                  </span>
                </button>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function ContextMeter({ context, fallbackTotal }: { context: TokenDashboard['context'] | null; fallbackTotal: number }) {
  const { t } = useTranslation();
  const total = context?.total || fallbackTotal || 0;
  const used = context?.used || 0;
  const percent = total > 0 ? Math.max(0, used / total * 100) : 0;
  const source = context?.source || (total ? 'estimate' : 'unknown');
  const windowSource = context?.windowSource || (fallbackTotal ? 'estimate' : 'unknown');
  const sourceLabel = contextMeterSourceLabel(source, t);
  const windowSourceLabel = contextMeterSourceLabel(windowSource, t);

  return (
    <div
      className="composer-context-meter"
      title={`${t('tokens.contextCountSource', { source: sourceLabel })} · ${t('tokens.contextWindowSource', { source: windowSourceLabel })}`}
    >
      <div className="context-mini-bar">
        <div className={`context-mini-fill ${percent > 80 ? 'warning' : ''}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span>{formatTokens(used)} / {total ? formatTokens(total) : '—'}</span>
      <span>{formatContextPercent(percent)}</span>
      <span>{sourceLabel}</span>
    </div>
  );
}

function localizedApprovalTitle(approval: QueuedAgentApproval, t: TFunction) {
  const knownLabels: Record<string, string> = {
    'bestand lezen': t('chat.approval.fileRead'),
    'bestand maken': t('chat.approval.fileCreate'),
    'bestand wijzigen': t('chat.approval.fileEdit'),
    'commando uitvoeren': t('chat.approval.runCommand'),
  };
  if (approval.label) return knownLabels[approval.label.trim().toLowerCase()] || approval.label;
  if (approval.kind === 'file-read') return t('chat.approval.fileRead');
  if (approval.kind === 'file-create') return t('chat.approval.fileCreate');
  if (approval.kind === 'file-edit') return t('chat.approval.fileEdit');
  return t('chat.approval.runCommand');
}

function contextMeterSourceLabel(source: string, t: TFunction) {
  if (source === 'provider') return t('tokens.providerMeasured');
  if (source === 'cli') return t('tokens.cliMeasured');
  if (source === 'local') return t('tokens.localMeasured');
  if (source === 'estimate') return t('tokens.usageEstimated');
  return t('tokens.usageUnknown');
}

function formatContextPercent(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
