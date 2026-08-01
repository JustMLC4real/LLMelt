import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types';
import { formatModelBadge } from './message-model-badge';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'message-1',
    chatId: 'chat-1',
    role: 'assistant',
    content: 'antwoord',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

describe('modelnaam in chatberichten', () => {
  it('noemt Codex naast versie en inspanning', () => {
    expect(formatModelBadge(message({
      provider: 'codex',
      modelId: 'gpt-5.4-mini',
      runConfig: JSON.stringify({ reasoningEffort: 'low' }),
    }))).toBe('Codex · 5.4 Mini · Licht');
  });

  it('verbergt een eventuele interne Codex-modus achter de zichtbare modelnaam', () => {
    expect(formatModelBadge(message({
      provider: 'codex',
      modelId: 'gpt-5.6-sol#high',
      runConfig: JSON.stringify({ reasoningEffort: 'high' }),
    }))).toBe('Codex · 5.6 Sol · Hoog');
  });
});
