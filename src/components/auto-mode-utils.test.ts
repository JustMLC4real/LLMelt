import { describe, expect, it } from 'vitest';
import type { AutoModeConfig } from '../providers/types';
import {
  autoModePhaseInfo,
  autoModePromptPreview,
  autoModeStepState,
  buildAutoModePrompterSystemPrompt,
  mergeAutoModeState,
  parseAutoModePrompterDecision,
  validateAutoModeConfig,
} from './auto-mode-utils';

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

describe('Auto Mode-voltooiingscontract', () => {
  it('stopt alleen bij een volledig gesloten voltooiingstag', () => {
    expect(parseAutoModePrompterDecision(
      '<AUTO_MODE_COMPLETE>Alle gevraagde bestanden zijn gemaakt en getest.</AUTO_MODE_COMPLETE>',
    )).toEqual({
      status: 'complete',
      summary: 'Alle gevraagde bestanden zijn gemaakt en getest.',
    });
    expect(parseAutoModePrompterDecision('Het werk is complete, controleer nu de tests.')).toEqual({
      status: 'continue',
      prompt: 'Het werk is complete, controleer nu de tests.',
    });
    expect(parseAutoModePrompterDecision('<AUTO_MODE_COMPLETE>nog niet gesloten')).toEqual({
      status: 'continue',
      prompt: '<AUTO_MODE_COMPLETE>nog niet gesloten',
    });
  });

  it('haalt de volgende prompt uit een providerneutrale tag', () => {
    expect(parseAutoModePrompterDecision(
      '  <AUTO_MODE_NEXT>\nVoer nu de integratietests uit en herstel alle fouten.\n</AUTO_MODE_NEXT>  ',
    )).toEqual({
      status: 'continue',
      prompt: 'Voer nu de integratietests uit en herstel alle fouten.',
    });
  });

  it('blijft compatibel met modellen die nog gewone prompttekst teruggeven', () => {
    expect(parseAutoModePrompterDecision('Maak nu het ontbrekende rapport.')).toEqual({
      status: 'continue',
      prompt: 'Maak nu het ontbrekende rapport.',
    });
  });

  it('instrueert elk promptermodel om voortgang te controleren en exact één contracttag te gebruiken', () => {
    const nl = buildAutoModePrompterSystemPrompt('Bouw en test de app.', 'nl');
    const en = buildAutoModePrompterSystemPrompt('Build and test the app.', 'en');
    expect(nl).toContain('<AUTO_MODE_COMPLETE>');
    expect(nl).toContain('<AUTO_MODE_NEXT>');
    expect(nl).toContain('<USER_GOAL>\nBouw en test de app.\n</USER_GOAL>');
    expect(en).toMatch(/evaluate the entire conversation/i);
  });
});
