import { describe, expect, it } from 'vitest';
import type { CredentialStatus, ProviderAccountStatus, ProviderType } from '../providers/types';
import type { ServiceAnswer } from './onboarding-launch';
import {
  answerOnboardingServices,
  detectOnboardingService,
  ONBOARDING_SERVICES,
  selectedOnboardingServices,
  showOnboardingSetupProgress,
  type OnboardingProviderSnapshot,
} from './onboarding-utils';

function credential(provider: ProviderType, authenticated = false): CredentialStatus {
  return {
    provider,
    authenticated,
    method: authenticated ? 'apikey' : 'none',
    canChat: authenticated,
  };
}

function cliAccount(
  provider: 'codex' | 'antigravity' | 'claude-cli',
  installed: boolean,
  authenticated = false,
  executablePath?: string,
): ProviderAccountStatus {
  return {
    provider,
    displayName: provider,
    surface: 'cli',
    installed,
    authenticated,
    executablePath,
    statusLabel: installed ? (authenticated ? 'CLI gevonden en ingelogd' : 'CLI gevonden; login nodig') : 'CLI niet gevonden',
    statusSource: 'cli',
    canChat: authenticated,
    limitsKnown: false,
  };
}

function freshSnapshot(): OnboardingProviderSnapshot {
  return {
    modelsByProvider: {},
    authStatus: {
      openai: credential('openai'),
      anthropic: credential('anthropic'),
      google: credential('google'),
      ollama: credential('ollama'),
      codex: credential('codex'),
      antigravity: credential('antigravity'),
    },
    accountStatuses: {
      codex: cliAccount('codex', false),
      'claude-cli': cliAccount('claude-cli', false),
      antigravity: cliAccount('antigravity', false),
    },
    chatgptSessionActive: false,
    isRefreshingModels: false,
  };
}

