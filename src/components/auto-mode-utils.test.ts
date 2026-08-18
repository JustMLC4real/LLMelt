import { describe, expect, it } from 'vitest';
import type { AutoModeConfig } from '../providers/types';
import { autoModePhaseInfo, autoModePromptPreview, autoModeStepState, mergeAutoModeState, validateAutoModeConfig } from './auto-mode-utils';

const valid: AutoModeConfig = {
  chatId: 'chat-1',
  prompterModelRef: { provider: 'codex', modelId: 'a' },
  responderModelRef: { provider: 'ollama', modelId: 'b' },
  maxIterations: 5,
  delayMs: 2_000,
  tokenBudget: 10_000,
};

describe('Auto Mode-validatie', () => {
  it('accepteert begrensde en expliciet oneindige configuraties', () => {
    expect(() => validateAutoModeConfig(valid)).not.toThrow();
    expect(() => validateAutoModeConfig({ ...valid, maxIterations: 0 })).not.toThrow();
  });

  it('weigert extreme iteraties, timing en budgetten', () => {
    expect(() => validateAutoModeConfig({ ...valid, maxIterations: 1001 })).toThrow();
    expect(() => validateAutoModeConfig({ ...valid, delayMs: 0 })).toThrow();
    expect(() => validateAutoModeConfig({ ...valid, tokenBudget: -1 })).toThrow();
  });

  it('onderscheidt zichtbaar prompt maken, antwoorden en wachten', () => {
    expect(autoModePhaseInfo('prompter').title).toMatch(/prompter.*prompt/i);
    expect(autoModePhaseInfo('responder').title).toMatch(/antwoordmodel/i);
    expect(autoModePhaseInfo('waiting').label).toBe('Wachten');
    expect(autoModeStepState('prompter', 0)).toBe('active');
    expect(autoModeStepState('responder', 0)).toBe('done');
    expect(autoModeStepState('responder', 1)).toBe('active');
    expect(autoModeStepState('completed', 2)).toBe('done');
  });

  it('bewaart fasegegevens, fout en een compacte promptpreview in de runtime-state', () => {
    const initial = { status: 'running' as const, phase: 'starting' as const, iteration: 0, totalTokens: 0, maxIterations: 2 };
    const next = mergeAutoModeState(initial, { phase: 'prompter', detail: 'Prompt wordt gemaakt.' }, () => '2026-07-18T12:00:00.000Z');
    expect(next).toMatchObject({ phase: 'prompter', phaseStartedAt: '2026-07-18T12:00:00.000Z', detail: 'Prompt wordt gemaakt.' });
    expect(autoModePromptPreview('  Maak\n\n een   testprompt.  ')).toBe('Maak een testprompt.');
    expect(autoModePromptPreview('x'.repeat(700))).toHaveLength(600);
  });
});

describe('Auto Mode-taal', () => {
  it('levert Engelse validatie en fasetekst', () => {
    expect(autoModePhaseInfo('waiting', 'en')).toMatchObject({ label: 'Waiting', title: 'Round completed' });
    expect(() => validateAutoModeConfig({ ...valid, language: 'en', delayMs: 0 })).toThrow(/delay must be between/i);
  });
});
