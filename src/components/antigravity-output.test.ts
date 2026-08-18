import { describe, expect, it } from 'vitest';
import { antigravityFinalTranscriptText, antigravityPartialSummary } from '../../electron/antigravity-output';

describe('Antigravity output recovery', () => {
  it('recovers the last real model answer from a transcript', () => {
    const transcript = [
      JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'eerder', tool_calls: [] }),
      JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', thinking: 'tool plannen', tool_calls: [{ name: 'write_to_file' }] }),
      JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Klaar.', tool_calls: [] }),
    ].join('\n');
    expect(antigravityFinalTranscriptText(transcript)).toBe('Klaar.');
  });

  it('does not mistake a tool-planning row for an end answer', () => {
    const transcript = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Ik ga schrijven.',
      tool_calls: [{ name: 'write_to_file' }],
    });
    expect(antigravityFinalTranscriptText(transcript)).toBe('');
  });

  it('reports partial completion without presenting it as a provider crash', () => {
    expect(antigravityPartialSummary(1, 1, 0, 1)).toBe(
      'Antigravity leverde geen apart eindantwoord; 1 toolactie is afgerond, 1 toolactie heeft geen bevestigd resultaat. Controleer de mislukte toolkaart(en) voordat je verdergaat.',
    );
  });

  it('reports partial completion in English-mode', () => {
    expect(antigravityPartialSummary(1, 1, 0, 1, 'en')).toBe(
      'Antigravity did not provide a separate final answer; 1 tool action is complete, 1 tool action has no confirmed result. Check the failed tool card(s) before continuing.',
    );
  });
});
