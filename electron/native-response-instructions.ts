import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

const NATIVE_TOOL_RESPONSE_INSTRUCTIONS_NL = [
  '',
  'Na gebruik van tools geef je precies één kort eindantwoord, pas nadat alle tools klaar zijn.',
  'Maximaal 120 woorden en maximaal 6 korte bullets.',
  'Noem alleen resultaat, relevante bestandsnamen en resterende waarschuwingen.',
  'Plak geen volledige code, bestandsinhoud, diff of terminaluitvoer: de app toont die al in toolkaarten.',
  'Geef tijdens het uitvoeren geen tussennarratie of herhaling van de opdracht.',
].join('\n');

const NATIVE_TOOL_RESPONSE_INSTRUCTIONS_EN = [
  '',
  'After using tools, give exactly one short final answer, only after every tool has finished.',
  'Use at most 120 words and at most 6 short bullet points.',
  'Mention only the outcome, relevant file names, and any remaining warnings.',
  'Do not paste full code, file contents, diffs, or terminal output: the app already shows them in tool cards.',
  'Do not provide interim narration or repeat the task while tools are running.',
].join('\n');

export function nativeToolResponseInstructions(language: UiLanguage = 'nl') {
  return localizedText(language, NATIVE_TOOL_RESPONSE_INSTRUCTIONS_NL, NATIVE_TOOL_RESPONSE_INSTRUCTIONS_EN);
}

export const NATIVE_TOOL_RESPONSE_INSTRUCTIONS = NATIVE_TOOL_RESPONSE_INSTRUCTIONS_NL;
