import { describe, expect, it } from 'vitest';
import {
  deferAgentApproval,
  deferAgentApprovalsOutsideChat,
  deferredAgentApprovalsForChat,
  enqueueAgentApproval,
  nextModalAgentApproval,
  removeAgentApproval,
  type QueuedAgentApproval,
} from './approval-queue';

function approval(id: string, chatId: string): QueuedAgentApproval {
  return { id, chatId, command: `cmd-${id}`, cwd: 'C:\\werk', deferred: false };
}

describe('approval-queue', () => {
  it('maakt buiten klikken uitstel in plaats van weigeren en toont daarna de volgende popup', () => {
    const queue = [approval('eerste', 'chat-a'), approval('tweede', 'chat-b')];
    const deferred = deferAgentApproval(queue, 'eerste');

    expect(deferred[0].deferred).toBe(true);
    expect(nextModalAgentApproval(deferred)?.id).toBe('tweede');
    expect(deferredAgentApprovalsForChat(deferred, 'chat-a').map((item) => item.id)).toEqual(['eerste']);
  });

  it('houdt uitgestelde keuzes per chat gescheiden en schuift na antwoord door', () => {
    let queue = [
      { ...approval('a1', 'chat-a'), deferred: true },
      { ...approval('b1', 'chat-b'), deferred: true },
      { ...approval('a2', 'chat-a'), deferred: true },
    ];
    expect(deferredAgentApprovalsForChat(queue, 'chat-a').map((item) => item.id)).toEqual(['a1', 'a2']);
    queue = removeAgentApproval(queue, 'a1');
    expect(deferredAgentApprovalsForChat(queue, 'chat-a')[0].id).toBe('a2');
  });

  it('voegt hetzelfde IPC-verzoek nooit dubbel toe', () => {
    const first = enqueueAgentApproval([], approval('a1', 'chat-a'));
    expect(enqueueAgentApproval(first, approval('a1', 'chat-a'))).toBe(first);
  });

  it('zet een aanvraag uit een achtergrondchat meteen in de juiste dock', () => {
    const queue = enqueueAgentApproval([], approval('a1', 'chat-a'), 'chat-b');

    expect(queue[0].deferred).toBe(true);
    expect(nextModalAgentApproval(queue, 'chat-b')).toBeNull();
    expect(deferredAgentApprovalsForChat(queue, 'chat-a').map((item) => item.id)).toEqual(['a1']);
  });

  it('stelt een open popup uit zodra de gebruiker naar een andere chat wisselt', () => {
    const queue = enqueueAgentApproval([], approval('a1', 'chat-a'), 'chat-a');
    const switched = deferAgentApprovalsOutsideChat(queue, 'chat-b');

    expect(nextModalAgentApproval(switched, 'chat-b')).toBeNull();
    expect(switched[0].deferred).toBe(true);
    expect(deferredAgentApprovalsForChat(switched, 'chat-a')).toHaveLength(1);
  });
});
