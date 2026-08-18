import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AttachmentRef, Chat, CommandRun, Message, Folder, MemoryEntry, ModelRunConfig, ProviderType, ToolActivityPhase } from '../providers/types';
import { normalizeLegacyModelId } from '../providers/model-ref-normalization';
import { appendLiveToolRunOutput, removeLiveToolRuns, upsertLiveToolActivity, upsertLiveToolRun, type LiveToolActivity, type LiveToolRun } from '../components/command-run-utils';
import {
  appendChatRunContent as appendRunContent,
  appendChatRunNativeMessage as appendRunNativeMessage,
  endChatRunNativeMessage as endRunNativeMessage,
  finishChatRun as finishRun,
  setChatRunModel as setRunModel,
  setChatRunStatus as setRunStatus,
  startChatRun as startRun,
  startChatRunNativeMessage as startRunNativeMessage,
  type ChatRunRegistry,
} from '../components/chat-run-state';
import { removeChatScopedLists, removeItemsOwnedByRequest, setMembership, shouldApplyChatResult, updateChatScopedList, type ChatScopedLists } from '../components/chat-scope';
import { chatFromVisibleOrDraft } from '../components/draft-chat';
import { reconcilePersistedUserMessage } from '../components/message-sync';

interface ChatState {
  // Current state
  chats: Chat[];
  // Nog niet verzonden gesprekken leven alleen lokaal en staan bewust niet in
  // de sidebar/tray/SQLite. Bij de eerste verzending verhuizen ze naar `chats`.
  draftChats: Chat[];
  currentChatId: string | null;
  messages: Message[];
  folders: Folder[];
  memories: MemoryEntry[];
  
  // UI state
  // Elke chat houdt zijn eigen lopende verzoek en stream bij. Daardoor blijft een
  // achtergrondbeurt aan zijn oorspronkelijke gesprek gekoppeld na een chatwissel.
  chatRuns: ChatRunRegistry;
  sidebarCollapsed: boolean;
  currentView: 'chat' | 'settings' | 'tokens' | 'keyChecker';
  generatingTitleChatIds: string[];
  // Wordt true zodra de eerste DB-load klaar is. Vóór dat moment mogen chats/mappen
  // niet als "nieuw" animeren (anders animeert de hele lijst bij het opstarten).
  chatsHydrated: boolean;
  // Onverzonden invoer per chat, zodat je concept bewaard blijft bij wisselen.
  messageDrafts: Record<string, string>;
  pendingAttachmentsByChat: ChatScopedLists<AttachmentRef>;

  // Agent terminal panel
  showTerminal: boolean;
  terminalLaunchRequest?: { id: string; providerCli: 'codex' | 'claude' | 'antigravity' };
  terminalLines: { type: 'cmd' | 'out' | 'err' | 'exit'; text: string }[];
  liveToolRuns: LiveToolRun[];
  liveToolActivities: LiveToolActivity[];

  // Model selection
  activeModelId: string;
  activeProvider: ProviderType;
  activeRunConfig?: ModelRunConfig;
  // Last pick per composite surface, so each card (Codex / ChatGPT) remembers its
  // own last choice regardless of which one is currently active.
  lastChatgptRef?: { modelId: string; runConfig?: ModelRunConfig };
  lastCodexRef?: { modelId: string; runConfig?: ModelRunConfig };

  // System prompt
  systemPrompt: string;
  showSystemPromptEditor: boolean;
  
  // Actions
  setChats: (chats: Chat[]) => void;
  setCurrentChat: (chatId: string | null) => void;
  addChat: (chat: Chat) => void;
  addDraftChat: (chat: Chat) => void;
  materializeDraftChat: (chat: Chat) => void;
  updateChat: (id: string, data: Partial<Chat>) => void;
  removeChat: (id: string) => void;
  
