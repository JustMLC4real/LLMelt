import { describe, expect, it } from 'vitest';
import { isChatGptSubscriptionModel, providerPreflightSurface } from '../electron/provider-routing';

describe('provider-preflight', () => {
  it('routeert een ChatGPT-abonnementsmodel via de websessie', () => {
    const modelRef = { provider: 'openai' as const, modelId: 'chatgpt:gpt-live' };

    expect(providerPreflightSurface(modelRef)).toBe('chatgpt-session');
    expect(isChatGptSubscriptionModel(modelRef)).toBe(true);
  });

  it('blijft een OpenAI-API-model via de providercredential controleren', () => {
    const modelRef = { provider: 'openai' as const, modelId: 'gpt-api-live' };

    expect(providerPreflightSurface(modelRef)).toBe('provider-credential');
    expect(isChatGptSubscriptionModel(modelRef)).toBe(false);
  });

  it('behandelt een chatgpt-prefix van een andere provider niet als websessie', () => {
    expect(providerPreflightSurface({ provider: 'codex', modelId: 'chatgpt:geen-websessie' })).toBe('provider-credential');
  });
});
