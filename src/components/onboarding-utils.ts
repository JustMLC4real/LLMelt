import type {
  AIModel,
  CredentialStatus,
  ProviderAccountId,
  ProviderAccountStatus,
  ProviderType,
  RuntimeSetupProgress,
} from '../providers/types';
import type { ServiceAnswer } from './onboarding-launch';

export type OnboardingServiceId = Exclude<ProviderType, 'remote'>;
export type OnboardingDetectionState = 'unknown' | 'found' | 'absent';
export type OnboardingDetectionSource = 'lokaal' | 'account' | 'api';

export interface OnboardingService {
  provider: OnboardingServiceId;
  name: string;
  looksAt: string;
}

export interface OnboardingDetection {
  state: OnboardingDetectionState;
  ready: boolean;
  detail?: string;
  source?: OnboardingDetectionSource;
  executablePath?: string;
}

export interface OnboardingProviderSnapshot {
  modelsByProvider: Partial<Record<ProviderType, AIModel[]>>;
  authStatus: Partial<Record<ProviderType, CredentialStatus>>;
  accountStatuses: Partial<Record<ProviderAccountId, ProviderAccountStatus>>;
  chatgptSessionActive?: boolean;
  isRefreshingModels: boolean;
}

export const ONBOARDING_SERVICES: OnboardingService[] = [
  { provider: 'openai', name: 'ChatGPT', looksAt: 'ChatGPT-websessie of OpenAI API-sleutel' },
  { provider: 'codex', name: 'Codex', looksAt: 'Codex CLI op je pc' },
  { provider: 'anthropic', name: 'Claude', looksAt: 'Claude Code CLI of Anthropic API-sleutel' },
  { provider: 'google', name: 'Gemini', looksAt: 'Gemini API-sleutel' },
  { provider: 'antigravity', name: 'Antigravity', looksAt: 'Antigravity CLI op je pc' },
  { provider: 'ollama', name: 'Ollama', looksAt: 'lokale Ollama-server' },
];

export function showOnboardingSetupProgress(
  ready: boolean,
  progress: RuntimeSetupProgress | null,
) {
  return !ready
    && !!progress
    && progress.phase !== 'ready'
    && progress.phase !== 'error'
    && progress.phase !== 'cancelled';
}

/**
 * Detectie en gebruiksklaar zijn bewust apart. Een CLI kan al gevonden zijn,
 * terwijl de gebruiker in het geopende terminalvenster nog moet inloggen.
 */
