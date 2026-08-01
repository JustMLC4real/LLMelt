import { Brain, Gauge, Goal, ListChecks, RotateCcw, SearchCheck, type LucideIcon } from 'lucide-react';
import type { AIModel, ModelRunConfig, ProviderType, ReasoningEffort } from '../providers/types';

export type CommandPresetId = 'plan' | 'goal' | 'fast' | 'deep' | 'review' | 'reset';

export type CommandPreset = {
  id: CommandPresetId;
  slash: string;
  label: string;
  description: string;
  icon: LucideIcon;
  providers: 'all' | ProviderType[];
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

export const COMMAND_PRESETS: CommandPreset[] = [
  {
    id: 'plan',
    slash: '/planmodus',
    label: 'Planmodus',
    description: 'Maak eerst een helder plan en voer niets automatisch uit.',
    icon: ListChecks,
    providers: 'all',
    apply: ({ runConfig }) => withCommand(runConfig, 'plan', {
      commandInstruction:
        'Werk in planmodus. Maak een concreet plan, vraag alleen om ontbrekende productkeuzes en voer geen muterende acties uit tenzij de gebruiker daarna expliciet om implementatie vraagt.',
    }),
  },
  {
    id: 'goal',
    slash: '/doel',
    label: 'Doel',
    description: 'Zet een zichtbaar doel voor de huidige chat of volgende run.',
    icon: Goal,
    providers: 'all',
    apply: ({ runConfig, args }) => {
      const goal = (args || '').trim();
      if (!goal) return runConfig;
      return withCommand(runConfig, 'goal', {
        commandGoal: goal,
        commandInstruction: `Houd dit doel actief voor je antwoord: ${goal}`,
      });
    },
  },
  {
    id: 'fast',
    slash: '/snel',
    label: 'Snel',
    description: 'Korter, sneller, minder omhaal. Codex gebruikt low + fast.',
    icon: Gauge,
    providers: 'all',
    apply: ({ provider, model, runConfig }) => {
      const next = withCommand(runConfig, 'fast', {
        commandInstruction: 'Antwoord direct en compact. Kies de snelste redelijke route en vermijd onnodige uitweiding.',
      });
      if (provider !== 'codex') return next;
      return {
        ...(model?.runConfig || {}),
        ...next,
        baseModelId: model?.id || next?.baseModelId,
        reasoningEffort: 'low',
        ...(model?.supportedServiceTiers?.includes('fast') ? { serviceTier: 'fast' as const } : {}),
      };
    },
  },
  {
    id: 'deep',
    slash: '/diep',
    label: 'Diep',
    description: 'Grondiger antwoord. Codex gebruikt de hoogste beschikbare effort.',
    icon: Brain,
    providers: 'all',
    apply: ({ provider, model, runConfig }) => {
      const next = withCommand(runConfig, 'deep', {
        commandInstruction: 'Werk grondig en controleer aannames. Geef een volledig maar goed gestructureerd antwoord.',
      });
      if (provider !== 'codex') return next;
      return {
        ...(model?.runConfig || {}),
        ...next,
        baseModelId: model?.id || next?.baseModelId,
        reasoningEffort: highestEffort(model),
        ...(next?.serviceTier ? { serviceTier: next.serviceTier } : model?.runConfig?.serviceTier ? { serviceTier: model.runConfig.serviceTier } : {}),
      };
    },
  },
  {
    id: 'review',
    slash: '/review',
    label: 'Review',
    description: 'Code-review houding: eerst bugs, risico’s en testgaten.',
    icon: SearchCheck,
    providers: 'all',
    apply: ({ runConfig }) => withCommand(runConfig, 'review', {
      commandInstruction:
        'Neem een code-review houding aan. Begin met concrete bugs, regressierisico’s en ontbrekende tests, met bestands- of functiereferenties waar mogelijk. Houd samenvatting secundair.',
    }),
  },
  {
    id: 'reset',
    slash: '/reset',
    label: 'Reset',
    description: 'Verwijder actieve command preset en doel.',
    icon: RotateCcw,
    providers: 'all',
    apply: ({ runConfig }) => clearCommandConfig(runConfig),
  },
];

export function parseCommandInput(value: string): ParsedCommand | null {
  const input = value.trimStart();
  if (!input.startsWith('/')) return null;
  const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const slash = (match?.[1] || '').toLowerCase();
  const preset = COMMAND_PRESETS.find((candidate) => candidate.slash === slash);
  if (!preset) return null;
  const rest = match?.[2] || '';
  return {
    preset,
    args: rest,
    rest,
  };
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

export function clearCommandConfig(runConfig?: ModelRunConfig): ModelRunConfig | undefined {
  if (!runConfig) return undefined;
  const { commandPresetId, commandGoal, commandInstruction, ...rest } = runConfig;
  return Object.keys(rest).length ? rest : undefined;
}

export function commandLabel(id?: string) {
  return COMMAND_PRESETS.find((preset) => preset.id === id)?.label || id || '';
}

function withCommand(runConfig: ModelRunConfig | undefined, id: CommandPresetId, values: Partial<ModelRunConfig>) {
  return {
    ...(runConfig || {}),
    commandPresetId: id,
    ...values,
  };
}

function highestEffort(model?: AIModel): ReasoningEffort {
  const supported = model?.supportedReasoningEfforts?.length ? model.supportedReasoningEfforts : ['low', 'medium', 'high', 'xhigh'];
  if (supported.includes('xhigh')) return 'xhigh';
  if (supported.includes('high')) return 'high';
  if (supported.includes('medium')) return 'medium';
  return 'low';
}
