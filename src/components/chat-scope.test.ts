import { describe, expect, it } from 'vitest';
import { chatScopedList, itemsOwnedByChat, removeChatScopedLists, removeItemsOwnedByRequest, setMembership, shouldApplyChatResult, updateChatScopedList } from './chat-scope';

describe('chat-scope', () => {
  it('weigert een laat resultaat van de vorige chat', () => {
    expect(shouldApplyChatResult('chat-b', 'chat-a')).toBe(false);
    expect(shouldApplyChatResult('chat-b', 'chat-b')).toBe(true);
    expect(shouldApplyChatResult(null, 'chat-a')).toBe(false);
  });

  it('houdt tijdelijke lijsten strikt per chat gescheiden', () => {
    let lists = updateChatScopedList({}, 'chat-a', ['bestand-a']);
    lists = updateChatScopedList(lists, 'chat-b', ['bestand-b']);
    lists = updateChatScopedList(lists, 'chat-a', []);

    expect(chatScopedList(lists, 'chat-a')).toEqual([]);
    expect(chatScopedList(lists, 'chat-b')).toEqual(['bestand-b']);
  });

  it('bewaart pending bijlagen bij viewwissels en ruimt alleen verwijderde chats op', () => {
    const lists = {
      'chat-a': [{ id: 'bijlage-a' }],
      'chat-b': [{ id: 'bijlage-b' }],
    };
    const cleaned = removeChatScopedLists(lists, ['chat-a']);

    expect(chatScopedList(cleaned, 'chat-a')).toEqual([]);
    expect(chatScopedList(cleaned, 'chat-b')).toEqual([{ id: 'bijlage-b' }]);
  });

  it('kan meerdere gelijktijdige status-id’s onafhankelijk bijhouden', () => {
    let ids = setMembership([], 'chat-a', true);
    ids = setMembership(ids, 'chat-b', true);
    ids = setMembership(ids, 'chat-a', false);

    expect(ids).toEqual(['chat-b']);
  });

  it('laat de renderer nooit items van een andere chat tonen', () => {
    const items = [
      { id: 'a', chatId: 'chat-a' },
      { id: 'b', chatId: 'chat-b' },
    ];
    expect(itemsOwnedByChat(items, 'chat-b')).toEqual([{ id: 'b', chatId: 'chat-b' }]);
  });

  it('ruimt afgeronde live toolitems per chat en request op zonder andere highlights te raken', () => {
    const items = [
      { id: 'a-oud', chatId: 'chat-a', requestId: 'request-1' },
      { id: 'a-nieuw', chatId: 'chat-a', requestId: 'request-2' },
      { id: 'b', chatId: 'chat-b', requestId: 'request-1' },
    ];

    expect(removeItemsOwnedByRequest(items, 'chat-a', 'request-1')).toEqual([items[1], items[2]]);
    expect(removeItemsOwnedByRequest(items, 'chat-a')).toEqual([items[2]]);
  });
});
