import i18n from '../i18n';
import type { Chat } from '../providers/types';
import { useChatStore } from '../stores/chat-store';
import { requestComposerFocus } from './composer-focus';
import { chatFromVisibleOrDraft, createDraftChat, draftChatForFolder } from './draft-chat';

const materializationByChatId = new Map<string, Promise<Chat>>();

/**
 * Open één lokaal concept in de opgegeven map (of los als folderId leeg is).
 * Het concept staat nog niet in SQLite/sidebar/tray. Een tweede klik keert terug
 * naar hetzelfde concept, zodat onverzonden tekst nooit een rij lege gesprekken
 * veroorzaakt en ook niet verloren gaat.
 */
export async function startNewChat(folderId?: string | null): Promise<Chat> {
  const store = useChatStore.getState();
  const title = i18n.t('chat.emptyTitle');
  const chat = draftChatForFolder(store.draftChats, folderId)
    || createDraftChat(title, folderId);
  store.addDraftChat(chat);
  store.setCurrentChat(chat.id);
  store.setCurrentView('chat');
  requestComposerFocus();
  return chat;
}

export function isDraftChatId(chatId?: string | null) {
  return !!chatId && useChatStore.getState().draftChats.some((chat) => chat.id === chatId);
}

/**
 * Maak een concept atomair zichtbaar vlak vóór de eerste echte actie. De client-id
 * blijft gelijk, zodat concepttekst, bijlagen, request-routing en focus niet hoeven
 * te verhuizen naar een nieuw chat-id.
 */
export async function ensureChatMaterialized(chatId: string): Promise<Chat> {
  const pending = materializationByChatId.get(chatId);
  if (pending) return pending;

  const materialization = materializeDraftChat(chatId);
  materializationByChatId.set(chatId, materialization);
  try {
    return await materialization;
  } finally {
    materializationByChatId.delete(chatId);
  }
}

async function materializeDraftChat(chatId: string): Promise<Chat> {
  const store = useChatStore.getState();
  const existing = store.chats.find((chat) => chat.id === chatId);
  if (existing) return existing;
  const draft = store.draftChats.find((chat) => chat.id === chatId);
  if (!draft) throw new Error(`Conceptgesprek niet gevonden: ${chatId}`);

  let chat = { ...draft };
  if (window.electronAPI) {
    chat = await window.electronAPI.db.createChat(
      draft.title,
      draft.folderId || undefined,
      draft.id,
    );
    const localSystemPrompt = store.currentChatId === chatId ? store.systemPrompt : draft.systemPrompt;
    if (localSystemPrompt || draft.agentMode || draft.activeModelId) {
      try {
        chat = await window.electronAPI.db.updateChat(chatId, {
          systemPrompt: localSystemPrompt || null,
          agentMode: draft.agentMode || null,
          activeModelId: draft.activeModelId || null,
          activeProvider: draft.activeProvider || null,
          activeRunConfig: draft.activeRunConfig || null,
        }) || chat;
      } catch (error) {
        // De chat zelf bestaat al. Laat een niet-kritieke voorkeursupdate geen
        // tweede INSERT met dezelfde client-id veroorzaken; het bericht draagt
        // model en systeemprompt bovendien zelf mee.
        console.warn('Conceptvoorkeuren konden niet direct worden opgeslagen:', error);
      }
    }
  }
  store.materializeDraftChat(chat);
  return chat;
}

/**
 * De map waarin je "voor het laatst werkte": de map van het open gesprek, anders
 * die van het meest recente gesprek. Zo opent een nieuw gesprek vanuit de tray in
 * hetzelfde project i.p.v. altijd los.
 */
export function lastUsedFolderId(): string | null {
  const store = useChatStore.getState();
  const folderIds = new Set(store.folders.map((folder) => folder.id));
  const current = chatFromVisibleOrDraft(store.chats, store.draftChats, store.currentChatId);
  const candidate = current?.folderId ?? store.chats[0]?.folderId ?? null;
  // Verweesde folderId (map bestaat niet meer) telt als "los".
  return candidate && folderIds.has(candidate) ? candidate : null;
}
