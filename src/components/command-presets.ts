import { Brain, Gauge, Goal, ListChecks, RotateCcw, SearchCheck, Wrench, type LucideIcon } from 'lucide-react';
import type { AIModel, ModelRunConfig, NativeProviderCommand, ProviderType, ReasoningEffort, ServiceTier } from '../providers/types';

export type LlmeltCommandPresetId = 'plan' | 'goal' | 'fast' | 'deep' | 'review' | 'reset';
export type CommandPresetId = string;
export type CommandLanguage = 'nl' | 'en';

export type CommandPreset = {
  id: CommandPresetId;
  slash: string;
  aliases: string[];
  label: string;
  description: string;
  icon: LucideIcon;
  source: 'llmelt-workflow' | 'provider-native';
  nativeCommand?: NativeProviderCommand;
  apply: (context: CommandApplyContext) => ModelRunConfig | undefined;
};

type CommandApplyContext = {
  provider: ProviderType;
  model?: AIModel;
  runConfig?: ModelRunConfig;
  args?: string;
};

export type ParsedCommand = {
  preset: CommandPreset;
  args: string;
  rest: string;
};

export type NativeRunControls = {
  reasoningEfforts: ReasoningEffort[];
  serviceTiers: ServiceTier[];
  chatgptThinkingEfforts: { value: string; label: string; description?: string }[];
};

type LocalizedCommandCopy = Record<LlmeltCommandPresetId, {
  slash: string;
  aliases?: string[];
  label: string;
  description: string;
}>;

const COMMAND_COPY: Record<CommandLanguage, LocalizedCommandCopy> = {
  nl: {
    plan: {
      slash: '/plan',
      label: 'Plan mode',
      description: 'Maak eerst een plan; dit is een app-workflow en voert niets automatisch uit.',
    },
    goal: {
      slash: '/goal',
      label: 'Goal',
      description: 'Bewaar een zichtbaar doel voor de volgende antwoorden in deze chat.',
    },
    fast: {
      slash: '/fast',
      label: 'Fast',
      description: 'Gebruik de snelste instelling die dit model live beschikbaar stelt.',
    },
    deep: {
      slash: '/deep',
      label: 'Deep',
      description: 'Gebruik de hoogste inspanning die dit model live beschikbaar stelt.',
    },
    review: {
      slash: '/review',
      label: 'Review',
      description: 'App-workflow die eerst bugs, risico\'s en ontbrekende tests laat beoordelen.',
    },
    reset: {
      slash: '/reset',
      label: 'Reset',
      description: 'Verwijder de actieve workflow en herstel modelstandaarden van een fast/deep-preset.',
    },
  },
  en: {
    plan: {
      slash: '/plan',
      label: 'Plan mode',
      description: 'Create a plan first; this is an app workflow and performs no automatic mutations.',
    },
    goal: {
      slash: '/goal',
      label: 'Goal',
      description: 'Keep a visible goal active for the next responses in this chat.',
    },
    fast: {
      slash: '/fast',
      label: 'Fast',
      description: 'Use the fastest setting advertised live by this model.',
    },
    deep: {
      slash: '/deep',
      label: 'Deep',
      description: 'Use the highest effort advertised live by this model.',
    },
    review: {
      slash: '/review',
      label: 'Review',
      description: 'App workflow that checks bugs, risks, and missing tests first.',
    },
    reset: {
      slash: '/reset',
      label: 'Reset',
      description: 'Clear the active workflow and restore model defaults after a fast/deep preset.',
    },
  },
};

const ICONS: Record<LlmeltCommandPresetId, LucideIcon> = {
  plan: ListChecks,
  goal: Goal,
  fast: Gauge,
  deep: Brain,
  review: SearchCheck,
  reset: RotateCcw,
};

export function commandLanguage(value?: string): CommandLanguage {
  return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'nl';
}

/**
 * Alleen providerdata op het actuele model bepaalt welke native controls bestaan.
 * Provider- of modelnamen worden hier bewust niet geïnterpreteerd.
 */
export function nativeRunControls(model?: AIModel): NativeRunControls {
  return {
    reasoningEfforts: unique(model?.supportedReasoningEfforts || []),
    serviceTiers: unique(model?.supportedServiceTiers || []),
    chatgptThinkingEfforts: uniqueBy(
      model?.chatgptConfigurableEffort ? model.chatgptThinkingEfforts || [] : [],
      (effort) => effort.value,
    ),
  };
}

/**
 * Het tandwiel hoort alleen te bestaan wanneer de actieve provider voor dit
 * exacte model daadwerkelijk een keuze publiceert. Eén vaste waarde is geen
 * instelling en app-workflows tellen hier bewust niet mee.
 */