describe('fresh-start onboarding', () => {
  it('meldt op een schoon profiel niets ten onrechte als gebruiksklaar', () => {
    const snapshot = freshSnapshot();

    for (const provider of ['openai', 'codex', 'anthropic', 'google', 'antigravity', 'ollama'] as const) {
      const detection = detectOnboardingService(provider, snapshot);
      expect(detection.state, provider).toBe('absent');
      expect(detection.ready, provider).toBe(false);
    }
  });

  it('wacht na ChatGPT-login totdat ook de live webcatalogus beschikbaar is', () => {
    const snapshot = freshSnapshot();
    snapshot.chatgptSessionActive = true;

    expect(detectOnboardingService('openai', snapshot)).toMatchObject({
      state: 'found',
      ready: false,
      detail: 'ChatGPT-websessie actief; modelcatalogus wordt geladen',
    });

    snapshot.modelsByProvider.openai = [{
      id: 'chatgpt:live-model',
      name: 'Live model',
      provider: 'openai',
      contextWindow: 1,
      maxOutputTokens: 1,
      supportsVision: false,
      supportsFiles: false,
      supportsStreaming: true,
    }];

    expect(detectOnboardingService('openai', snapshot)).toMatchObject({
      state: 'found',
      ready: true,
      detail: 'ChatGPT-websessie en modelcatalogus actief',
    });
  });

  it('onderscheidt een gevonden CLI van een afgeronde login en toont het echte pad', () => {
    const snapshot = freshSnapshot();
    snapshot.accountStatuses['claude-cli'] = cliAccount(
      'claude-cli',
      true,
      false,
      'C:\\Users\\Test\\.local\\bin\\claude.exe',
    );

    expect(detectOnboardingService('anthropic', snapshot)).toEqual({
      state: 'found',
      ready: false,
      source: 'lokaal',
      detail: 'CLI gevonden; login nodig',
      executablePath: 'C:\\Users\\Test\\.local\\bin\\claude.exe',
    });

    snapshot.accountStatuses['claude-cli'] = cliAccount('claude-cli', true, true);
    expect(detectOnboardingService('anthropic', snapshot).ready).toBe(true);
  });

  it('markeert Codex niet als klaar op basis van alleen executable, canChat of catalogus', () => {
    const snapshot = freshSnapshot();
    const executableOnly = cliAccount('codex', true, false, 'C:\\Tools\\codex.exe');
    executableOnly.canChat = true;
    snapshot.accountStatuses.codex = executableOnly;
    snapshot.modelsByProvider.codex = [{
      id: 'codex:test',
      name: 'Test',
      provider: 'codex',
      contextWindow: 1,
      maxOutputTokens: 1,
      supportsVision: false,
      supportsFiles: false,
      supportsStreaming: false,
    }];

    expect(detectOnboardingService('codex', snapshot)).toMatchObject({
      state: 'found',
      ready: false,
      executablePath: 'C:\\Tools\\codex.exe',
    });
  });

  it('markeert een gecachet Claude CLI-model zonder bevestigde login niet als klaar', () => {
    const snapshot = freshSnapshot();
    snapshot.accountStatuses = {};
    snapshot.modelsByProvider.anthropic = [{
      id: 'claude-cli:test',
      name: 'Test',
      provider: 'anthropic',
      contextWindow: 1,
      maxOutputTokens: 1,
      supportsVision: false,
      supportsFiles: false,
      supportsStreaming: false,
    }];

    expect(detectOnboardingService('anthropic', snapshot)).toMatchObject({
      state: 'found',
      ready: false,
    });
  });

  it('beschouwt Claude als klaar via API als een daarnaast gevonden CLI nog niet is ingelogd', () => {
    const snapshot = freshSnapshot();
    snapshot.authStatus.anthropic = credential('anthropic', true);
    snapshot.accountStatuses['claude-cli'] = cliAccount('claude-cli', true, false);

    expect(detectOnboardingService('anthropic', snapshot)).toMatchObject({
      state: 'found',
      ready: true,
      source: 'api',
    });
  });

  it('vertrouwt bij Antigravity niet alleen op executable-detectie, maar wel op echte validatie', () => {
    const snapshot = freshSnapshot();
    const executableOnly = cliAccount('antigravity', true, false, 'C:\\Tools\\agy.exe');
    executableOnly.canChat = true;
    snapshot.accountStatuses.antigravity = executableOnly;

    expect(detectOnboardingService('antigravity', snapshot)).toMatchObject({
      state: 'found',
      ready: false,
    });

    snapshot.authStatus.antigravity = credential('antigravity', true);
    expect(detectOnboardingService('antigravity', snapshot)).toMatchObject({
      state: 'found',
      ready: true,
      detail: 'Antigravity CLI gecontroleerd en gebruiksklaar',
    });
  });

  it('neemt alleen expliciet gekozen diensten mee naar de installatiestappen', () => {
    expect(selectedOnboardingServices({
      openai: 'yes',
      codex: 'no',
      anthropic: 'maybe',
      google: 'yes',
    }).map((service) => service.provider)).toEqual(['openai', 'google']);
  });

  it('kan alle zichtbare diensten tegelijk selecteren of deselecteren', () => {
    const visible = ONBOARDING_SERVICES.filter((service) =>
      ['openai', 'codex'].includes(service.provider));
    const initial = {
      openai: 'no',
      codex: 'no',
      google: 'maybe',
    } satisfies Record<string, ServiceAnswer>;

    const selected = answerOnboardingServices(initial, visible, 'yes');
    expect(selected).toEqual({
      openai: 'yes',
      codex: 'yes',
      google: 'maybe',
    });
    expect(answerOnboardingServices(selected, visible, 'no')).toEqual(initial);
  });
});

describe('onboarding voortgang', () => {
  const waiting = {
    runtime: 'codex',
    phase: 'awaiting-login',
    status: 'Rond de login af',
  } as const;

  it('verbergt een oude loginbalk zodra de provider gebruiksklaar is', () => {
    expect(showOnboardingSetupProgress(true, waiting)).toBe(false);
  });

  it('toont de loginbalk zolang de provider nog niet gereed is', () => {
    expect(showOnboardingSetupProgress(false, waiting)).toBe(true);
  });
});
