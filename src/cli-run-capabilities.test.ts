import { describe, expect, it } from 'vitest';
import {
  cliOptionChoicesFromHelp,
  cliSupportsReasoningEffort,
  reasoningEffortsFromCliHelp,
} from '../electron/cli-run-capabilities';

describe('live CLI run-capabilities', () => {
  it('leest Claude-keuzes uit de actuele --effort-helpregel', () => {
    const help = [
      '  --effort <level>  Effort level for the current session',
      '                    (low, medium, high, xhigh, max)',
      '  --model <model>    Model for the session',
    ].join('\n');
    expect(reasoningEffortsFromCliHelp(help)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('leest Antigravity pipe-keuzes en behoudt de CLI-volgorde', () => {
    const help = '  --effort  Reasoning effort for the current CLI session (low|medium|high)';
    expect(reasoningEffortsFromCliHelp(help)).toEqual(['low', 'medium', 'high']);
  });

  it('claimt geen control wanneer de CLI geen keuzelijst publiceert', () => {
    expect(reasoningEffortsFromCliHelp('  --effort <value>  Configure effort')).toEqual([]);
    expect(reasoningEffortsFromCliHelp('  --model <model>')).toEqual([]);
  });

  it('valideert een request tegen de live help en niet tegen een modelallowlist', () => {
    const help = '--effort <level> (medium, future-plus)';
    expect(cliSupportsReasoningEffort(help, 'future-plus')).toBe(true);
    expect(cliSupportsReasoningEffort(help, 'high')).toBe(false);
  });

  it('behoudt toekomstige live waarden zonder ze vooraf te kennen', () => {
    expect(reasoningEffortsFromCliHelp('--effort <level> [possible values: eco, balanced-v2, extreme_plus]'))
      .toEqual(['eco', 'balanced-v2', 'extreme_plus']);
  });

  it('stopt bij de volgende CLI-optie en leent daar geen keuzelijst van', () => {
    const help = [
      '  --effort <level>       Configure reasoning effort',
      '  --theme-test <theme>   Render a theme (dark, light)',
    ].join('\n');
    expect(reasoningEffortsFromCliHelp(help)).toEqual([]);
    expect(cliSupportsReasoningEffort(help, 'dark')).toBe(false);
  });

  it('behoudt vervolgregels van effort maar stopt vóór een korte plus lange vervolgoptie', () => {
    const help = [
      '  --effort <level>       Configure reasoning effort',
      '                         [possible values: eco, balanced, maximum]',
      '  -m, --model <model>    Select model',
      '                         (small, large)',
    ].join('\n');
    expect(reasoningEffortsFromCliHelp(help)).toEqual(['eco', 'balanced', 'maximum']);
  });

  it('leest Claude permission-modes en Antigravity-modes live uit help', () => {
    const claude = [
      '  --permission-mode <mode>  Permission mode to use',
      '                            (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
      '  --model <model>           Model for the session',
    ].join('\n');
    expect(cliOptionChoicesFromHelp(claude, 'permission-mode')).toEqual([
      'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
    ]);
    expect(cliOptionChoicesFromHelp('--mode Set execution mode (accept-edits, plan)', 'mode'))
      .toEqual(['accept-edits', 'plan']);
  });
});
