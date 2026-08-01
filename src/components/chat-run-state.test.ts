import { describe, expect, it } from 'vitest';
import {
  appendChatRunContent,
  appendChatRunNativeMessage,
  chatIdForRequest,
  finishChatRun,
  requestIdsForChats,
  shouldApplyChatRunResult,
  setChatRunStatus,
  startChatRun,
  startChatRunNativeMessage,
} from './chat-run-state';

describe('chat-run-state', () => {
  it('houdt twee gelijktijdige beurten strikt per chat gescheiden', () => {
    let runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'req-a', modelId: 'model-a', provider: 'openai', status: 'A denkt',
    }, 10);
    runs = startChatRun(runs, {
      chatId: 'chat-b', requestId: 'req-b', modelId: 'model-b', provider: 'ollama', status: 'B denkt',
    }, 20);
    runs = appendChatRunContent(runs, 'chat-a', 'req-a', 'antwoord A');
    runs = appendChatRunContent(runs, 'chat-b', 'req-b', 'antwoord B');

    expect(runs['chat-a'].streamingContent).toBe('antwoord A');
    expect(runs['chat-b'].streamingContent).toBe('antwoord B');
    expect(chatIdForRequest(runs, 'req-a')).toBe('chat-a');
    expect(chatIdForRequest(runs, 'req-b')).toBe('chat-b');
  });

  it('negeert late events van een vervangen verzoek', () => {
    let runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'oud', modelId: 'model', provider: 'codex',
    });
    runs = startChatRun(runs, {
      chatId: 'chat-a', requestId: 'nieuw', modelId: 'model', provider: 'codex',
    });
    const unchanged = appendChatRunContent(runs, 'chat-a', 'oud', 'mag niet verschijnen');
    expect(unchanged).toBe(runs);
    expect(runs['chat-a'].streamingContent).toBe('');
    expect(shouldApplyChatRunResult(runs, 'chat-a', 'oud')).toBe(false);
    expect(shouldApplyChatRunResult(runs, 'chat-a', 'nieuw')).toBe(true);
  });

  it('bewaart status en native segmenten alleen bij het juiste verzoek', () => {
    let runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'req-a', modelId: 'model', provider: 'anthropic', status: 'Plant',
    }, 100);
    runs = setChatRunStatus(runs, 'chat-a', 'req-a', 'Voert uit', 200);
    runs = startChatRunNativeMessage(runs, 'chat-a', 'req-a', {
      id: 'segment-1', chatId: 'chat-a', role: 'assistant', content: '', modelId: 'model', provider: 'anthropic',
      inputTokens: 0, outputTokens: 0, createdAt: new Date(0).toISOString(),
    });
    runs = appendChatRunNativeMessage(runs, 'chat-a', 'req-a', 'segment-1', 'tekst');

    expect(runs['chat-a'].streamingStatus).toBe('Voert uit');
    expect(runs['chat-a'].streamingStatusStartedAt).toBe(200);
    expect(runs['chat-a'].nativeMessages[0].content).toBe('tekst');
  });

  it('weigert een native segment waarvan het bericht bij een andere chat hoort', () => {
    const runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'req-a', modelId: 'model', provider: 'anthropic',
    });
    const unchanged = startChatRunNativeMessage(runs, 'chat-a', 'req-a', {
      id: 'segment-b', chatId: 'chat-b', role: 'assistant', content: 'geheim uit B',
      modelId: 'model', provider: 'anthropic', inputTokens: 0, outputTokens: 0,
      createdAt: new Date(0).toISOString(),
    });

    expect(unchanged).toBe(runs);
    expect(runs['chat-a'].nativeMessages).toEqual([]);
  });

  it('rondt alleen het overeenkomende verzoek af', () => {
    const runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'req-a', modelId: 'model', provider: 'google',
    });
    expect(finishChatRun(runs, 'chat-a', 'verkeerd')).toBe(runs);
    expect(finishChatRun(runs, 'chat-a', 'req-a')).toEqual({});
  });

  it('vindt alleen verzoeken van de chats die worden verwijderd', () => {
    let runs = startChatRun({}, {
      chatId: 'chat-a', requestId: 'req-a', modelId: 'model', provider: 'codex',
    });
    runs = startChatRun(runs, {
      chatId: 'chat-b', requestId: 'req-b', modelId: 'model', provider: 'ollama',
    });
    runs = startChatRun(runs, {
      chatId: 'chat-c', requestId: 'req-c', modelId: 'model', provider: 'anthropic',
    });

    expect(requestIdsForChats(runs, ['chat-a', 'chat-c'])).toEqual(['req-a', 'req-c']);
  });
});
