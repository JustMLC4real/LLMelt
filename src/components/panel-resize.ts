export type HorizontalPanelEdge = 'left' | 'right';

export const SIDEBAR_PANEL_MIN_WIDTH = 220;
export const SIDEBAR_PANEL_MAX_WIDTH = 520;
export const SIDEBAR_COLLAPSED_WIDTH = 44;
export const TERMINAL_PANEL_MIN_WIDTH = 280;
export const TERMINAL_PANEL_MAX_WIDTH = 860;
export const MAIN_PANEL_MIN_WIDTH = 360;

/**
 * Onder deze grens kan de vaste zijbalk niet meer naast de minimale chatruimte
 * (en eventueel de terminal) staan. De compacte rail bewaart de chatruimte,
 * zonder de opgeslagen gebruikersbreedte te overschrijven.
 */
export function shouldUseCompactSidebar(
  viewportWidth: number,
  terminalVisible: boolean,
  mainMinWidth = MAIN_PANEL_MIN_WIDTH,
) {
  const terminalMinimum = terminalVisible ? TERMINAL_PANEL_MIN_WIDTH : 0;
  return Math.max(0, Math.round(viewportWidth))
    < SIDEBAR_PANEL_MIN_WIDTH + terminalMinimum + Math.max(0, Math.round(mainMinWidth));
}

export interface ResponsivePanelWidthOptions {
  viewportWidth: number;
  sidebarWidth: number;
  terminalWidth: number;
  sidebarCollapsed: boolean;
  terminalVisible: boolean;
  mainMinWidth?: number;
}

export interface ResponsivePanelWidths {
  sidebarWidth: number;
  terminalWidth: number;
  mainWidth: number;
}

export function clampPanelWidth(width: number, min: number, max: number) {
  const safeMin = Math.max(0, Math.min(min, max));
  const safeMax = Math.max(safeMin, max);
  return Math.round(Math.min(safeMax, Math.max(safeMin, width)));
}

export function draggedPanelWidth(
  edge: HorizontalPanelEdge,
  startWidth: number,
  startClientX: number,
  clientX: number,
  min: number,
  max: number,
) {
  const delta = clientX - startClientX;
  return clampPanelWidth(startWidth + (edge === 'left' ? delta : -delta), min, max);
}

export function keyboardPanelWidth(
  edge: HorizontalPanelEdge,
  width: number,
  key: string,
  min: number,
  max: number,
  step = 24,
) {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return width;
  const direction = key === 'ArrowRight' ? 1 : -1;
  return clampPanelWidth(width + direction * step * (edge === 'left' ? 1 : -1), min, max);
}

/**
 * Begrens opgeslagen paneelvoorkeuren tegen de actuele vensterbreedte zonder ze
 * te overschrijven. Daardoor herstellen de gekozen breedtes na maximaliseren,
 * terwijl het chatpaneel tijdens een tijdelijk klein venster bruikbaar blijft.
 */
export function responsivePanelWidths({
  viewportWidth,
  sidebarWidth,
  terminalWidth,
  sidebarCollapsed,
  terminalVisible,
  mainMinWidth = MAIN_PANEL_MIN_WIDTH,
}: ResponsivePanelWidthOptions): ResponsivePanelWidths {
  const viewport = Math.max(0, Math.round(viewportWidth));
  const requiredMain = Math.max(0, Math.round(mainMinWidth));
  let sidebar = sidebarCollapsed
    ? SIDEBAR_COLLAPSED_WIDTH
    : clampPanelWidth(sidebarWidth, SIDEBAR_PANEL_MIN_WIDTH, SIDEBAR_PANEL_MAX_WIDTH);
  let terminal = terminalVisible
    ? clampPanelWidth(terminalWidth, TERMINAL_PANEL_MIN_WIDTH, TERMINAL_PANEL_MAX_WIDTH)
    : 0;

  let overflow = Math.max(0, sidebar + terminal + requiredMain - viewport);
  if (overflow && terminalVisible) {
    const shrink = Math.min(overflow, terminal - TERMINAL_PANEL_MIN_WIDTH);
    terminal -= shrink;
    overflow -= shrink;
  }
  if (overflow && !sidebarCollapsed) {
    const shrink = Math.min(overflow, sidebar - SIDEBAR_PANEL_MIN_WIDTH);
    sidebar -= shrink;
  }

  return {
    sidebarWidth: Math.round(sidebar),
    terminalWidth: Math.round(terminal),
    mainWidth: Math.max(0, Math.round(viewport - sidebar - terminal)),
  };
}