export function hasSelectableNativeRunControls(model?: AIModel): boolean {
  const controls = nativeRunControls(model);
  return controls.reasoningEfforts.length > 1
    || controls.serviceTiers.length > 0
    || controls.chatgptThinkingEfforts.length > 1;
}

/** De pending slashkeuze gaat voor op de reeds actieve workflow in de composer. */
export function composerCommandPreset(
  presets: CommandPreset[],
  activeId?: string,
  pendingId?: CommandPresetId | null,
): CommandPreset | undefined {
  const id = pendingId || activeId;
  return id ? presets.find((preset) => preset.id === id) : undefined;
}

export function commandPresetsForModel(
  language: CommandLanguage,
  provider: ProviderType,
  model?: AIModel,
  nativeCommands: NativeProviderCommand[] = [],
): CommandPreset[] {
  const controls = nativeRunControls(model);
  const hasFast = controls.reasoningEfforts.length > 1
    || controls.serviceTiers.length > 0
    || controls.chatgptThinkingEfforts.length > 1;
  const hasDeep = controls.reasoningEfforts.length > 1
    || controls.chatgptThinkingEfforts.length > 1;
  const hasNativePlan = nativeCommands.some((command) => command.kind === 'collaboration-mode' && command.mode === 'plan');
  const hasNativeGoal = nativeCommands.some((command) => command.kind === 'goal');
  const hasNativeReview = nativeCommands.some((command) => command.kind === 'review');

  // Providerneutrale LLMelt-workflows blijven beschikbaar wanneer de provider
  // geen gelijkwaardige native actie publiceert. Fast/deep verschijnen alleen
  // wanneer het actuele model daarvoor echte live controls heeft.
  return (Object.keys(COMMAND_COPY[language]) as LlmeltCommandPresetId[])
    .filter((id) => id !== 'plan' || !hasNativePlan)
    .filter((id) => id !== 'goal' || !hasNativeGoal)
    .filter((id) => id !== 'review' || !hasNativeReview)
    .filter((id) => id !== 'fast' || hasFast)
    .filter((id) => id !== 'deep' || hasDeep)
    .filter((id) => id !== 'reset' || hasFast || hasDeep)
    .map((id) => {
      const copy = COMMAND_COPY[language][id];
      return {
        id,
        slash: copy.slash,
        aliases: unique([copy.slash, ...(copy.aliases || [])]).map((slash) => slash.toLowerCase()),
        label: copy.label,
        description: copy.description,
        icon: ICONS[id],
        source: 'llmelt-workflow' as const,
        apply: (context: CommandApplyContext) => applyPreset(id, language, context),
      };
    });
}

export function nativeCommandPresets(commands: NativeProviderCommand[]): CommandPreset[] {
  return commands.map((command) => ({
    id: command.id,
    slash: command.slash,
    aliases: unique([command.slash, ...(command.aliases || [])]).map((slash) => slash.toLowerCase()),
    label: command.kind === 'goal'
      ? 'Goal'
      : command.kind === 'review'
        ? 'Review'
        : command.label,
    description: command.description,
    icon: command.kind === 'goal' ? Goal
      : command.kind === 'review' ? SearchCheck
        : command.kind === 'collaboration-mode' ? ListChecks
          : Wrench,
    source: 'provider-native',
    nativeCommand: command,
    apply: ({ runConfig, args }) => {
      if (command.kind === 'goal') return runConfig;
      return compactConfig({
        ...(runConfig || {}),
        commandPresetId: command.id,
        nativeProviderCommand: {
          id: command.id,
          kind: command.kind,
          args: String(args || '').trim() || undefined,
          mode: command.mode,
          model: command.model,
          reasoningEffort: command.reasoningEffort,
          name: command.name,
          path: command.path,
        },
      });
    },
  }));
}

export function parseCommandInput(value: string, presets: CommandPreset[]): ParsedCommand | null {
  const input = value.trimStart();
  if (!input.startsWith('/')) return null;
  const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const slash = (match?.[1] || '').toLowerCase();
  const preset = presets.find((candidate) => candidate.aliases.includes(slash));
  if (!preset) return null;
  const rest = match?.[2] || '';
  return { preset, args: rest, rest };
}

/**
 * De slash kiest alleen een actie; hij is nooit onderdeel van het bericht aan
 * het model. Daardoor gedragen native acties en LLMelt-workflows zich gelijk.
 */
export function commandMessageText(command: ParsedCommand): string {
  return command.rest.trim();
}

