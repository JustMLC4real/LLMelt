import { describe, expect, it } from 'vitest';
import {
  clampPanelWidth,
  draggedPanelWidth,
  keyboardPanelWidth,
  responsivePanelWidths,
  shouldUseCompactSidebar,
} from './panel-resize';

describe('verschuifbare zijpanelen', () => {
  it('vergroot links naar rechts en rechts naar links', () => {
    expect(draggedPanelWidth('left', 280, 100, 150, 220, 500)).toBe(330);
    expect(draggedPanelWidth('right', 380, 900, 850, 280, 700)).toBe(430);
  });

  it('respecteert de beschikbare minimum- en maximumbreedte', () => {
    expect(clampPanelWidth(20, 220, 500)).toBe(220);
    expect(clampPanelWidth(900, 220, 500)).toBe(500);
  });

  it('ondersteunt toetsenbordresizing vanaf beide paneelranden', () => {
    expect(keyboardPanelWidth('left', 280, 'ArrowRight', 220, 500)).toBe(304);
    expect(keyboardPanelWidth('right', 380, 'ArrowLeft', 280, 700)).toBe(404);
  });

  it('beschermt de chatbreedte wanneer opgeslagen paneelbreedtes niet meer passen', () => {
    expect(responsivePanelWidths({
      viewportWidth: 900,
      sidebarWidth: 386,
      terminalWidth: 860,
      sidebarCollapsed: false,
      terminalVisible: true,
    })).toEqual({
      sidebarWidth: 260,
      terminalWidth: 280,
      mainWidth: 360,
    });
  });

  it('laat gebruikersvoorkeuren ongewijzigd zodra er genoeg ruimte is', () => {
    expect(responsivePanelWidths({
      viewportWidth: 1600,
      sidebarWidth: 340,
      terminalWidth: 620,
      sidebarCollapsed: false,
      terminalVisible: true,
    })).toEqual({
      sidebarWidth: 340,
      terminalWidth: 620,
      mainWidth: 640,
    });
  });

  it('reserveert geen terminalruimte buiten de zichtbare chat', () => {
    expect(responsivePanelWidths({
      viewportWidth: 900,
      sidebarWidth: 280,
      terminalWidth: 700,
      sidebarCollapsed: true,
      terminalVisible: false,
    })).toEqual({
      sidebarWidth: 44,
      terminalWidth: 0,
      mainWidth: 856,
    });
  });

  it('klapt de zijbalk tijdelijk compact als de chat anders wordt afgesneden', () => {
    expect(shouldUseCompactSidebar(579, false)).toBe(true);
    expect(shouldUseCompactSidebar(580, false)).toBe(false);
    expect(shouldUseCompactSidebar(859, true)).toBe(true);
    expect(shouldUseCompactSidebar(860, true)).toBe(false);
  });
});
