export type ChatScopedLists<T> = Record<string, T[]>;

export function shouldApplyChatResult(activeChatId: string | null, resultChatId: string) {
  return !!activeChatId && activeChatId === resultChatId;
}

export function chatScopedList<T>(lists: ChatScopedLists<T>, chatId: string | null) {
  return chatId ? (lists[chatId] || []) : [];
}

export function updateChatScopedList<T>(
  lists: ChatScopedLists<T>,
  chatId: string,
  update: T[] | ((current: T[]) => T[]),
) {
  const current = lists[chatId] || [];
  const next = typeof update === 'function'
    ? (update as (current: T[]) => T[])(current)
    : update;
  if (next === current) return lists;
  if (!next.length) {
    if (!(chatId in lists)) return lists;
    const { [chatId]: _, ...rest } = lists;
    return rest;
  }
  return { ...lists, [chatId]: next };
}

export function removeChatScopedLists<T>(lists: ChatScopedLists<T>, chatIds: Iterable<string>) {
  const removed = new Set(chatIds);
  if (![...removed].some((chatId) => chatId in lists)) return lists;
  return Object.fromEntries(Object.entries(lists).filter(([chatId]) => !removed.has(chatId))) as ChatScopedLists<T>;
}

export function setMembership(ids: string[], id: string, present: boolean) {
  if (present) return ids.includes(id) ? ids : [...ids, id];
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : ids;
}

export function itemsOwnedByChat<T extends { chatId: string }>(items: T[], chatId: string | null) {
  return chatId ? items.filter((item) => item.chatId === chatId) : [];
}

export function removeItemsOwnedByRequest<T extends { chatId: string; requestId?: string }>(
  items: T[],
  chatId: string,
  requestId?: string,
) {
  return items.filter((item) => (
    item.chatId !== chatId || (requestId !== undefined && item.requestId !== requestId)
  ));
}
