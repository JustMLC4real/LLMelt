import { describe, expect, it } from 'vitest';
import { isUtilityPanelId, toggledUtilityPanel, utilityPanelsAvailableInView } from './utility-panels';

describe('utility-panelrouter', () => {
  it('houdt altijd hoogstens één werkpaneel actief', () => {
    expect(toggledUtilityPanel(null, 'system-prompt')).toBe('system-prompt');
    expect(toggledUtilityPanel('system-prompt', 'auto-mode')).toBe('auto-mode');
    expect(toggledUtilityPanel('auto-mode', 'terminal')).toBe('terminal');
  });

  it('klapt dezelfde paneelknop weer in', () => {
    expect(toggledUtilityPanel('terminal', 'terminal')).toBeNull();
  });

  it('weigert onbekende eventwaarden', () => {
    expect(isUtilityPanelId('auto-mode')).toBe(true);
    expect(isUtilityPanelId('settings')).toBe(false);
    expect(isUtilityPanelId(null)).toBe(false);
  });

  it('toont werkpanelen uitsluitend in de chatweergave', () => {
    expect(utilityPanelsAvailableInView('chat')).toBe(true);
    expect(utilityPanelsAvailableInView('settings')).toBe(false);
    expect(utilityPanelsAvailableInView('tokens')).toBe(false);
  });
});
