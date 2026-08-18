import { describe, expect, it } from 'vitest';
import {
  collaborationModesFromResponse,
  formatPlanUpdate,
  skillsFromResponse,
} from '../electron/codex-app-server';

describe('Codex App Server protocolhelpers', () => {
  it('neemt collaboration modes rechtstreeks uit de live response over', () => {
    expect(collaborationModesFromResponse({
      data: [{ name: 'Plan', mode: 'plan', reasoning_effort: 'medium' }],
    })).toEqual([{ name: 'Plan', mode: 'plan', reasoningEffort: 'medium' }]);
  });

  it('neemt alleen ingeschakelde native skills over', () => {
    expect(skillsFromResponse({
      data: [{ skills: [
        { name: 'docs', description: 'Documenten', path: 'C:\\skills\\docs.md', enabled: true },
        { name: 'uit', path: 'C:\\skills\\uit.md', enabled: false },
      ] }],
    })).toEqual([{ name: 'docs', description: 'Documenten', path: 'C:\\skills\\docs.md' }]);
  });

  it('maakt een native plan-event zichtbaar als antwoordtekst', () => {
    expect(formatPlanUpdate({
      explanation: 'Korte aanpak',
      plan: [{ step: 'Lees de context', status: 'pending' }, { step: 'Geef antwoord', status: 'pending' }],
    })).toBe('Korte aanpak\n\n1. Lees de context\n\n2. Geef antwoord');
  });
});
