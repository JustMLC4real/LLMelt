export type UtilityPanelId = 'system-prompt' | 'auto-mode' | 'terminal';

export const UTILITY_PANEL_TOGGLE_EVENT = 'superapp:utility-panel-toggle';

export function isUtilityPanelId(value: unknown): value is UtilityPanelId {
  return value === 'system-prompt' || value === 'auto-mode' || value === 'terminal';
}

/** Eén aangevraagd werkpaneel vervangt het huidige; dezelfde knop klapt het in. */
export function toggledUtilityPanel(current: UtilityPanelId | null, requested: UtilityPanelId) {
  return current === requested ? null : requested;
}

/** Laat knoppen buiten ChatView dezelfde exclusieve paneelrouter gebruiken. */
export function requestUtilityPanelToggle(panel: UtilityPanelId) {
  window.dispatchEvent(new CustomEvent(UTILITY_PANEL_TOGGLE_EVENT, { detail: panel }));
}
