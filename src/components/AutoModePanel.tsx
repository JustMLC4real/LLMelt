import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import type { AIModel, ChatgptVersion, ModelRef } from '../providers/types';
import {
  antigravityModelFor,
  antigravityModelNamesFor,
  antigravityModesFor,
  antigravityProviders,
  chatgptEffortsForModel,
  claudeCliFamilies,
  claudeCliModelFor,
  claudeCliVersionsFor,
  compactModelChoiceLabel,
  connectedModels,
  parseAntigravityModel,
  parseClaudeCliModel,
  parseCodexModel,
  parseGoogleModelChoice,
  reasoningEffortLabel,
  serviceTierLabel,
  surfaceLabel,
} from './model-utils';
import { autoModePhaseInfo, autoModeStepState } from './auto-mode-utils';
import {
  autoModeChatgptChoiceForRef,
  autoModeChatgptChoiceForVersion,
  autoModeChatgptRefForChoice,
  autoModeModelByKey,
  autoModeModelKey,
  autoModeModelRef,
  autoModeModelsForSurface,
  autoModeSurfaces,
  availableAutoModeChatgptPresets,
  availableAutoModeChatgptVersions,
  normalizeAutoModeChatgptRef,
  withAutoModeChatgptEffort,
  withAutoModeReasoningEffort,
  withAutoModeServiceTier,
} from './auto-mode-model-selection';
import { ensureChatMaterialized } from './new-chat';
import { SelectField } from './ui';