  setMessagesForChat: (chatId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  confirmPersistedUserMessage: (chatId: string, requestId: string, message: Message) => void;
  updateMessage: (id: string, content: string) => void;
  removeMessage: (id: string) => void;
  
  setFolders: (folders: Folder[]) => void;
  addFolder: (folder: Folder) => void;
  updateFolder: (id: string, data: Partial<Folder>) => void;
  removeFolder: (id: string) => void;
  
  setMemories: (memories: MemoryEntry[]) => void;
  addMemory: (memory: MemoryEntry) => void;
  updateMemory: (id: string, data: Partial<MemoryEntry>) => void;
  removeMemory: (id: string) => void;
  
  startChatRun: (run: { chatId: string; requestId: string; modelId: string; provider: ProviderType; runConfig?: ModelRunConfig; status?: string }) => void;
  setChatRunStatus: (chatId: string, requestId: string, status: string) => void;
  appendChatRunContent: (chatId: string, requestId: string, delta: string) => void;
  setChatRunModel: (chatId: string, requestId: string, model: { modelId: string; provider: ProviderType; runConfig?: ModelRunConfig }) => void;
  startChatRunNativeMessage: (chatId: string, requestId: string, message: Message) => void;
  appendChatRunNativeMessage: (chatId: string, requestId: string, messageId: string, delta: string) => void;
  endChatRunNativeMessage: (chatId: string, requestId: string) => void;
  finishChatRun: (chatId: string, requestId: string) => void;
  
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setCurrentView: (view: 'chat' | 'settings' | 'tokens' | 'keyChecker') => void;
  setTitleGenerating: (chatId: string, generating: boolean) => void;
  setChatsHydrated: (value: boolean) => void;
  setMessageDraft: (chatId: string, text: string) => void;
  setPendingAttachmentsForChat: (chatId: string, update: AttachmentRef[] | ((current: AttachmentRef[]) => AttachmentRef[])) => void;
  toggleTerminal: () => void;
  setShowTerminal: (show: boolean) => void;
  openProviderTerminal: (providerCli: 'codex' | 'claude' | 'antigravity') => void;
  clearTerminalLaunchRequest: () => void;
  appendTerminalLine: (line: { type: 'cmd' | 'out' | 'err' | 'exit'; text: string }) => void;
  clearTerminal: () => void;
  upsertLiveToolRun: (run: CommandRun, meta: { chatId: string; requestId?: string; anchorMessageId?: string }) => void;
  appendLiveToolRunOutput: (meta: { chatId: string; requestId?: string }, runId: string, stream: 'stdout' | 'stderr', delta: string) => void;
  upsertLiveToolActivity: (activity: {
    id: string;
    chatId: string;
    requestId?: string;
    anchorMessageId?: string;
    phase: ToolActivityPhase;
    label: string;
    detail?: string;
    approvalStatus?: 'pending' | 'approved' | 'denied';
    attempt?: number;
    stopReason?: string;
    tone?: 'running' | 'ok' | 'failed' | 'denied';
  }) => void;
  clearLiveToolRuns: (runIds?: string[], chatId?: string) => void;
  clearLiveToolStateForChat: (chatId: string, requestId?: string) => void;
  
  setActiveModel: (modelId: string, provider: ProviderType, runConfig?: ModelRunConfig) => void;
  setActiveRunConfig: (runConfig?: ModelRunConfig) => void;
  setSystemPrompt: (prompt: string) => void;
  setShowSystemPromptEditor: (show: boolean) => void;
}

export const useChatStore = create<ChatState>()(persist((set) => ({
  // Initial state
  chats: [],
  draftChats: [],
  currentChatId: null,
  messages: [],
  folders: [],
  memories: [],
  
  chatRuns: {},
  sidebarCollapsed: false,
  currentView: 'chat',
  generatingTitleChatIds: [],
  chatsHydrated: false,
  messageDrafts: {},
  pendingAttachmentsByChat: {},
  showTerminal: false,
  terminalLaunchRequest: undefined,
  terminalLines: [],
  liveToolRuns: [],
  liveToolActivities: [],
  
  activeModelId: '',
  activeProvider: 'codex',
  activeRunConfig: undefined,
  
  systemPrompt: '',
  showSystemPromptEditor: false,
  
  // Chat actions
  setChats: (chats) => set((state) => {
    const visibleIds = new Set(chats.map((chat) => chat.id));
    return {
      chats,
      // Als de app precies tussen DB-insert en renderer-update sloot, wint de
      // echte DB-chat en verdwijnt het lokale dubbelconcept bij de volgende start.
      draftChats: state.draftChats.filter((chat) => !visibleIds.has(chat.id)),
    };
  }),
  setCurrentChat: (chatId) => set((state) => {
    // Re-selecting the chat you're already on must not wipe its messages. Clearing
    // messages here while currentChatId is unchanged means the reload effect (keyed
    // on currentChatId) never refires, leaving the chat blank.
    if (chatId && chatId === state.currentChatId) return {} as Partial<typeof state>;
    const chat = chatFromVisibleOrDraft(state.chats, state.draftChats, chatId);
    const normalized = normalizeChatModel(chat?.activeProvider || undefined, chat?.activeModelId || undefined);
    // Restore the chat's own saved runConfig (e.g. ChatGPT Inspanning). If the chat
    // has none yet but it's the same model we're already on, keep the live one so
    // the effort isn't silently reset to default.
    const sameModel =
      normalized &&
      normalized.activeProvider === state.activeProvider &&
      normalized.activeModelId === state.activeModelId;
    let runConfigOverride: ModelRunConfig | undefined | null = undefined;
    if (chat?.activeRunConfig) runConfigOverride = chat.activeRunConfig;
    else if (sameModel) runConfigOverride = state.activeRunConfig;
    return {
      currentChatId: chatId,
      systemPrompt: chat?.systemPrompt || '',
      messages: [],
      ...(normalized || {}),
      ...(runConfigOverride !== undefined ? { activeRunConfig: runConfigOverride || undefined } : {}),
    };
  }),
  addChat: (chat) => set((state) => ({ chats: [chat, ...state.chats] })),
  addDraftChat: (chat) => set((state) => (
    state.draftChats.some((candidate) => candidate.id === chat.id)
      ? {}
      : { draftChats: [chat, ...state.draftChats] }
  )),
  materializeDraftChat: (chat) => set((state) => ({
    draftChats: state.draftChats.filter((candidate) => candidate.id !== chat.id),
    chats: state.chats.some((candidate) => candidate.id === chat.id)
      ? state.chats.map((candidate) => candidate.id === chat.id ? { ...candidate, ...chat } : candidate)
      : [chat, ...state.chats],
  })),
  updateChat: (id, data) => set((state) => ({
    chats: state.chats.map(c => c.id === id ? { ...c, ...data } : c),
    draftChats: state.draftChats.map(c => c.id === id ? { ...c, ...data } : c),
  })),
  removeChat: (id) => set((state) => {
    const messageDrafts = { ...state.messageDrafts };
    const chatRuns = { ...state.chatRuns };
    delete messageDrafts[id];
    delete chatRuns[id];
    return {
      chats: state.chats.filter(c => c.id !== id),
      draftChats: state.draftChats.filter(c => c.id !== id),
      currentChatId: state.currentChatId === id ? null : state.currentChatId,
      messageDrafts,
      pendingAttachmentsByChat: removeChatScopedLists(state.pendingAttachmentsByChat, [id]),
      chatRuns,
      generatingTitleChatIds: state.generatingTitleChatIds.filter((chatId) => chatId !== id),
    };
  }),
  
  // Message actions
  setMessagesForChat: (chatId, messages) => set((state) => (
    shouldApplyChatResult(state.currentChatId, chatId) ? { messages } : {}
  )),
  addMessage: (message) => set((state) => (
    shouldApplyChatResult(state.currentChatId, message.chatId)
      ? { messages: [...state.messages, message] }
      : {}
  )),
  confirmPersistedUserMessage: (chatId, requestId, message) => set((state) => (
    shouldApplyChatResult(state.currentChatId, chatId)
      ? { messages: reconcilePersistedUserMessage(state.messages, chatId, requestId, message) }
      : {}
  )),
  updateMessage: (id, content) => set((state) => ({
    messages: state.messages.map(m => m.id === id ? { ...m, content } : m),
  })),
  removeMessage: (id) => set((state) => ({
    messages: state.messages.filter(m => m.id !== id),
  })),
  
  // Folder actions
  setFolders: (folders) => set({ folders }),
  addFolder: (folder) => set((state) => ({ folders: [...state.folders, folder] })),
  updateFolder: (id, data) => set((state) => ({
    folders: state.folders.map(f => f.id === id ? { ...f, ...data } : f),
  })),
  removeFolder: (id) => set((state) => {
    // Een project verwijderen wist ook z'n gesprekken (zie db:deleteFolder).
    // Spiegel dat hier exact, anders loopt de zijbalk uit de pas met de database.
    const doomed = new Set(
      [...state.chats, ...state.draftChats]
        .filter(c => c.folderId === id)
        .map(c => c.id),
    );
    const messageDrafts = { ...state.messageDrafts };
    const chatRuns = { ...state.chatRuns };
    doomed.forEach((chatId) => { delete messageDrafts[chatId]; });
    doomed.forEach((chatId) => { delete chatRuns[chatId]; });
    return {
      folders: state.folders.filter(f => f.id !== id),
      chats: state.chats.filter(c => !doomed.has(c.id)),
      draftChats: state.draftChats.filter(c => !doomed.has(c.id)),
      currentChatId: state.currentChatId && doomed.has(state.currentChatId) ? null : state.currentChatId,
      messageDrafts,
      pendingAttachmentsByChat: removeChatScopedLists(state.pendingAttachmentsByChat, doomed),
      chatRuns,
      generatingTitleChatIds: state.generatingTitleChatIds.filter((chatId) => !doomed.has(chatId)),
    };
  }),
  
  // Memory actions
  setMemories: (memories) => set({ memories }),
  addMemory: (memory) => set((state) => ({ memories: [...state.memories, memory] })),
  updateMemory: (id, data) => set((state) => ({
    memories: state.memories.map(m => m.id === id ? { ...m, ...data } : m),
  })),
  removeMemory: (id) => set((state) => ({
    memories: state.memories.filter(m => m.id !== id),
  })),
  
  // UI actions
  startChatRun: (run) => set((state) => ({ chatRuns: startRun(state.chatRuns, run) })),
  setChatRunStatus: (chatId, requestId, status) => set((state) => ({
    chatRuns: setRunStatus(state.chatRuns, chatId, requestId, status),
  })),
  appendChatRunContent: (chatId, requestId, delta) => set((state) => ({
    chatRuns: appendRunContent(state.chatRuns, chatId, requestId, delta),
  })),
  setChatRunModel: (chatId, requestId, model) => set((state) => ({
    chatRuns: setRunModel(state.chatRuns, chatId, requestId, model),
  })),
  startChatRunNativeMessage: (chatId, requestId, message) => set((state) => ({
    chatRuns: startRunNativeMessage(state.chatRuns, chatId, requestId, message),
  })),
  appendChatRunNativeMessage: (chatId, requestId, messageId, delta) => set((state) => ({
    chatRuns: appendRunNativeMessage(state.chatRuns, chatId, requestId, messageId, delta),
  })),
  endChatRunNativeMessage: (chatId, requestId) => set((state) => ({
    chatRuns: endRunNativeMessage(state.chatRuns, chatId, requestId),
  })),
  finishChatRun: (chatId, requestId) => set((state) => ({
    chatRuns: finishRun(state.chatRuns, chatId, requestId),
  })),
  
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setCurrentView: (view) => set({ currentView: view }),
  setTitleGenerating: (chatId, generating) => set((state) => ({
    generatingTitleChatIds: setMembership(state.generatingTitleChatIds, chatId, generating),
  })),
  setChatsHydrated: (value) => set({ chatsHydrated: value }),
  setMessageDraft: (chatId, text) => set((state) => {
    const current = state.messageDrafts[chatId] ?? '';
    if (current === text) return {} as Partial<typeof state>;
    const next = { ...state.messageDrafts };
    if (text) next[chatId] = text; else delete next[chatId];
    return { messageDrafts: next };
  }),
  setPendingAttachmentsForChat: (chatId, update) => set((state) => ({
    pendingAttachmentsByChat: updateChatScopedList(state.pendingAttachmentsByChat, chatId, update),
  })),
  toggleTerminal: () => set((state) => ({ showTerminal: !state.showTerminal })),
  setShowTerminal: (show) => set({ showTerminal: show }),
  openProviderTerminal: (providerCli) => set({
    showTerminal: true,
    terminalLaunchRequest: { id: crypto.randomUUID(), providerCli },
  }),
  clearTerminalLaunchRequest: () => set({ terminalLaunchRequest: undefined }),
  appendTerminalLine: (line) => set((state) => ({ terminalLines: [...state.terminalLines, line].slice(-600) })),
  clearTerminal: () => set({ terminalLines: [] }),
  upsertLiveToolRun: (run, meta) => set((state) => ({
    liveToolRuns: upsertLiveToolRun(state.liveToolRuns, {
      ...meta,
      run,
      updatedAt: new Date().toISOString(),
    }),
  })),
  appendLiveToolRunOutput: (meta, runId, stream, delta) => set((state) => ({
    liveToolRuns: appendLiveToolRunOutput(state.liveToolRuns, meta, runId, stream, delta, new Date().toISOString()),
  })),
  upsertLiveToolActivity: (activity) => set((state) => ({
    liveToolActivities: upsertLiveToolActivity(state.liveToolActivities, {
      ...activity,
      updatedAt: new Date().toISOString(),
    }),
  })),
  clearLiveToolRuns: (runIds, chatId) => set((state) => ({
    liveToolRuns: runIds?.length ? removeLiveToolRuns(state.liveToolRuns, new Set(runIds), chatId) : [],
    liveToolActivities: runIds?.length ? state.liveToolActivities : [],
  })),
  clearLiveToolStateForChat: (chatId, requestId) => set((state) => ({
    liveToolRuns: removeItemsOwnedByRequest(state.liveToolRuns, chatId, requestId),
    liveToolActivities: removeItemsOwnedByRequest(state.liveToolActivities, chatId, requestId),
  })),
  
  setActiveModel: (modelId, provider, runConfig) => set(() => {
    const next: Partial<ChatState> = { activeModelId: modelId, activeProvider: provider, activeRunConfig: runConfig };
    // Remember the last pick per composite surface so each card keeps its own choice.
    if (provider === 'codex') next.lastCodexRef = { modelId, runConfig };
    else if (provider === 'openai' && modelId.startsWith('chatgpt:')) next.lastChatgptRef = { modelId, runConfig };
    return next;
  }),
  setActiveRunConfig: (runConfig) => set({ activeRunConfig: runConfig }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),
  setShowSystemPromptEditor: (show) => set({ showSystemPromptEditor: show }),
}), {
  name: 'superapp-chat',
  storage: createJSONStorage(() => localStorage),
  // Persist ONLY the last model selection (incl. ChatGPT stand/effort) — not the
  // transient chat/message/streaming state. So your choice survives a restart.
  partialize: (state) => ({
    activeModelId: state.activeModelId,
    activeProvider: state.activeProvider,
    activeRunConfig: state.activeRunConfig,
    lastChatgptRef: state.lastChatgptRef,
    lastCodexRef: state.lastCodexRef,
    messageDrafts: state.messageDrafts,
    draftChats: state.draftChats,
  }),
  version: 3,
  migrate: (persistedState: any) => {
    if (persistedState && typeof persistedState === 'object') delete persistedState.systemPrompt;
    return persistedState;
  },
}));

function normalizeChatModel(provider?: ProviderType | null, modelId?: string | null) {
  if (!provider || !modelId) return null;
  if (provider !== 'codex') {
    return { activeProvider: provider, activeModelId: modelId, activeRunConfig: undefined };
  }

  const normalized = normalizeLegacyModelId(provider, modelId);

  return {
    activeProvider: provider,
    activeModelId: normalized.modelId,
    activeRunConfig: normalized.runConfig,
  };
}
