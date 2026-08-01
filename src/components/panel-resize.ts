export type HorizontalPanelEdge = 'left' | 'right';

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
