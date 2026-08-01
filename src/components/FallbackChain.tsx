import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Bot, Cloud, Cpu, Globe2, Link2, Rocket, Server, Terminal, Trash2, Unlink, type LucideIcon } from 'lucide-react';
import { useProviderStore } from '../stores/provider-store';
import { PROVIDER_INFO, type AIModel, type FallbackConfig, type ModelRef, type ProviderType, type RateLimitSnapshot, type ReasoningEffort, type ServiceTier } from '../providers/types';
import {
  chatgptLevelKey,
  chatgptModels,
  chatgptPresetFor,
  codexEffortForModel,
  codexEffortsForModel,
  codexModels,
  codexRunConfig,
  modelDisplayName,
  reasoningEffortLabel,
  selectableModels,
  serviceTierLabel,
  serviceTiersForModel,
  surfaceLabel,
} from './model-utils';
import { FlipText, QuotaBadge, SelectField, limitGroupForModel } from './ui';

type Entry = { modelRef: ModelRef; enabled: boolean; allowPaidApi?: boolean };

const FallbackChain: React.FC = () => {
  const { t } = useTranslation();
  const { models, fallbackConfig, setFallbackConfig, chatgptVersions, quotaSnapshots } = useProviderStore();
  const [order, setOrder] = useState<Entry[]>(fallbackConfig.order);
  const [autoSwitch, setAutoSwitch] = useState(fallbackConfig.autoSwitchEnabled);
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot[]>([]);
  const [addValue, setAddValue] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setOrder(fallbackConfig.order);
    setAutoSwitch(fallbackConfig.autoSwitchEnabled);
  }, [fallbackConfig]);

  useEffect(() => {
    window.electronAPI?.tokens.getRateLimits().then(setRateLimits).catch(() => {});
    window.electronAPI?.tokens.getQuotas().then((snapshots) => {
      useProviderStore.getState().setQuotaSnapshots(snapshots);
    }).catch(() => {});
  }, []);

  const chatModels = useMemo(() => selectableModels(models), [models]);
  const fallbackCodexModels = useMemo(() => codexModels(models), [models]);

  // Models that can still be added: dedupe by limit group so account-wide
  // providers (Codex, ChatGPT) only appear once, and skip ones already in the chain.
  const availableToAdd = useMemo(() => {
    const usedGroups = new Set(order.map((entry) => limitGroupForRef(entry.modelRef, models)));
    const seen = new Set<string>();
    const result: AIModel[] = [];
    for (const model of chatModels) {
      const group = limitGroupForModel(model);
      if (usedGroups.has(group) || seen.has(group)) continue;
      seen.add(group);
      result.push(model);
    }
    return result;
  }, [chatModels, models, order]);

  const selectedAddValue = addValue || modelValue(availableToAdd[0]);
  const codexAlreadyInChain = order.some((entry) => limitGroupForRef(entry.modelRef, models) === 'codex:account');

  const persist = async (next: Entry[], auto = autoSwitch) => {
    const deduped = dedupeEntries(next, models);
    const config: FallbackConfig = { order: deduped, autoSwitchEnabled: auto, autoSwitchConfirmed: true };
    setOrder(deduped);
    setAutoSwitch(auto);
    setFallbackConfig(config);
    const saved = await window.electronAPI?.fallback.setConfig(config);
    if (saved) setFallbackConfig(saved);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1400);
  };

  // Self-heal: a saved entry can point at a model id that no longer exists (an old
  // ChatGPT slug), which renders as "Geen model". Once models are loaded, remap any
  // stale ChatGPT entry to a valid ChatGPT model so it's usable again.
  useEffect(() => {
    if (!models.length || !order.length) return;
    const chatgptList = chatgptModels(models);
    if (!chatgptList.length) return;
    let changed = false;
    const repaired = order.map((entry) => {
      const exists = models.some((m) => m.provider === entry.modelRef.provider && m.id === entry.modelRef.modelId);
      if (exists) return entry;
      if (entry.modelRef.provider === 'openai' && entry.modelRef.modelId.startsWith('chatgpt:')) {
        changed = true;
        return { ...entry, modelRef: { provider: 'openai' as ProviderType, modelId: chatgptList[0].id, runConfig: chatgptList[0].runConfig } };
      }
      return entry;
    });
    if (changed) persist(repaired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, order]);

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  };

  const toggle = (index: number) => persist(order.map((entry, i) => (i === index ? { ...entry, enabled: !entry.enabled } : entry)));

  const remove = (index: number) => persist(order.filter((_, i) => i !== index));
  const togglePaidApi = (index: number) => {
    const enabling = order[index]?.allowPaidApi !== true;
    if (enabling && !window.confirm(t('fallbackChain.paidApiConfirm'))) return;
    persist(order.map((entry, itemIndex) => (
      itemIndex === index ? { ...entry, allowPaidApi: enabling } : entry
    )));
  };

  const add = () => {
    const value = selectedAddValue;
    if (!value) return;
    const [provider, ...rest] = value.split(':');
    const modelId = rest.join(':');
    const model = chatModels.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    const entry: Entry = {
      enabled: true,
      modelRef: { provider: provider as ProviderType, modelId, runConfig: model?.runConfig },
    };
    setAddValue('');
    persist([...order, entry]);
  };

  const updateCodexEntry = (index: number, modelId: string, runConfigPatch: Partial<ModelRef['runConfig']>) => {
    const model = fallbackCodexModels.find((candidate) => candidate.id === modelId) || fallbackCodexModels[0];
    if (!model) return;
    const nextRunConfig = codexRunConfig(model, {
      ...(order[index]?.modelRef.runConfig || {}),
      ...runConfigPatch,
      baseModelId: model.id,
    });
    persist(order.map((entry, itemIndex) => (
      itemIndex === index
        ? { ...entry, modelRef: { provider: 'codex', modelId: model.id, runConfig: nextRunConfig } }
        : entry
    )));
  };

  // Composite ChatGPT entry: Model + Intelligentie, rechtstreeks uit ChatGPT's eigen
  // kiezer (versions + intelligence_presets). Elk niveau wijst naar een bestaande
  // slug, dus er kan geen combinatie ontstaan die de backend niet kent.
  const updateChatgptEntry = (index: number, patch: { versionTitle?: string; levelKey?: string }) => {
    const entry = order[index];
    const versions = chatgptVersions.filter((version) => version.enabled);
    if (!versions.length) return;

    const current = modelFor(entry.modelRef);
    const currentHit = current
      ? chatgptPresetFor(versions, current.id, entry.modelRef.runConfig?.chatgptThinkingEffort)
      : null;
    const versionTitle = patch.versionTitle ?? currentHit?.version.title ?? versions[0].title;
    const version = versions.find((candidate) => candidate.title === versionTitle) || versions[0];

    const wantedKey = patch.levelKey
      ?? (currentHit ? chatgptLevelKey(`chatgpt:${currentHit.preset.modelSlug}`, currentHit.preset.thinkingEffort) : '');
    const preset = version.presets.find(
      (candidate) => chatgptLevelKey(`chatgpt:${candidate.modelSlug}`, candidate.thinkingEffort) === wantedKey,
    ) || version.presets[0];
    if (!preset) return;

    const model = models.find((candidate) => candidate.id === `chatgpt:${preset.modelSlug}`);
    if (!model) return;

    persist(order.map((e, i) => (
      i === index
        ? { ...e, modelRef: { provider: 'openai' as ProviderType, modelId: model.id, runConfig: { ...(model.runConfig || {}), ...(preset.thinkingEffort ? { chatgptThinkingEffort: preset.thinkingEffort } : {}) } } }
        : e
    )));
  };

  const modelFor = (ref: ModelRef) => models.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
  const snapshotFor = (ref: ModelRef) => {
    const group = limitGroupForRef(ref, models);
    return rateLimits.find((item) => item.limitGroupKey === group || (item.provider === ref.provider && (!item.modelId || item.modelId === ref.modelId)));
  };
  const quotaFor = (ref: ModelRef) => {
    const group = limitGroupForRef(ref, models);
    return quotaSnapshots.find((item) => item.limitGroupKey === group || (item.provider === ref.provider && (!item.modelId || item.modelId === ref.modelId)));
  };

  return (
    <div className="fallback-chain">
      <div className="fallback-chain-header">
        <p className="fallback-chain-help">{t('fallbackChain.help')}</p>
        <label className="fallback-auto-toggle">
          <input type="checkbox" checked={autoSwitch} onChange={(event) => persist(order, event.target.checked)} />
          <FlipText text={t('fallbackChain.autoSwitch')} />
        </label>
      </div>

      {order.length === 0 && <div className="model-empty-row fallback-empty-row">{t('fallbackChain.empty')}</div>}

      <div className="fallback-list">
        {order.map((entry, index) => {
          const info = PROVIDER_INFO[entry.modelRef.provider];
          const model = modelFor(entry.modelRef);
          const ProviderIcon = providerIcon(entry.modelRef.provider);
          const title = entry.modelRef.provider === 'codex' ? 'Codex CLI' : modelDisplayName(model) || entry.modelRef.modelId;
          const subtitle = entry.modelRef.provider === 'codex' ? modelDisplayName(model) : model ? surfaceLabel(model) : info?.name || entry.modelRef.provider;
          const isChatgpt = entry.modelRef.provider === 'openai' && entry.modelRef.modelId.startsWith('chatgpt:');
          const paidApi = isPaidApiEntry(entry.modelRef);
          return (
            <React.Fragment key={`${entry.modelRef.provider}:${entry.modelRef.modelId}`}>
              <div
                className={`fallback-item glass-card ${entry.enabled ? '' : 'fallback-item-disabled'}`}
                style={{ borderLeft: `3px solid ${info?.color || 'var(--accent-cyan)'}` }}
              >
                <span className="fallback-rank">{index + 1}</span>
                <span className="fallback-icon" style={{ color: info?.color }}>
                  <ProviderIcon size={16} />
                </span>
                <div className="fallback-meta">
                  <div className="fallback-name">{title}</div>
                  <div className="fallback-sub">{subtitle}</div>
                </div>
                <QuotaBadge quota={quotaFor(entry.modelRef)} snapshot={snapshotFor(entry.modelRef)} model={model || ({ provider: entry.modelRef.provider, id: entry.modelRef.modelId } as AIModel)} />
                <div className="fallback-actions">
                  <button type="button" className="btn-icon" onClick={() => move(index, -1)} disabled={index === 0} title={t('fallbackChain.up')} aria-label={t('fallbackChain.up')}>
                    <ArrowUp size={15} />
                  </button>
                  <button type="button" className="btn-icon" onClick={() => move(index, 1)} disabled={index === order.length - 1} title={t('fallbackChain.down')} aria-label={t('fallbackChain.down')}>
                    <ArrowDown size={15} />
                  </button>
                  <button type="button" className="btn-icon" onClick={() => toggle(index)} title={entry.enabled ? t('fallbackChain.disable') : t('fallbackChain.enable')} aria-label={entry.enabled ? t('fallbackChain.disable') : t('fallbackChain.enable')}>
                    {entry.enabled ? <Link2 size={15} /> : <Unlink size={15} />}
                  </button>
                  <button type="button" className="btn-icon" onClick={() => remove(index)} title={t('common.delete')} aria-label={t('common.delete')}>
                    <Trash2 size={15} />
                  </button>
                </div>
                {paidApi && (
                  <label className="fallback-paid-api-toggle">
                    <input type="checkbox" checked={entry.allowPaidApi === true} onChange={() => togglePaidApi(index)} />
                    <span>{t('fallbackChain.allowPaidApi')}</span>
                  </label>
                )}
                {entry.modelRef.provider === 'codex' && (
                  <div className="fallback-codex-settings">
                    <SelectField
                      label="Model"
                      value={model?.id || entry.modelRef.modelId}
                      onChange={(modelId) => updateCodexEntry(index, modelId, {})}
                      options={fallbackCodexModels.map((candidate) => ({
                        value: candidate.id,
                        label: modelDisplayName(candidate),
                      }))}
                    />
                    <SelectField
                      label="Inspanning"
                      value={codexEffortForModel(model, entry.modelRef.runConfig?.reasoningEffort)}
                      onChange={(value) => updateCodexEntry(index, model?.id || entry.modelRef.modelId, { reasoningEffort: value as ReasoningEffort })}
                      options={codexEffortsForModel(model).map((effort) => ({
                        value: effort,
                        label: reasoningEffortLabel(effort),
                      }))}
                    />
                    <SelectField
                      label="Snelheid"
                      value={entry.modelRef.runConfig?.serviceTier || model?.runConfig?.serviceTier || serviceTiersForModel(model)[0] || ''}
                      onChange={(value) => updateCodexEntry(index, model?.id || entry.modelRef.modelId, { serviceTier: value as ServiceTier })}
                      options={serviceTiersForModel(model).map((tier) => ({ value: tier, label: serviceTierLabel(tier) }))}
                    />
                  </div>
                )}
                {isChatgpt && (() => {
                  const cg = modelFor(entry.modelRef);
                  const versions = chatgptVersions.filter((version) => version.enabled);
                  const hit = cg ? chatgptPresetFor(versions, cg.id, entry.modelRef.runConfig?.chatgptThinkingEffort) : null;
                  const activeVersion = versions.find((version) => version.title === hit?.version.title) || versions[0];
                  const presets = activeVersion?.presets || [];
                  const activeKey = hit
                    ? chatgptLevelKey(`chatgpt:${hit.preset.modelSlug}`, hit.preset.thinkingEffort)
                    : (presets[0] ? chatgptLevelKey(`chatgpt:${presets[0].modelSlug}`, presets[0].thinkingEffort) : '');
                  if (!versions.length) return null;
                  return (
                    <div className="fallback-codex-settings">
                      <SelectField
                        label="Model"
                        value={activeVersion?.title || ''}
                        onChange={(versionTitle) => updateChatgptEntry(index, { versionTitle })}
                        options={versions.map((version) => ({ value: version.title, label: version.title }))}
                      />
                      {presets.length > 1 && (
                        <SelectField
                          label="Intelligentie"
                          value={activeKey}
                          onChange={(levelKey) => updateChatgptEntry(index, { levelKey })}
                          options={presets.map((preset) => ({
                            value: chatgptLevelKey(`chatgpt:${preset.modelSlug}`, preset.thinkingEffort),
                            label: preset.subtitle ? `${preset.title} · ${preset.subtitle}` : preset.title,
                            disabled: !preset.available,
                          }))}
                        />
                      )}
                    </div>
                  );
                })()}
              </div>
              {index < order.length - 1 && (
                <div className="fallback-arrow" aria-hidden="true">
                  <ArrowDown size={15} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="fallback-add">
        <SelectField
          value={selectedAddValue}
          onChange={setAddValue}
          placeholder={t('fallbackChain.addPlaceholder')}
          options={availableToAdd.map((model) => ({
            value: modelValue(model),
            label: model.provider === 'codex' ? 'Codex CLI' : `${PROVIDER_INFO[model.provider]?.name} - ${modelDisplayName(model)}`,
            description: model.provider === 'codex' ? modelDisplayName(model) : surfaceLabel(model),
          }))}
        />
        <button type="button" className="btn btn-secondary" onClick={add} disabled={!selectedAddValue}>
          <FlipText text={t('fallbackChain.add')} />
        </button>
        {justSaved && <span className="fallback-saved">{t('common.save')}</span>}
      </div>
      {codexAlreadyInChain && fallbackCodexModels.length > 0 && (
        <div className="fallback-add-note">{t('fallbackChain.empty')}</div>
      )}
    </div>
  );
};

function modelValue(model?: AIModel) {
  return model ? `${model.provider}:${model.id}` : '';
}

function limitGroupForRef(ref: ModelRef, models: AIModel[]) {
  const model = models.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
  if (model) return limitGroupForModel(model);
  if (ref.provider === 'codex') return 'codex:account';
  if (ref.provider === 'openai' && ref.modelId.startsWith('chatgpt:')) return 'openai:account';
  return `${ref.provider}:${ref.modelId}`;
}

// Drop duplicate account-wide entries (same limit group) keeping the first.
function dedupeEntries(entries: Entry[], models: AIModel[]) {
  const seen = new Set<string>();
  const result: Entry[] = [];
  for (const entry of entries) {
    if (!entry?.modelRef?.provider || !entry.modelRef.modelId) continue;
    const group = limitGroupForRef(entry.modelRef, models);
    if (seen.has(group)) continue;
    seen.add(group);
    result.push(entry);
  }
  return result;
}

function providerIcon(provider: ProviderType): LucideIcon {
  switch (provider) {
    case 'codex': return Terminal;
    case 'openai': return Globe2;
    case 'anthropic': return Bot;
    case 'google': return Cloud;
    case 'ollama': return Cpu;
    case 'remote': return Server;
    default: return Rocket;
  }
}

function isPaidApiEntry(ref: ModelRef) {
  if (ref.provider === 'google' || ref.provider === 'remote') return true;
  if (ref.provider === 'openai') return !ref.modelId.startsWith('chatgpt:');
  if (ref.provider === 'anthropic') return !ref.modelId.startsWith('claude-cli:');
  return false;
}

export default FallbackChain;
