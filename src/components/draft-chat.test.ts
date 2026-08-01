import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '../providers/types';
import {
  activeProjectFolderId,
  chatFromVisibleOrDraft,
  createDraftChat,
  draftChatForFolder,
  isCollapsedProjectActive,
} from './draft-chat';

const chat = (id: string, folderId: string | null = null): Chat => ({
  id,
  title: 'Nieuw gesprek',
  folderId,
  createdAt: '2026-07-26T10:00:00.000Z',
  updatedAt: '2026-07-26T10:00:00.000Z',
});

describe('conceptgesprekken', () => {
  it('hergebruikt één onzichtbaar concept per projectscope', () => {
    const drafts = [chat('los'), chat('project-a', 'folder-a')];
    expect(draftChatForFolder(drafts)?.id).toBe('los');
    expect(draftChatForFolder(drafts, 'folder-a')?.id).toBe('project-a');
    expect(draftChatForFolder(drafts, 'folder-b')).toBeNull();
  });

  it('vindt een open concept zonder het aan de zichtbare chatlijst toe te voegen', () => {
    expect(chatFromVisibleOrDraft([chat('echt')], [chat('concept')], 'concept')?.id).toBe('concept');
  });

  it('houdt het actieve project vast voor zichtbare én verborgen gesprekken', () => {
    expect(activeProjectFolderId([chat('echt', 'project-a')], [], 'echt')).toBe('project-a');
    expect(activeProjectFolderId([], [chat('concept', 'project-b')], 'concept')).toBe('project-b');
    expect(activeProjectFolderId([], [chat('los')], 'los')).toBeNull();
  });

  it('selecteert de projectkop alleen wanneer de actieve projectmap dichtgeklapt is', () => {
    expect(isCollapsedProjectActive('project-a', 'project-a', true)).toBe(true);
    expect(isCollapsedProjectActive('project-a', 'project-a', false)).toBe(false);
    expect(isCollapsedProjectActive('project-a', 'project-b', true)).toBe(false);
  });

  it('maakt een lokaal concept met dezelfde folder voor latere materialisatie', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'draft-id' });
    expect(createDraftChat('Nieuw gesprek', 'folder-a', 'nu')).toEqual({
      id: 'draft-id',
      title: 'Nieuw gesprek',
      folderId: 'folder-a',
      createdAt: 'nu',
      updatedAt: 'nu',
    });
    vi.unstubAllGlobals();
  });
});
