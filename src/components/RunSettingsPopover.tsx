import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, Loader2, SlidersHorizontal, Sparkles, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AIModel, ProviderType } from '../providers/types';
import type { CommandPreset } from './command-presets';
import type { RunSettingsModelChoice } from './run-settings-utils';
import { ProviderBadge, QuotaBadge, SelectField, type SelectOption } from './ui';

type RunSettingsPopoverProps = {
  phase: string;
  provider: ProviderType;
  activeModel?: AIModel;
  modelChoices: RunSettingsModelChoice[];
  activeModelChoiceKey: string;
  effortValue: string;
  effortOptions: SelectOption[];
  speedValue: string;
  speedOptions: SelectOption[];
  providerActions: CommandPreset[];
  llmeltWorkflows: CommandPreset[];
  runProfiles: CommandPreset[];
  activePresetId?: string;
  loading: boolean;
  onModelChange: (key: string) => void;
  onEffortChange: (value: string) => void;
  onSpeedChange: (value: string) => void;
  onProfile: (preset: CommandPreset) => void;
  onPreset: (preset: CommandPreset) => void;
};

const PROFILE_ORDER = ['reset', 'fast', 'deep'];

type SliderChoice = {
  key: string;
  label: string;
};

export default function RunSettingsPopover({
  phase,
  provider,
  activeModel,
  modelChoices,
  activeModelChoiceKey,
  effortValue,
  effortOptions,
  speedValue,
  speedOptions,
  providerActions,
  llmeltWorkflows,
  runProfiles,
  activePresetId,
  loading,
  onModelChange,
  onEffortChange,
  onSpeedChange,
  onProfile,
  onPreset,
}: RunSettingsPopoverProps) {
  const { t } = useTranslation();
  const orderedProfiles = useMemo(
    () => [...runProfiles].sort((a, b) => PROFILE_ORDER.indexOf(a.id) - PROFILE_ORDER.indexOf(b.id)),
    [runProfiles],
  );
  const selectedIndex = Math.max(0, modelChoices.findIndex((choice) => choice.key === activeModelChoiceKey));
  const selectedChoice = modelChoices[selectedIndex] || modelChoices[0];
  const effectiveActiveModelKey = selectedChoice?.key || activeModelChoiceKey;
  const hasAdvancedControls = modelChoices.length > 1 || effortOptions.length > 1 || speedOptions.length > 1;
  const profileActiveId = activePresetId === 'fast' || activePresetId === 'deep' ? activePresetId : 'reset';
  // De snelle schaal volgt de provider-UI: het gekozen model blijft staan en
  // de schaal verandert de live gepubliceerde effort. Alleen providers zonder
  // effortmogelijkheden vallen terug op hun live modellenlijst.
  const sliderUsesEffort = effortOptions.filter((option) => !option.disabled).length > 1;
  const sliderChoices: SliderChoice[] = sliderUsesEffort
    ? effortOptions.filter((option) => !option.disabled).map((option) => ({ key: option.value, label: option.label }))
    : modelChoices.map((choice) => ({ key: choice.key, label: choice.label }));
  const quickSpeedOptions = speedOptions.filter((option) => !option.disabled);
  const sliderValue = sliderUsesEffort ? effortValue : effectiveActiveModelKey;
  const hasQuickControls = sliderChoices.length > 1 || quickSpeedOptions.length > 1;
  const [activeView, setActiveView] = useState<'quick' | 'advanced'>(hasQuickControls ? 'quick' : 'advanced');
  const showViewSwitch = hasQuickControls && hasAdvancedControls;

  return (
    <div className={`run-settings-popover motion-panel dismissible-popover ${phase}`}>
      <div className="run-settings-header">
        <ProviderBadge provider={provider} label={t('runSettings.title')} />
        {activeModel && <QuotaBadge model={activeModel} />}
      </div>

      {showViewSwitch && (
        <div className="run-settings-view-switch" role="tablist" aria-label={t('runSettings.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'quick'}
            className={activeView === 'quick' ? 'active' : ''}
            onClick={() => setActiveView('quick')}
          >
            <Sparkles size={14} />
            {t('runSettings.quick')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'advanced'}
            className={activeView === 'advanced' ? 'active' : ''}
            onClick={() => setActiveView('advanced')}
          >
            <SlidersHorizontal size={14} />
            {t('runSettings.advanced')}
          </button>
        </div>
      )}

      {activeView === 'quick' && hasQuickControls && (
        <div className="run-settings-view-panel quick">
          {sliderChoices.length > 1 && (
            <DragSlider
              label={sliderUsesEffort ? t('runSettings.effort') : t('runSettings.model')}
              choices={sliderChoices}
              value={sliderValue}
              startLabel={sliderUsesEffort ? t('runSettings.faster') : undefined}
              endLabel={sliderUsesEffort ? t('runSettings.smarter') : undefined}
              modelLabel={sliderUsesEffort ? selectedChoice?.label : undefined}
              onChange={sliderUsesEffort ? onEffortChange : onModelChange}
            />
          )}
          {quickSpeedOptions.length > 1 && (
            <div className="run-settings-speed-control">
              <div className="run-settings-speed-label">
                <Zap size={14} />
                <span>{t('runSettings.speed')}</span>
              </div>
              <div className="run-settings-speed-options" role="group" aria-label={t('runSettings.speed')}>
                {quickSpeedOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={option.value === speedValue ? 'active' : ''}
                    onClick={() => onSpeedChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeView === 'advanced' && hasAdvancedControls && (
        <div className="run-settings-view-panel advanced">
          <div className="run-settings-advanced-fields">
            {modelChoices.length > 1 && (
              <SelectField
                label={t('runSettings.model')}
                value={effectiveActiveModelKey}
                onChange={onModelChange}
                options={modelChoices.map((choice) => ({ value: choice.key, label: choice.label }))}
              />
            )}
            {effortOptions.length > 1 && (
              <SelectField
                label={t('runSettings.effort')}
                value={effortValue}
                onChange={onEffortChange}
                options={effortOptions}
              />
            )}
            {speedOptions.length > 1 && (
              <SelectField
                label={t('runSettings.speed')}
                value={speedValue}
                onChange={onSpeedChange}
                options={speedOptions}
              />
            )}
          </div>
        </div>
      )}

      {(orderedProfiles.length > 1 || llmeltWorkflows.length > 0) && (
        <WorkflowSection
          label={t('runSettings.appWorkflows')}
          profiles={orderedProfiles}
          workflows={llmeltWorkflows}
          activeProfileId={profileActiveId}
          normalLabel={t('runSettings.normal')}
          onProfile={onProfile}
          onPreset={onPreset}
        />
      )}
      {providerActions.length > 0 && (
        <ActionSection label={t('runSettings.providerNativeActions')} presets={providerActions} onPreset={onPreset} />
      )}
      {loading && (
        <div className="run-settings-native-loading"><Loader2 size={13} /> {t('models.refreshing')}</div>
      )}
    </div>
  );
}

function DragSlider({
  label,
  choices,
  value,
  startLabel,
  endLabel,
  modelLabel,
  onChange,
}: {
  label: string;
  choices: SliderChoice[];
  value: string;
  startLabel?: string;
  endLabel?: string;
  modelLabel?: string;
  onChange: (value: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; index: number } | null>(null);
  const pendingValueRef = useRef<string | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const activeIndex = Math.max(0, choices.findIndex((choice) => choice.key === value));
  const committedRatio = choices.length > 1 ? activeIndex / (choices.length - 1) : 0;
  const displayRatio = dragRatio ?? committedRatio;
  const displayIndex = dragRatio === null
    ? activeIndex
    : Math.round(dragRatio * (choices.length - 1));

  useEffect(() => {
    // Een catalogusrefresh tijdens het slepen mag geen verouderde dragstatus
    // achterlaten. De daadwerkelijke providerwissel gebeurt pas bij loslaten.
    dragRef.current = null;
    pendingValueRef.current = null;
    setDragRatio(null);
  }, [choices.length]);

  useEffect(() => {
    if (pendingValueRef.current !== value) return;
    pendingValueRef.current = null;
    setDragRatio(null);
  }, [value]);

  const ratioAt = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const inset = 15;
    const usableWidth = Math.max(1, rect.width - inset * 2);
    return Math.min(1, Math.max(0, (clientX - rect.left - inset) / usableWidth));
  }, []);

  const previewAt = useCallback((clientX: number) => {
    const ratio = ratioAt(clientX);
    if (ratio === null) return;
    const index = Math.round(ratio * (choices.length - 1));
    if (dragRef.current) dragRef.current.index = index;
    setDragRatio(ratio);
  }, [choices.length, ratioAt]);

  const finishDrag = useCallback((pointerId: number, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    if (trackRef.current?.hasPointerCapture(pointerId)) {
      trackRef.current.releasePointerCapture(pointerId);
    }
    if (cancelled) {
      setDragRatio(null);
      return;
    }
    const choice = choices[drag.index];
    if (!choice || choice.key === value) {
      setDragRatio(null);
      return;
    }
    // Houd de bol op de gekozen stap totdat de bovenliggende providerstate de
    // keuze bevestigt. Zo springt hij bij mouse-up niet één frame terug.
    setDragRatio(drag.index / Math.max(1, choices.length - 1));
    pendingValueRef.current = choice.key;
    onChange(choice.key);
  }, [choices, onChange, value]);

  const moveSelection = (index: number) => {
    const choice = choices[Math.min(choices.length - 1, Math.max(0, index))];
    if (choice && choice.key !== value) onChange(choice.key);
  };

  return (
    <div className="run-settings-model-slider">
      <div className="run-settings-slider-heading">
        <span>{label}</span>
        <strong title={choices[displayIndex]?.label}>{choices[displayIndex]?.label}</strong>
      </div>
      {(startLabel || endLabel) && (
        <div className="run-settings-slider-scale-labels" aria-hidden="true">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      )}
      <div
        ref={trackRef}
        className={`run-settings-slider ${choices.length > 8 ? 'dense' : ''} ${dragRatio !== null ? 'dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={choices.length - 1}
        aria-valuenow={displayIndex}
        aria-valuetext={choices[displayIndex]?.label}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const ratio = ratioAt(event.clientX);
          if (ratio === null) return;
          event.preventDefault();
          dragRef.current = {
            pointerId: event.pointerId,
            index: Math.round(ratio * (choices.length - 1)),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragRatio(ratio);
        }}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) previewAt(event.clientX);
        }}
        onPointerUp={(event) => finishDrag(event.pointerId)}
        onPointerCancel={(event) => finishDrag(event.pointerId, true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            moveSelection(activeIndex - 1);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveSelection(activeIndex + 1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            moveSelection(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            moveSelection(choices.length - 1);
          }
        }}
      >
        <span className="run-settings-slider-rail" aria-hidden="true">
          <span className="run-settings-slider-fill" style={{ width: `${displayRatio * 100}%` }} />
        </span>
        {choices.map((choice) => (
          <span
            key={choice.key}
            className={`run-settings-slider-point ${choice.key === choices[displayIndex]?.key ? 'preview' : ''}`}
            title={choice.label}
            aria-hidden="true"
          >
            <span />
          </span>
        ))}
        <span
          className="run-settings-slider-thumb"
          style={{ left: `calc(15px + ${displayRatio * 100}% - ${displayRatio * 30}px)` }}
          aria-hidden="true"
        />
      </div>
      {modelLabel && (
        <div className="run-settings-slider-model-summary">
          <strong>{modelLabel}</strong>
          <span>{choices[displayIndex]?.label}</span>
        </div>
      )}
    </div>
  );
}

function WorkflowSection({
  label,
  profiles,
  workflows,
  activeProfileId,
  normalLabel,
  onProfile,
  onPreset,
}: {
  label: string;
  profiles: CommandPreset[];
  workflows: CommandPreset[];
  activeProfileId: string;
  normalLabel: string;
  onProfile: (preset: CommandPreset) => void;
  onPreset: (preset: CommandPreset) => void;
}) {
  return (
    <div className="run-settings-native-actions run-settings-llmelt-workflows">
      <div className="run-settings-section-label">{label}</div>
      {profiles.length > 1 && (
        <div className="run-settings-profile" role="group" aria-label={label}>
          {profiles.map((preset) => {
            const Icon = preset.id === 'reset' ? Gauge : preset.icon;
            return (
              <button
                key={preset.id}
                type="button"
                className={activeProfileId === preset.id ? 'active' : ''}
                title={preset.description}
                onClick={() => onProfile(preset)}
              >
                <Icon size={14} />
                <span>{preset.id === 'reset' ? normalLabel : preset.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {workflows.length > 0 && (
        <div className="run-settings-native-grid run-settings-workflow-grid">
          {workflows.map((preset) => {
            const Icon = preset.icon;
            return (
              <button
                key={preset.id}
                type="button"
                className="run-settings-native-action"
                title={preset.description}
                onClick={() => onPreset(preset)}
              >
                <Icon size={15} />
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionSection({
  label,
  presets,
  onPreset,
}: {
  label: string;
  presets: CommandPreset[];
  onPreset: (preset: CommandPreset) => void;
}) {
  return (
    <div className="run-settings-native-actions">
      <div className="run-settings-section-label">{label}</div>
      <div className="run-settings-native-grid">
        {presets.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.id}
              type="button"
              className="run-settings-native-action"
              title={preset.description}
              onClick={() => onPreset(preset)}
            >
              <Icon size={15} />
              <span>{preset.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
