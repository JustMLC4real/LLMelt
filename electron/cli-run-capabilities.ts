import type { ReasoningEffort } from '../src/providers/types';

const PLACEHOLDER_VALUES = new Set(['value', 'values', 'level', 'levels', 'effort', 'option', 'options']);

function optionHelpSegment(helpText: string, option: string) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const optionMatch = new RegExp(`--${escaped}\\b`, 'i').exec(helpText);
  if (!optionMatch) return '';

  const remainder = helpText.slice(optionMatch.index);
  const nextOption = remainder.slice(optionMatch[0].length).search(
    /\r?\n[ \t]*(?:-[a-z0-9],?[ \t]+)?--[a-z0-9][a-z0-9-]*\b/i,
  );
  const segmentEnd = nextOption < 0
    ? Math.min(remainder.length, 1_200)
    : optionMatch[0].length + nextOption;
  return remainder.slice(0, segmentEnd);
}

/**
 * Leest de daadwerkelijk door een CLI gepubliceerde keuzes voor één optie.
 * Zowel `(a, b)`, `(choices: "a", "b")`, `[possible values: a|b]` als
 * `<a|b>` worden ondersteund. De parser stopt altijd vóór de volgende optie.
 */
export function cliOptionChoicesFromHelp(helpText: string, option: string): string[] {
  const segment = optionHelpSegment(helpText, option);
  if (!segment) return [];

  for (const match of segment.matchAll(/[<([]([^>\])]+)[>\])]/g)) {
    const choiceList = String(match[1] || '')
      .replace(/^\s*(?:(?:possible\s+)?values?|choices?)\s*:\s*/i, '')
      .trim();
    if (!/[,|/]/.test(choiceList)) continue;
    const advertised = choiceList
      .split(/\s*[,|/]\s*/)
      .map((value) => value.trim().replace(/^[\s'"`]+|[\s'"`]+$/g, ''))
      .filter((value) => (
        /^[a-z][a-z0-9._-]*$/i.test(value)
        && !PLACEHOLDER_VALUES.has(value.toLowerCase())
      ));
    if (advertised.length >= 2) return Array.from(new Set(advertised));
  }
  return [];
}

/**
 * Leest de keuzes naast `--effort` uit de help van de daadwerkelijk geïnstalleerde
 * CLI. Ontbreekt die lijst, dan claimt LLMelt ook geen effort-control.
 */
export function reasoningEffortsFromCliHelp(helpText: string): ReasoningEffort[] {
  return cliOptionChoicesFromHelp(helpText, 'effort') as ReasoningEffort[];
}

export function cliSupportsReasoningEffort(helpText: string, effort: unknown): effort is ReasoningEffort {
  return reasoningEffortsFromCliHelp(helpText).includes(effort as ReasoningEffort);
}