export function detectOnboardingService(
  provider: OnboardingServiceId,
  snapshot: OnboardingProviderSnapshot,
): OnboardingDetection {
  const modelsOf = (id: ProviderType) => snapshot.modelsByProvider[id] || [];
  const authenticated = (id: ProviderType) => !!snapshot.authStatus[id]?.authenticated;
  const account = (id: ProviderAccountId) => snapshot.accountStatuses[id];
  const accountsLoaded = Object.keys(snapshot.accountStatuses).length > 0;

  switch (provider) {
    case 'openai':
      if (snapshot.chatgptSessionActive) {
        const catalogReady = modelsOf('openai').some((model) => model.id.startsWith('chatgpt:'));
        return {
          state: 'found',
          ready: catalogReady,
          source: 'account',
          detail: catalogReady
            ? 'ChatGPT-websessie en modelcatalogus actief'
            : 'ChatGPT-websessie actief; modelcatalogus wordt geladen',
        };
      }
      if (authenticated('openai')) {
        return { state: 'found', ready: true, source: 'api', detail: 'OpenAI API-sleutel ingesteld' };
      }
      if (typeof snapshot.chatgptSessionActive !== 'boolean') return { state: 'unknown', ready: false };
      return { state: 'absent', ready: false, detail: 'nog niet ingelogd' };

    case 'codex': {
      const status = account(provider);
      if (status?.installed) {
        return {
          state: 'found',
          // Een leesbare modelcatalogus of gevonden executable bewijst geen
          // accountlogin; uitsluitend `codex login status` doet dat.
          ready: !!status.authenticated,
          source: 'lokaal',
          detail: status.statusLabel || (status.authenticated ? 'CLI gevonden en ingelogd' : 'CLI gevonden; login nodig'),
          executablePath: status.executablePath,
        };
      }
      if (modelsOf(provider).length) {
        return {
          state: 'found',
          ready: false,
          source: 'lokaal',
          detail: 'CLI gevonden; loginstatus wordt nog gecontroleerd',
        };
      }
      return accountsLoaded
        ? { state: 'absent', ready: false, detail: 'CLI niet gevonden' }
        : { state: 'unknown', ready: false };
    }

    case 'antigravity': {
      const status = account('antigravity');
      if (status?.installed) {
        const validated = authenticated('antigravity') || modelsOf('antigravity').length > 0;
        return {
          state: 'found',
          // `canChat` betekent bij deze accountstatus alleen dat `agy` bestaat.
          // Een geslaagde provider-validatie of een echte modelcatalogus bewijst
          // daarentegen wel dat de CLI onmiddellijk gebruikt kan worden.
          ready: !!status.authenticated || validated,
          source: 'lokaal',
          detail: validated && !status.authenticated
            ? 'Antigravity CLI gecontroleerd en gebruiksklaar'
            : status.statusLabel || (status.authenticated ? 'CLI gevonden en ingelogd' : 'CLI gevonden; login nodig'),
          executablePath: status.executablePath,
        };
      }
      if (modelsOf('antigravity').length) {
        return { state: 'found', ready: true, source: 'lokaal', detail: `${modelsOf('antigravity').length} modellen beschikbaar` };
      }
      return accountsLoaded
        ? { state: 'absent', ready: false, detail: 'CLI niet gevonden' }
        : { state: 'unknown', ready: false };
    }

    case 'anthropic': {
      const cli = account('claude-cli');
      if (cli?.installed && cli.authenticated) {
        return {
          state: 'found',
          ready: true,
          source: 'lokaal',
          detail: cli.statusLabel || 'CLI gevonden en ingelogd',
          executablePath: cli.executablePath,
        };
      }
      if (authenticated('anthropic')) {
        return { state: 'found', ready: true, source: 'api', detail: 'Anthropic API-sleutel ingesteld' };
      }
      if (cli?.installed) {
        return {
          state: 'found',
          ready: false,
          source: 'lokaal',
          detail: cli.statusLabel || 'CLI gevonden; login nodig',
          executablePath: cli.executablePath,
        };
      }
      if (modelsOf('anthropic').some((model) => model.id.startsWith('claude-cli:'))) {
        return {
          state: 'found',
          ready: false,
          source: 'lokaal',
          detail: 'Claude CLI gevonden; loginstatus wordt nog gecontroleerd',
        };
      }
      return accountsLoaded
        ? { state: 'absent', ready: false, detail: 'geen CLI of API-sleutel' }
        : { state: 'unknown', ready: false };
    }

    case 'google':
      return authenticated('google')
        ? { state: 'found', ready: true, source: 'api', detail: 'Gemini API-sleutel ingesteld' }
        : { state: 'absent', ready: false, detail: 'Gemini API-sleutel nodig' };

    case 'ollama': {
      const models = modelsOf('ollama');
      if (models.length || authenticated('ollama')) {
        return {
          state: 'found',
          ready: true,
          source: 'lokaal',
          detail: models.length ? `${models.length} lokaal model${models.length === 1 ? '' : 'len'}` : 'Ollama online',
        };
      }
      return snapshot.isRefreshingModels
        ? { state: 'unknown', ready: false }
        : { state: 'absent', ready: false, detail: 'lokale Ollama-server niet bereikbaar' };
    }
  }
}

export function selectedOnboardingServices(answers: Record<string, ServiceAnswer>) {
  return ONBOARDING_SERVICES.filter((service) => answers[service.provider] === 'yes');
}

export function answerOnboardingServices(
  answers: Record<string, ServiceAnswer>,
  services: OnboardingService[],
  answer: ServiceAnswer,
) {
  const next = { ...answers };
  for (const service of services) {
    next[service.provider] = answer;
  }
  return next;
}
