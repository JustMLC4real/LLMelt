export type TerminalContainerSize = {
  clientWidth: number;
  clientHeight: number;
};

export type TerminalGridSize = {
  cols: number;
  rows: number;
};

// Kleinere tussenmaten komen kort voor tijdens de slide-in en leveren geen
// bruikbaar xterm-raster op. Wacht tot het paneel echt aanwezig en meetbaar is.
export function terminalContainerIsMeasurable(
  container: TerminalContainerSize | null | undefined,
): boolean {
  return !!container && container.clientWidth >= 160 && container.clientHeight >= 80;
}

export function terminalGridIsUsable(grid: TerminalGridSize | null | undefined): boolean {
  return !!grid && Number.isFinite(grid.cols) && Number.isFinite(grid.rows) && grid.cols > 0 && grid.rows > 0;
}

export function terminalSessionCanStart(
  container: TerminalContainerSize | null | undefined,
  grid: TerminalGridSize | null | undefined,
): boolean {
  return terminalContainerIsMeasurable(container) && terminalGridIsUsable(grid);
}
