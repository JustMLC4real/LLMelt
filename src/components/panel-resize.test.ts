import { describe, expect, it } from 'vitest';
import { clampPanelWidth, draggedPanelWidth, keyboardPanelWidth } from './panel-resize';

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
});