const AutoModePanel: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const currentChatId = useChatStore((state) => state.currentChatId);
  const {
    models,
    authStatus,
    chatgptSessionActive,
    chatgptVersions,
    autoModeStatus,
    autoModeIteration,
    autoModeTotalTokens,
    autoModeMaxIterations,
    autoModeDetail,
    autoModePhase,
    autoModeLastPromptPreview,
    autoModeError,
    setAutoModeState,
  } = useProviderStore();

  const availableModels = useMemo(
    () => connectedModels(models, authStatus, chatgptSessionActive),
    [authStatus, chatgptSessionActive, models],
  );
  const [prompterRef, setPrompterRef] = useState<ModelRef | null>(null);
  const [responderRef, setResponderRef] = useState<ModelRef | null>(null);
  const [maxIterations, setMaxIterations] = useState(5);
  const [unlimitedIterations, setUnlimitedIterations] = useState(false);
  const [delay, setDelay] = useState(2);
  const [tokenBudget, setTokenBudget] = useState(0);
  const [goal, setGoal] = useState('');
  const [startError, setStartError] = useState('');

  useEffect(() => {
    if (!availableModels.length) {
      setPrompterRef(null);
      setResponderRef(null);
      return;
    }
    const validRef = (current: ModelRef | null, fallback: AIModel) => {
      const liveModel = current
        ? autoModeModelByKey(availableModels, `${current.provider}:${current.modelId}`)
        : undefined;
      const candidate = liveModel ? current! : autoModeModelRef(fallback);
      if (candidate.provider === 'openai'
        && candidate.modelId.startsWith('chatgpt:')
        && chatgptVersions.length) {
        return normalizeAutoModeChatgptRef(chatgptVersions, availableModels, candidate)
          || autoModeModelRef(fallback);
      }
      return candidate;
    };
    setPrompterRef((current) => validRef(current, availableModels[0]));
    setResponderRef((current) => validRef(current, availableModels[1] || availableModels[0]));
  }, [availableModels, chatgptVersions]);

  const handleStart = async () => {
    if (!window.electronAPI || !currentChatId || !prompterRef || !responderRef) return;
    if (unlimitedIterations && tokenBudget <= 0 && !window.confirm('Auto Mode staat op oneindig zonder tokenbudget. Weet je zeker dat je wilt starten?')) return;
    setStartError('');
    try {
      await ensureChatMaterialized(currentChatId);
      const status = await window.electronAPI.autoMode.start({
        prompterModelRef: prompterRef,
        responderModelRef: responderRef,
        maxIterations: unlimitedIterations ? 0 : maxIterations,
        delayMs: delay * 1000,
        tokenBudget: tokenBudget > 0 ? tokenBudget : undefined,
        chatId: currentChatId,
        goal: goal.trim() || undefined,
      });
      setAutoModeState(status);
      onClose?.();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  };

  const handlePause = async () => {
    const status = await window.electronAPI?.autoMode.pause();
    if (status) setAutoModeState(status);
  };

  const handleResume = async () => {
    const status = await window.electronAPI?.autoMode.resume();
    if (status) setAutoModeState(status);
  };

  const handleStop = async () => {
    const status = await window.electronAPI?.autoMode.stop();
    if (status) setAutoModeState(status);
  };

  const autoModeLocked = autoModeStatus === 'running' || autoModeStatus === 'paused';
  const visibleMaxIterations = autoModeMaxIterations || (unlimitedIterations ? 0 : maxIterations);
  const phase = autoModePhase || 'idle';
  const phaseInfo = autoModePhaseInfo(phase);
  const visibleError = autoModeError || startError;

  return (
    <div className="auto-mode-panel" style={{ margin: '0 var(--space-4)', marginTop: 'var(--space-2)' }}>
      <div className="panel-header-row">
        <span className="font-semibold text-sm">{t('autoMode.title')}</span>
        <div className="panel-header-actions">
          <span className={`status-badge ${phase === 'error' || phase === 'stopped' ? 'offline' : autoModeStatus === 'running' ? 'limited' : 'online'}`}>
            {phaseInfo.label}
          </span>
          {onClose && (
            <button type="button" className="btn-icon" onClick={onClose} title="Inklappen" aria-label="Auto Mode inklappen">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted" style={{ marginTop: 'var(--space-1)' }}>{t('autoMode.description')}</p>

      {(phase !== 'idle' || autoModeDetail || visibleError) && (
        <div className={`auto-mode-progress-card ${phase === 'error' ? 'error' : ''}`} aria-live="polite">
          <div className="auto-mode-progress-heading">
            <span className={`auto-mode-phase-icon ${phaseInfo.busy ? 'busy' : ''}`}>
              {phaseInfo.busy
                ? <Loader2 size={17} />
                : phase === 'error'
                  ? <AlertCircle size={17} />
                  : <CheckCircle2 size={17} />}
            </span>
            <div>
              <div className="auto-mode-progress-title">{phaseInfo.title}</div>
              <div className="auto-mode-progress-detail">{autoModeDetail || phaseInfo.description}</div>
            </div>
          </div>
          <div className="auto-mode-phase-steps">
            {(['prompter', 'responder', 'waiting'] as const).map((step, index) => {
              const state = autoModeStepState(phase, index);
              const labels = ['Prompt maken', 'Antwoord maken', 'Volgende ronde'];
              return <span key={step} className={`auto-mode-phase-step ${state}`}>{labels[index]}</span>;
            })}
          </div>
          {autoModeLastPromptPreview && (
            <div className="auto-mode-prompt-preview">
              <span>Laatste gemaakte prompt</span>
              <p>{autoModeLastPromptPreview}</p>
            </div>
          )}
          {visibleError && <div className="auto-mode-error"><AlertCircle size={15} /> {visibleError}</div>}
        </div>
      )}

      <div style={{ marginTop: 'var(--space-3)' }}>
        <label className="text-xs text-muted">Doel / opdracht voor de prompter</label>
        <textarea
          className="input mt-2"
          rows={2}
          placeholder="Bijv. 'Bouw stap voor stap een marketingplan voor een nieuwe app' - de prompter stuurt het gesprek hierop aan."
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          disabled={autoModeLocked}
          style={{ resize: 'vertical' }}
        />
      </div>

      <div className="auto-mode-config-grid">
        <RoleModelPicker
          label={t('autoMode.prompter')}
          help="Bedenkt steeds de volgende concrete opdracht."
          models={availableModels}
          value={prompterRef}
          onChange={setPrompterRef}
          disabled={autoModeLocked}
          chatgptVersions={chatgptVersions}
        />
        <RoleModelPicker
          label={t('autoMode.responder')}
          help="Voert die opdracht uit in dit gesprek."
          models={availableModels}
          value={responderRef}
          onChange={setResponderRef}
          disabled={autoModeLocked}
          chatgptVersions={chatgptVersions}
        />
        <div>
          <label className="text-xs text-muted">{t('autoMode.iterations')}</label>
          <div className="auto-mode-iteration-row">
            <input
              className="input"
              type="number"
              min={1}
              max={1000}
              value={maxIterations}
              onChange={(event) => setMaxIterations(Number(event.target.value))}
              disabled={autoModeLocked || unlimitedIterations}
            />
            <label className="auto-mode-unlimited-toggle">
              <input
                type="checkbox"
                checked={unlimitedIterations}
                onChange={(event) => setUnlimitedIterations(event.target.checked)}
                disabled={autoModeLocked}
              />
              <span>Oneindig</span>
            </label>
          </div>
        </div>
        <div>
          <label className="text-xs text-muted">{t('autoMode.delay')}</label>
          <input className="input mt-2" type="number" min={1} max={60} value={delay} onChange={(event) => setDelay(Number(event.target.value))} disabled={autoModeLocked} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="text-xs text-muted">Tokenbudget (0 = geen limiet)</label>
          <input className="input mt-2" type="number" min={0} value={tokenBudget} onChange={(event) => setTokenBudget(Number(event.target.value))} disabled={autoModeLocked} />
        </div>
      </div>

      <div className="auto-mode-controls">
        {autoModeStatus === 'idle' || autoModeStatus === 'stopped' ? (
          <button className="btn btn-primary" onClick={handleStart} disabled={!prompterRef || !responderRef}>
            {t('autoMode.start')}
          </button>
        ) : autoModeStatus === 'running' ? (
          <>
            <button className="btn btn-secondary" onClick={handlePause}>{t('autoMode.pause')}</button>
            <button className="btn btn-secondary" onClick={handleStop} style={{ color: 'var(--color-error)' }}>{t('autoMode.stop')}</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={handleResume}>{t('autoMode.resume')}</button>
            <button className="btn btn-secondary" onClick={handleStop} style={{ color: 'var(--color-error)' }}>{t('autoMode.stop')}</button>
          </>
        )}
      </div>

      {(phase !== 'idle' || autoModeIteration > 0) && (
        <div className="auto-mode-status">
          <span>{visibleMaxIterations === 0 ? `Iteratie ${autoModeIteration} / ∞` : t('autoMode.iteration', { current: autoModeIteration, max: visibleMaxIterations })}</span>
          <span>-</span>
          <span>{t('autoMode.totalTokens', { count: autoModeTotalTokens.toLocaleString() })}</span>
        </div>
      )}
    </div>
  );
};

function RoleModelPicker({
  label,
  help,
  models,
  value,
  onChange,
  disabled,
  chatgptVersions,
}: {
  label: string;
  help: string;
  models: AIModel[];
  value: ModelRef | null;
  onChange: (value: ModelRef) => void;
  disabled: boolean;
  chatgptVersions: ChatgptVersion[];
}) {
  const selectedModel = value ? autoModeModelByKey(models, `${value.provider}:${value.modelId}`) : models[0];
  const selectedSurface = selectedModel ? surfaceLabel(selectedModel) : '';
  const surfaceModels = autoModeModelsForSurface(models, selectedSurface);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  const serviceTiers = selectedModel?.supportedServiceTiers || [];
  const chatgptEfforts = chatgptEffortsForModel(selectedModel);

  const changeModel = (model?: AIModel) => {
    if (!model) return;
    const next = autoModeModelRef(model, value);
    if (model.provider === 'openai' && model.id.startsWith('chatgpt:') && chatgptVersions.length) {
      onChange(normalizeAutoModeChatgptRef(chatgptVersions, models, next) || next);
      return;
    }
    onChange(next);
  };

  return (
    <div className="auto-mode-role-picker">
      <div className="auto-mode-role-heading">
        <div className="field-label">{label}</div>
        <div className="auto-mode-role-help">{help}</div>
      </div>
      <div className="auto-mode-role-fields">
        <SelectField
          label="Provider"
          value={selectedSurface}
          options={autoModeSurfaces(models).map((surface) => ({ value: surface, label: surface }))}
          onChange={(surface) => changeModel(autoModeModelsForSurface(models, surface)[0])}
          disabled={disabled}
          placeholder="Geen providers gevonden"
        />
        <RoleModelFields
          models={surfaceModels}
          selectedModel={selectedModel}
          selectedRef={value}
          chatgptVersions={chatgptVersions}
          disabled={disabled}
          onModelChange={changeModel}
          onRefChange={onChange}
        />
        {efforts.length > 0 && value && (
          <SelectField
            label="Inspanning"
            value={value.runConfig?.reasoningEffort || selectedModel?.defaultReasoningEffort || ''}
            options={efforts.map((effort) => ({ value: effort, label: reasoningEffortLabel(effort) }))}
            onChange={(effort) => onChange(withAutoModeReasoningEffort(value, effort))}
            disabled={disabled}
          />
        )}
        {chatgptEfforts.length > 0
          && value
          && !(selectedModel?.provider === 'openai' && selectedModel.id.startsWith('chatgpt:') && chatgptVersions.length > 0)
          && (
          <SelectField
            label="Intelligentie"
            value={value.runConfig?.chatgptThinkingEffort || ''}
            options={chatgptEfforts}
            onChange={(effort) => onChange(withAutoModeChatgptEffort(value, effort))}
            disabled={disabled}
          />
        )}
        {serviceTiers.length > 0 && value && (
          <SelectField
            label="Snelheid"
            value={value.runConfig?.serviceTier || ''}
            options={serviceTiers.map((tier) => ({ value: tier, label: serviceTierLabel(tier) }))}
            onChange={(tier) => onChange(withAutoModeServiceTier(value, tier))}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}

function RoleModelFields({
  models,
  selectedModel,
  selectedRef,
  chatgptVersions,
  disabled,
  onModelChange,
  onRefChange,
}: {
  models: AIModel[];
  selectedModel?: AIModel;
  selectedRef: ModelRef | null;
  chatgptVersions: ChatgptVersion[];
  disabled: boolean;
  onModelChange: (model?: AIModel) => void;
  onRefChange: (ref: ModelRef) => void;
}) {
  if (!selectedModel) {
    return (
      <SelectField value="" options={[]} onChange={() => {}} label="Model" placeholder="Geen modellen gevonden" disabled />
    );
  }

  if (selectedModel.provider === 'codex') {
    const selected = parseCodexModel(selectedModel);
    const versions = [...new Set(models.map((model) => parseCodexModel(model).version))];
    const variants = models.filter((model) => parseCodexModel(model).version === selected.version);
    return (
      <>
        <SelectField
          label="Model"
          value={selected.version}
          options={versions.map((version) => ({ value: version, label: version }))}
          onChange={(version) => onModelChange(models.find((model) => parseCodexModel(model).version === version))}
          disabled={disabled}
        />
        {variants.length > 1 && (
          <SelectField
            label="Variant"
            value={autoModeModelKey(selectedModel)}
            options={variants.map((model) => ({ value: autoModeModelKey(model), label: parseCodexModel(model).variant }))}
            onChange={(key) => onModelChange(autoModeModelByKey(models, key))}
            disabled={disabled}
          />
        )}
      </>
    );
  }

  if (selectedModel.provider === 'anthropic' && selectedModel.id.startsWith('claude-cli:')) {
    const selected = parseClaudeCliModel(selectedModel);
    const families = claudeCliFamilies(models);
    const versions = claudeCliVersionsFor(models, selected.family);
    return (
      <>
        <SelectField
          label="Familie"
          value={selected.family}
          options={families.map((family) => ({ value: family, label: family }))}
          onChange={(family) => onModelChange(claudeCliModelFor(models, family, claudeCliVersionsFor(models, family)[0]))}
          disabled={disabled}
        />
        <SelectField
          label="Versie"
          value={selected.version}
          options={versions.map((version) => ({ value: version, label: version }))}
          onChange={(version) => onModelChange(claudeCliModelFor(models, selected.family, version))}
          disabled={disabled}
        />
      </>
    );
  }

  if (selectedModel.provider === 'google') {
    const selected = parseGoogleModelChoice(selectedModel);
    const families = [...new Set(models.map((model) => parseGoogleModelChoice(model).family))];
    const familyModels = models.filter((model) => parseGoogleModelChoice(model).family === selected.family);
    const versions = [...new Set(familyModels.map((model) => parseGoogleModelChoice(model).version))];
    const variants = familyModels.filter((model) => parseGoogleModelChoice(model).version === selected.version);
    return (
      <>
        <SelectField
          label="Familie"
          value={selected.family}
          options={families.map((family) => ({ value: family, label: family }))}
          onChange={(family) => onModelChange(models.find((model) => parseGoogleModelChoice(model).family === family))}
          disabled={disabled}
        />
        {versions.length > 1 && (
          <SelectField
            label="Versie"
            value={selected.version}
            options={versions.map((version) => ({ value: version, label: version }))}
            onChange={(version) => onModelChange(familyModels.find((model) => parseGoogleModelChoice(model).version === version))}
            disabled={disabled}
          />
        )}
        {variants.length > 1 && (
          <SelectField
            label="Variant"
            value={autoModeModelKey(selectedModel)}
            options={variants.map((model) => ({ value: autoModeModelKey(model), label: parseGoogleModelChoice(model).variant }))}
            onChange={(key) => onModelChange(autoModeModelByKey(models, key))}
            disabled={disabled}
          />
        )}
      </>
    );
  }

  if (selectedModel.provider === 'antigravity') {
    const selected = parseAntigravityModel(selectedModel);
    const providers = antigravityProviders(models);
    const modelNames = antigravityModelNamesFor(models, selected.provider);
    const modes = antigravityModesFor(models, selected.provider, selected.model);
    return (
      <>
        {providers.length > 1 && (
          <SelectField
            label="Familie"
            value={selected.provider}
            options={providers.map((provider) => ({ value: provider, label: provider }))}
            onChange={(provider) => {
              const name = antigravityModelNamesFor(models, provider)[0];
              onModelChange(antigravityModelFor(models, provider, name, antigravityModesFor(models, provider, name)[0]));
            }}
            disabled={disabled}
          />
        )}
        <SelectField
          label="Model"
          value={selected.model}
          options={modelNames.map((model) => ({ value: model, label: model }))}
          onChange={(model) => onModelChange(antigravityModelFor(models, selected.provider, model, antigravityModesFor(models, selected.provider, model)[0]))}
          disabled={disabled}
        />
        {modes.length > 1 && (
          <SelectField
            label="Modus"
            value={selected.mode}
            options={modes.map((mode) => ({ value: mode, label: mode }))}
            onChange={(mode) => onModelChange(antigravityModelFor(models, selected.provider, selected.model, mode))}
            disabled={disabled}
          />
        )}
      </>
    );
  }

  if (selectedModel.provider === 'openai' && selectedModel.id.startsWith('chatgpt:') && chatgptVersions.length) {
    const visibleVersions = availableAutoModeChatgptVersions(chatgptVersions, models);
    const selectedChoice = autoModeChatgptChoiceForRef(chatgptVersions, models, selectedRef);
    const selectedVersion = selectedChoice?.version || visibleVersions[0];
    const availablePresets = selectedVersion
      ? availableAutoModeChatgptPresets(selectedVersion, models)
      : [];
    return (
      <>
        <SelectField
          label="Model"
          value={selectedVersion?.id || ''}
          options={visibleVersions.map((version) => ({ value: version.id, label: version.title }))}
          onChange={(versionId) => {
            const version = visibleVersions.find((candidate) => candidate.id === versionId);
            if (!version) return;
            const choice = autoModeChatgptChoiceForVersion(
              version,
              models,
              selectedChoice?.preset?.title,
            );
            if (choice) onRefChange(autoModeChatgptRefForChoice(choice, selectedRef));
          }}
          disabled={disabled}
        />
        {availablePresets.length > 0 && (
          <SelectField
            label="Intelligentie"
            value={selectedChoice?.preset
              ? `${selectedChoice.preset.modelSlug}|${selectedChoice.preset.thinkingEffort || ''}`
              : ''}
            options={availablePresets.map((preset) => ({
              value: `${preset.modelSlug}|${preset.thinkingEffort || ''}`,
              label: preset.subtitle ? `${preset.title} · ${preset.subtitle}` : preset.title,
            }))}
            onChange={(choice) => {
              const [modelSlug, effort] = choice.split('|');
              const preset = availablePresets.find((candidate) =>
                candidate.modelSlug === modelSlug
                && (candidate.thinkingEffort || '') === (effort || ''));
              const model = models.find((candidate) => candidate.id === `chatgpt:${modelSlug}`);
              if (preset && model && selectedVersion) {
                onRefChange(autoModeChatgptRefForChoice(
                  { version: selectedVersion, model, preset },
                  selectedRef,
                ));
              }
            }}
            disabled={disabled}
          />
        )}
      </>
    );
  }

  return (
    <SelectField
      label="Model"
      value={autoModeModelKey(selectedModel)}
      options={models.map((model) => ({
        value: autoModeModelKey(model),
        label: compactModelChoiceLabel(model, chatgptVersions),
      }))}
      onChange={(key) => onModelChange(autoModeModelByKey(models, key))}
      disabled={disabled}
      placeholder="Geen modellen gevonden"
    />
  );
}

export default AutoModePanel;
