import type { UiLanguage } from '../providers/types';
import { localizedText } from '../i18n/language';

export interface ChangedLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

function lines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Regeldiff zonder ongewijzigde context. Voor normale bronbestanden gebruikt dit
 * LCS; bij zeer grote bestanden blijft het begrensd tot het gewijzigde middenstuk.
 */
export function changedLineDiff(before: string, after: string, maxLines = 240, language: UiLanguage = 'nl'): ChangedLine[] {
  const oldLines = lines(before);
  const newLines = lines(after);
  let result: ChangedLine[];

  if ((oldLines.length + 1) * (newLines.length + 1) <= 300_000) {
    result = lcsDiff(oldLines, newLines);
  } else {
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix
      && suffix < newLines.length - prefix
      && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix += 1;
    result = [
      ...oldLines.slice(prefix, oldLines.length - suffix).map((text) => ({ type: 'remove' as const, text })),
      ...newLines.slice(prefix, newLines.length - suffix).map((text) => ({ type: 'add' as const, text })),
    ];
  }

  if (result.length <= maxLines) return result;
  return [
    ...result.slice(0, maxLines),
    {
      type: 'context',
      text: localizedText(
        language,
        `… ${result.length - maxLines} gewijzigde regels afgekapt`,
        `… ${result.length - maxLines} changed lines truncated`,
      ),
    },
  ];
}

function lcsDiff(oldLines: string[], newLines: string[]): ChangedLine[] {
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      table[index] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
  }

  const result: ChangedLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      result.push({ type: 'remove', text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      result.push({ type: 'add', text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) result.push({ type: 'remove', text: oldLines[oldIndex++] });
  while (newIndex < newLines.length) result.push({ type: 'add', text: newLines[newIndex++] });
  return result;
}
