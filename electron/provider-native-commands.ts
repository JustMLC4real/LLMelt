import type { ModelRef, NativeProviderCommand, UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import {
  antigravityExecutableCandidates,
  claudeExecutableCandidates,
  codexExecutableCandidates,
  findCliExecutable,
} from './cli-discovery';
import { codexAppServer } from './codex-app-server';
import { getStore } from './settings-store';
import { cliOptionChoicesFromHelp } from './cli-run-capabilities';
import { readCliHelpText } from './provider-adapters';

/**
 * Leest provideracties uit de echte runtime. LLMelt verzint hier geen slashlijst:
 * Codex komt uit App Server; Claude/Antigravity uit hun actuele CLI-help.
 */
export async function listNativeProviderCommands(
  modelRef: ModelRef,
  cwd: string | undefined,
  language: UiLanguage,
): Promise<NativeProviderCommand[]> {
  if (modelRef.provider === 'codex') {
    const executable = await configuredExecutable('codex');
    if (!executable) return [];
    const capabilities = await codexAppServer.capabilities(executable, cwd).catch(() => null);
    if (!capabilities) return [];

    return nativeCodexCommands(capabilities, language);
  }

  if (modelRef.provider === 'anthropic' && modelRef.modelId.startsWith('claude-cli:')) {
    const executable = await configuredExecutable('claude');
    if (!executable) return [];
    const helpText = await readCliHelpText(executable).catch(() => '');
    return nativeCliModeCommands('claude', cliOptionChoicesFromHelp(helpText, 'permission-mode'), language);
  }
  if (modelRef.provider === 'antigravity') {
    const executable = await configuredExecutable('antigravity');
    if (!executable) return [];
    const helpText = await readCliHelpText(executable).catch(() => '');
    return nativeCliModeCommands('antigravity', cliOptionChoicesFromHelp(helpText, 'mode'), language);
  }
  return [];
}

export function nativeCodexCommands(
  capabilities: Awaited<ReturnType<typeof codexAppServer.capabilities>>,
  language: UiLanguage,
): NativeProviderCommand[] {
    const collaborationModes = capabilities.collaborationModes.map((mode) => ({
      id: `codex:mode:${mode.mode}`,
      provider: 'codex' as const,
      slash: `/${slashToken(mode.name || mode.mode)}`,
      aliases: [],
      label: mode.name,
      description: localizedText(
        language,
        `Native Codex-samenwerkingsmodus: ${mode.name}.`,
        `Native Codex collaboration mode: ${mode.name}.`,
      ),
      source: 'app-server' as const,
      kind: 'collaboration-mode' as const,
      mode: mode.mode,
      model: mode.model,
      reasoningEffort: mode.reasoningEffort,
    }));

    const skills = capabilities.skills.map((skill) => ({
      id: `codex:skill:${skill.path}`,
      provider: 'codex' as const,
      slash: `/skill-${slashToken(skill.name)}`,
      aliases: [],
      label: skill.name,
      description: skill.description || localizedText(language, 'Native Codex-skill.', 'Native Codex skill.'),
      source: 'app-server' as const,
      kind: 'skill' as const,
      name: skill.name,
      path: skill.path,
    }));

    return uniqueCommands([
      ...(capabilities.goal ? [{
        id: 'codex:goal',
        provider: 'codex' as const,
        slash: '/goal',
        aliases: [],
        label: 'Goal',
        description: localizedText(language, 'Stel het echte Codex-threaddoel in.', 'Set the real Codex thread goal.'),
        source: 'app-server' as const,
        kind: 'goal' as const,
        requiresArgument: true,
      }] : []),
      ...(capabilities.review ? [{
        id: 'codex:review',
        provider: 'codex' as const,
        slash: '/review',
        aliases: [],
        label: 'Review',
        description: localizedText(language, 'Start een native Codex-review.', 'Start a native Codex review.'),
        source: 'app-server' as const,
        kind: 'review' as const,
      }] : []),
      ...collaborationModes,
      ...skills,
    ]);
}

/**
 * Alleen modi die LLMelt veilig als eenmalige headless providerflag kan sturen
 * komen in de chat-UI. Interactieve TUI-opdrachten zijn geen headless protocol.
 */
export function nativeCliModeCommands(
  provider: 'claude' | 'antigravity',
  advertisedModes: string[],
  language: UiLanguage,
): NativeProviderCommand[] {
  const planMode = advertisedModes.find((mode) => mode.toLowerCase() === 'plan');
  if (!planMode) return [];
  const providerName = provider === 'claude' ? 'Claude' : 'Antigravity';
  return [{
    id: `${provider}:mode:${planMode}`,
    provider: provider === 'claude' ? 'anthropic' : 'antigravity',
    slash: '/plan',
    aliases: [],
    label: 'Plan',
    description: localizedText(
      language,
      `Laat de volgende beurt in de native ${providerName}-planmodus draaien.`,
      `Run the next turn in native ${providerName} plan mode.`,
    ),
    source: 'cli-help',
    kind: 'collaboration-mode',
    mode: planMode,
  }];
}

export async function configuredExecutable(provider: 'codex' | 'claude' | 'antigravity') {
  const store = await getStore();
  if (provider === 'codex') {
    return findCliExecutable(codexExecutableCandidates(store.get('codex.executable') as string | undefined));
  }
  if (provider === 'claude') {
    return findCliExecutable(claudeExecutableCandidates(store.get('claude.executable') as string | undefined));
  }
  return findCliExecutable(antigravityExecutableCandidates(store.get('antigravity.executable') as string | undefined));
}

function slashToken(value: string) {
  return String(value || 'mode')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mode';
}

function uniqueCommands(commands: NativeProviderCommand[]) {
  const slashes = new Set<string>();
  return commands.filter((command) => {
    const slash = command.slash.toLowerCase();
    if (slashes.has(slash)) return false;
    slashes.add(slash);
    return true;
  });
}