/** De commandopener zoekt zowel de zichtbare slashnaam als vertaalde aliases. */
export function commandPresetMatchesQuery(preset: CommandPreset, query: string): boolean {
  const normalized = query.trim().replace(/^\//, '').toLowerCase();
  if (normalized.includes(' ')) return false;
  return preset.aliases.some((alias) => alias.replace(/^\//, '').includes(normalized))
    || preset.label.toLowerCase().includes(normalized);
}

export function applyCommandPreset(
  preset: CommandPreset,
  provider: ProviderType,
  model: AIModel | undefined,
  runConfig: ModelRunConfig | undefined,
  args = '',
) {
  return preset.apply({ provider, model, runConfig, args });
}

export function clearCommandConfig(runConfig?: ModelRunConfig, model?: AIModel): ModelRunConfig | undefined {
  if (!runConfig) return model?.runConfig;
  const { commandPresetId, commandGoal, commandInstruction, nativeProviderCommand, ...rest } = runConfig;

  // Snel/diep wijzigen echte modelcontrols. Reset herstelt daarvoor de live
  // modelstandaard; app-workflows mogen handmatig gekozen modelcontrols niet wissen.
  if (commandPresetId === 'fast' || commandPresetId === 'deep') {
    delete rest.reasoningEffort;
    delete rest.serviceTier;
    delete rest.chatgptThinkingEffort;
    return compactConfig({ ...rest, ...(model?.runConfig || {}) });
  }
  return compactConfig(rest);
}

export function commandLabel(id: string | undefined, language: CommandLanguage) {
  return id && COMMAND_COPY[language][id as LlmeltCommandPresetId]?.label || id || '';
}

function applyPreset(id: LlmeltCommandPresetId, language: CommandLanguage, context: CommandApplyContext) {
  const clean = clearCommandFields(context.runConfig);
  if (id === 'reset') return clearCommandConfig(context.runConfig, context.model);

  if (id === 'goal') {
    const goal = (context.args || '').trim();
    if (!goal) return context.runConfig;
    return withCommand(clean, id, {
      commandGoal: goal,
      commandInstruction: language === 'en'
        ? `Keep this goal active for your response: ${goal}`
        : `Houd dit doel actief voor je antwoord: ${goal}`,
    });
  }

  if (id === 'plan') {
    return withCommand(clean, id, {
      commandInstruction: language === 'en'
        ? 'Work in plan mode. Create a concrete plan, ask only for missing product choices, and perform no mutating actions unless the user explicitly asks for implementation afterward.'
        : 'Werk in planmodus. Maak een concreet plan, vraag alleen om ontbrekende productkeuzes en voer geen muterende acties uit tenzij de gebruiker daarna expliciet om implementatie vraagt.',
    });
  }

  if (id === 'review') {
    return withCommand(clean, id, {
      commandInstruction: language === 'en'
        ? 'Adopt a code-review posture. Start with concrete bugs, regression risks, and missing tests, including file or function references where possible. Keep the summary secondary.'
        : 'Neem een code-reviewhouding aan. Begin met concrete bugs, regressierisico\'s en ontbrekende tests, met bestands- of functiereferenties waar mogelijk. Houd de samenvatting secundair.',
    });
  }

  const controls = nativeRunControls(context.model);
  if (id === 'fast') {
    const next: ModelRunConfig = { ...clean };
    if (controls.reasoningEfforts.length > 1) {
      next.reasoningEffort = controls.reasoningEfforts[0];
    }
    if (controls.serviceTiers.length > 0) {
      // Gebruik de laatst geadverteerde extra snelheid; interpreteer geen
      // tiernaam in de app. Standaardsnelheid is de lege configuratie.
      next.serviceTier = controls.serviceTiers[controls.serviceTiers.length - 1];
    }
    if (controls.chatgptThinkingEfforts.length > 1) {
      next.chatgptThinkingEffort = controls.chatgptThinkingEfforts[0].value;
    }
    return withCommand(next, id, {});
  }

  const next: ModelRunConfig = { ...clean };
  if (controls.reasoningEfforts.length > 1) {
    next.reasoningEffort = controls.reasoningEfforts[controls.reasoningEfforts.length - 1];
  }
  if (controls.chatgptThinkingEfforts.length > 1) {
    next.chatgptThinkingEffort = controls.chatgptThinkingEfforts[controls.chatgptThinkingEfforts.length - 1].value;
  }
  return withCommand(next, id, {});
}

function clearCommandFields(runConfig?: ModelRunConfig): ModelRunConfig {
  const { commandPresetId: _id, commandGoal: _goal, commandInstruction: _instruction, ...rest } = runConfig || {};
  return rest;
}

function withCommand(runConfig: ModelRunConfig, id: LlmeltCommandPresetId, values: Partial<ModelRunConfig>) {
  return compactConfig({ ...runConfig, commandPresetId: id, ...values });
}

function compactConfig(runConfig: ModelRunConfig): ModelRunConfig | undefined {
  return Object.keys(runConfig).length ? runConfig : undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
