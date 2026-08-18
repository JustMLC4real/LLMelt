import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('first-start modelcataloguscontract', () => {
  it('stabiliseert Codex en ChatGPT na de eerste niet-lege snapshot', () => {
    const app = read('./components/App.tsx');
    expect(app).toContain('settleLiveCatalog({');
    expect(app).toContain("api.providers.refreshModels('codex')");
    expect(app).toContain("api.providers.refreshModels('openai')");
    expect(app).toContain('await Promise.allSettled(initialCatalogSettleTasks)');
    expect(app).toContain('modelsInCurrentChatgptCatalog(');
  });

  it('gebruikt ook tijdens onboarding een geforceerde providerrefresh', () => {
    const onboarding = read('./components/OnboardingGuide.tsx');
    expect(onboarding).toContain('api.providers.refreshModels(provider)');
    expect(onboarding).not.toContain('provider ? api.providers.listModels(provider)');
  });

  it('stuurt een providergerichte refresh door tot de cache-invalidatie in main', () => {
    const preload = read('../electron/preload.ts');
    const handlers = read('../electron/ipc-handlers.ts');
    expect(preload).toContain('refreshModels: (providerId?: ProviderType)');
    expect(handlers).toContain('refreshModels(providerId)');
    expect(handlers).toContain('adapters[providerId].invalidateModelCache?.()');
  });

  it('geeft tijdens een ChatGPT-modelrefresh geen presets uit de vorige snapshot terug', () => {
    const scraper = read('../electron/chatgpt-scraper.ts');
    expect(scraper).toContain('if (sessionModelsInFlight) await sessionModelsInFlight;');
    expect(scraper).toContain('cachedAccountId = null;');
  });

  it('laat tijdens de eerste live cataloguscontrole nog geen stale model verzenden', () => {
    const input = read('./components/ChatInput.tsx');
    expect(input).toContain('isStreaming || isRefreshingModels ||');
    expect(input).toContain('!activeModelId || isRefreshingModels');
  });

  it('publiceert na ChatGPT-login één snapshot naar onboarding én de globale store', () => {
    const handlers = read('../electron/ipc-handlers.ts');
    const onboarding = read('./components/OnboardingGuide.tsx');
    const settings = read('./components/Settings.tsx');
    expect(handlers).toContain('return { success: true, models, versions, sessionStatus };');
    expect(onboarding).toContain("providerStore.setChatgptSessionActive(loginSnapshot.sessionStatus.active)");
    expect(settings).toContain('setProviderChatgptSessionActive(result.sessionStatus.active === true)');
    expect(settings).toContain('setProviderChatgptSessionActive(!!session?.active)');
  });
});
