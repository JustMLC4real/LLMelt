import type { Message, ModelRunConfig, ProviderType } from '../providers/types';

export interface ChatRunState {
  chatId: string;
  requestId: string;
  isStreaming: true;
  streamingContent: string;
  streamingStatus: string;
  streamingStatusStartedAt: number | null;
  nativeStreamId: string | null;
  nativeMessages: Message[];
  modelId: string;
  provider: ProviderType;
  runConfig?: ModelRunConfig;
}

export type ChatRunRegistry = Record<string, ChatRunState>;

export function startChatRun(
  registry: ChatRunRegistry,
  run: Pick<ChatRunState, 'chatId' | 'requestId' | 'modelId' | 'provider' | 'runConfig'> & { status?: string },
  now = Date.now(),
): ChatRunRegistry {
  const status = run.status || '';
  return {
    ...registry,
    [run.chatId]: {
      chatId: run.chatId,
      requestId: run.requestId,
      isStreaming: true,
      streamingContent: '',
      streamingStatus: status,
      streamingStatusStartedAt: status ? now : null,
      nativeStreamId: null,
      nativeMessages: [],
      modelId: run.modelId,
      provider: run.provider,
      runConfig: run.runConfig,
    },
  };
}

export function setChatRunStatus(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
  status: string,
  now = Date.now(),
): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId) return registry;
  return {
    ...registry,
    [chatId]: {
      ...current,
      streamingStatus: status,
      streamingStatusStartedAt: status
        ? current.streamingStatus === status && current.streamingStatusStartedAt
          ? current.streamingStatusStartedAt
          : now
        : null,
    },
  };
}

export function appendChatRunContent(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
  delta: string,
): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId || !delta) return registry;
  return {
    ...registry,
    [chatId]: { ...current, streamingContent: current.streamingContent + delta },
  };
}

export function setChatRunModel(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
  model: { modelId: string; provider: ProviderType; runConfig?: ModelRunConfig },
): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId) return registry;
  return { ...registry, [chatId]: { ...current, ...model } };
}

export function startChatRunNativeMessage(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
  message: Message,
): ChatRunRegistry {
  const current = registry[chatId];
  // Het event en het ingesloten bericht moeten dezelfde eigenaar hebben. Alleen op
  // requestId controleren is niet genoeg: een verkeerd gerouteerd native segment
  // zou anders als echt bericht in de zichtbare chat kunnen worden toegevoegd.
  if (!current || current.requestId !== requestId || message.chatId !== chatId) return registry;
  const exists = current.nativeMessages.some((candidate) => candidate.id === message.id);
  return {
    ...registry,
    [chatId]: {
      ...current,
      nativeStreamId: message.id,
      nativeMessages: exists ? current.nativeMessages : [...current.nativeMessages, message],
    },
  };
}

export function appendChatRunNativeMessage(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
  messageId: string,
  delta: string,
): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId || !delta) return registry;
  return {
    ...registry,
    [chatId]: {
      ...current,
      nativeMessages: current.nativeMessages.map((message) => (
        message.id === messageId ? { ...message, content: message.content + delta } : message
      )),
    },
  };
}

export function endChatRunNativeMessage(
  registry: ChatRunRegistry,
  chatId: string,
  requestId: string,
): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId) return registry;
  return { ...registry, [chatId]: { ...current, nativeStreamId: null } };
}

export function finishChatRun(registry: ChatRunRegistry, chatId: string, requestId: string): ChatRunRegistry {
  const current = registry[chatId];
  if (!current || current.requestId !== requestId) return registry;
  const next = { ...registry };
  delete next[chatId];
  return next;
}

export function chatIdForRequest(registry: ChatRunRegistry, requestId?: string): string | null {
  if (!requestId) return null;
  return Object.values(registry).find((run) => run.requestId === requestId)?.chatId || null;
}

export function requestIdsForChats(registry: ChatRunRegistry, chatIds: Iterable<string>): string[] {
  const ownedChats = new Set(chatIds);
  return Object.values(registry)
    .filter((run) => ownedChats.has(run.chatId))
    .map((run) => run.requestId);
}

export function shouldApplyChatRunResult(registry: ChatRunRegistry, chatId: string, requestId: string) {
  return registry[chatId]?.requestId === requestId;
}
