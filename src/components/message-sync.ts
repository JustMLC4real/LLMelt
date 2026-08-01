import type { Message } from '../providers/types';

/**
 * Vervangt het tijdelijke userbericht door het bericht dat het main-proces echt
 * in SQLite heeft opgeslagen. Het persisted event kan ook aankomen nadat een
 * verouderde DB-load de tijdelijke rij heeft gewist; dan voegen we het bericht
 * alsnog toe.
 */
export function reconcilePersistedUserMessage(
  messages: Message[],
  chatId: string,
  requestId: string,
  persisted: Message,
): Message[] {
  if (persisted.chatId !== chatId || persisted.role !== 'user') return messages;

  const optimisticId = `optimistic-${requestId}`;
  const optimisticIndex = messages.findIndex((message) => message.id === optimisticId);
  const persistedIndex = messages.findIndex((message) => message.id === persisted.id);

  if (persistedIndex >= 0) {
    return messages.filter((message) => message.id !== optimisticId);
  }
  if (optimisticIndex >= 0) {
    return messages.map((message, index) => index === optimisticIndex ? persisted : message);
  }
  return [...messages, persisted];
}
