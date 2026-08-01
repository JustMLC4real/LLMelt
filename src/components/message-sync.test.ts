import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types';
import { reconcilePersistedUserMessage } from './message-sync';

function message(id: string, chatId = 'chat-a', role: Message['role'] = 'user'): Message {
  return {
    id,
    chatId,
    role,
    content: id,
    modelId: 'model',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('synchronisatie van het eerste gebruikersbericht', () => {
  it('vervangt het optimistische bericht zonder een duplicaat te maken', () => {
    const persisted = message('saved-user');
    expect(reconcilePersistedUserMessage(
      [message('older'), message('optimistic-request-1')],
      'chat-a',
      'request-1',
      persisted,
    ).map((item) => item.id)).toEqual(['older', 'saved-user']);
  });

  it('herstelt het opgeslagen bericht wanneer een late lege DB-load het tijdelijke bericht wiste', () => {
    const persisted = message('saved-user');
    expect(reconcilePersistedUserMessage([], 'chat-a', 'request-1', persisted)).toEqual([persisted]);
  });

  it('wijzigt geen berichtlijst van een andere chat of een assistent-event', () => {
    const original = [message('older')];
    expect(reconcilePersistedUserMessage(original, 'chat-a', 'request-1', message('saved', 'chat-b')))
      .toBe(original);
    expect(reconcilePersistedUserMessage(original, 'chat-a', 'request-1', message('saved', 'chat-a', 'assistant')))
      .toBe(original);
  });
});
