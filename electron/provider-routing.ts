import type { ModelRef } from '../src/providers/types';

export type ProviderPreflightSurface = 'chatgpt-session' | 'provider-credential';

export function providerPreflightSurface(
  modelRef: Pick<ModelRef, 'provider' | 'modelId'>,
): ProviderPreflightSurface {
  return modelRef.provider === 'openai' && modelRef.modelId.startsWith('chatgpt:')
    ? 'chatgpt-session'
    : 'provider-credential';
}

export function isChatGptSubscriptionModel(modelRef: Pick<ModelRef, 'provider' | 'modelId'>) {
  return providerPreflightSurface(modelRef) === 'chatgpt-session';
}
