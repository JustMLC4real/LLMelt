import type { Chat } from '../providers/types';

export function normalizedDraftFolderId(folderId?: string | null) {
  return folderId || null;
}

export function draftChatForFolder(drafts: Chat[], folderId?: string | null) {
  const scope = normalizedDraftFolderId(folderId);
  return drafts.find((chat) => normalizedDraftFolderId(chat.folderId) === scope) || null;
}

export function createDraftChat(title: string, folderId?: string | null, now = new Date().toISOString()): Chat {
  return {
    id: crypto.randomUUID(),
    title,
    folderId: normalizedDraftFolderId(folderId),
    createdAt: now,
    updatedAt: now,
  };
}

export function chatFromVisibleOrDraft(chats: Chat[], drafts: Chat[], chatId?: string | null) {
  if (!chatId) return undefined;
  return chats.find((chat) => chat.id === chatId) || drafts.find((chat) => chat.id === chatId);
}

/**
 * Een project blijft de actieve context, ook als het huidige gesprek nog een
 * onzichtbaar concept is of als de projectmap in de zijbalk is ingeklapt.
 */
export function activeProjectFolderId(chats: Chat[], drafts: Chat[], chatId?: string | null) {
  return chatFromVisibleOrDraft(chats, drafts, chatId)?.folderId || null;
}

/**
 * Een open project toont de selectie op de actieve chatrij. Alleen wanneer de
 * chats verborgen zijn neemt de projectkop die selectie over.
 */
export function isCollapsedProjectActive(
  activeFolderId: string | null,
  folderId: string,
  collapsed: boolean,
) {
  return collapsed && activeFolderId === folderId;
}
