import type { UiLanguage } from '../providers/types';
import { localizedText } from '../i18n/language';

export type AgentApprovalKind = 'file-read' | 'file-create' | 'file-edit' | 'command';

export interface AgentApprovalRequest {
  id: string;
  command: string;
  cwd: string;
  shell?: string;
  kind?: AgentApprovalKind;
  label?: string;
  path?: string;
  chatId?: string;
  requestId?: string;
}

export interface QueuedAgentApproval extends AgentApprovalRequest {
  deferred: boolean;
}

export function enqueueAgentApproval(
  queue: QueuedAgentApproval[],
  request: AgentApprovalRequest,
  activeChatId?: string | null,
): QueuedAgentApproval[] {
  if (queue.some((approval) => approval.id === request.id)) return queue;
  const belongsToBackgroundChat = !!request.chatId && activeChatId !== undefined && request.chatId !== activeChatId;
  return [...queue, { ...request, deferred: belongsToBackgroundChat }];
}

export function deferAgentApproval(queue: QueuedAgentApproval[], id: string): QueuedAgentApproval[] {
  let changed = false;
  const next = queue.map((approval) => {
    if (approval.id !== id || approval.deferred) return approval;
    changed = true;
    return { ...approval, deferred: true };
  });
  return changed ? next : queue;
}

export function removeAgentApproval(queue: QueuedAgentApproval[], id: string): QueuedAgentApproval[] {
  if (!queue.some((approval) => approval.id === id)) return queue;
  return queue.filter((approval) => approval.id !== id);
}

export function deferAgentApprovalsOutsideChat(
  queue: QueuedAgentApproval[],
  activeChatId: string | null,
): QueuedAgentApproval[] {
  let changed = false;
  const next = queue.map((approval) => {
    if (approval.deferred || !approval.chatId || approval.chatId === activeChatId) return approval;
    changed = true;
    return { ...approval, deferred: true };
  });
  return changed ? next : queue;
}

export function nextModalAgentApproval(
  queue: QueuedAgentApproval[],
  activeChatId?: string | null,
): QueuedAgentApproval | null {
  return queue.find((approval) => (
    !approval.deferred
    && (activeChatId === undefined || !approval.chatId || approval.chatId === activeChatId)
  )) || null;
}

export function deferredAgentApprovalsForChat(
  queue: QueuedAgentApproval[],
  chatId: string | null,
): QueuedAgentApproval[] {
  if (!chatId) return [];
  return queue.filter((approval) => approval.deferred && (!approval.chatId || approval.chatId === chatId));
}

export function approvalTitle(approval?: AgentApprovalRequest | null, language: UiLanguage = 'nl'): string {
  if (approval?.label) return approval.label;
  if (approval?.kind === 'file-read') return localizedText(language, 'Bestand lezen', 'Read file');
  if (approval?.kind === 'file-create') return localizedText(language, 'Bestand maken', 'Create file');
  if (approval?.kind === 'file-edit') return localizedText(language, 'Bestand wijzigen', 'Edit file');
  return localizedText(language, 'Commando uitvoeren', 'Run command');
}
