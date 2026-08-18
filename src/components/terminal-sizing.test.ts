import { describe, expect, it } from 'vitest';
import {
  terminalContainerIsMeasurable,
  terminalGridIsUsable,
  terminalSessionCanStart,
} from './terminal-sizing';

describe('terminal eerste-open afmetingen', () => {
  it('weigert verborgen en nog inschuivende containers', () => {
    expect(terminalContainerIsMeasurable(null)).toBe(false);
    expect(terminalContainerIsMeasurable({ clientWidth: 0, clientHeight: 500 })).toBe(false);
    expect(terminalContainerIsMeasurable({ clientWidth: 159, clientHeight: 500 })).toBe(false);
    expect(terminalContainerIsMeasurable({ clientWidth: 500, clientHeight: 79 })).toBe(false);
  });

  it('accepteert pas een zichtbaar paneel met een bruikbaar xterm-raster', () => {
    expect(terminalGridIsUsable({ cols: 0, rows: 24 })).toBe(false);
    expect(terminalGridIsUsable({ cols: 80, rows: 24 })).toBe(true);
    expect(terminalSessionCanStart(
      { clientWidth: 500, clientHeight: 400 },
      { cols: 80, rows: 24 },
    )).toBe(true);
  });
});
