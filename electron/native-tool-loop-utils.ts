import type { NativeToolExecutionResult } from './native-tools';

const MAX_MODEL_TOOL_OUTPUT_CHARS = 48_000;
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_CSI_PATTERN = new RegExp(`${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC_PATTERN = new RegExp(`${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`, 'g');

export function nativeToolCallSignature(toolName: string | undefined, input: unknown) {
  return `${String(toolName || 'onbekende_tool').toLowerCase()}:${stableJson(normalizeObject(input))}`;
}

export function nativeToolFeedback(result: NativeToolExecutionResult, replayBlocked: boolean) {
  const output = modelSafeToolOutput(result.output);
  if (result.ok) return { ok: true, output };
  const denied = !!result.denied;
  return {
    ok: false,
    output,
    error: output,
    errorCode: denied ? 'USER_DENIED' : replayBlocked ? 'NO_PROGRESS_REPEAT' : 'TOOL_FAILED',
    retryable: !denied && !replayBlocked,
    instruction: denied
      ? 'Vraag geen nieuwe PC-toolactie; leg in het eindantwoord uit dat toestemming ontbrak.'
      : replayBlocked
        ? 'Herhaal deze call niet. Gebruik een andere reparatiestap of rond eerlijk af.'
        : 'Onderzoek de fout, wijzig eerst de oorzaak en voer pas daarna opnieuw uit.',
  };
}

export function modelSafeToolOutput(value: string) {
  const withoutAnsi = String(value || '')
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '');
  const plain = [...withoutAnsi]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
  if (plain.length <= MAX_MODEL_TOOL_OUTPUT_CHARS) return plain;
  return `${plain.slice(0, MAX_MODEL_TOOL_OUTPUT_CHARS)}\n...[tool-output voor model afgekapt]`;
}

export function isNativeMutationTool(toolName: string) {
  return ['write_file', 'edit_file'].includes(toolName.toLowerCase());
}

export function joinNativeText(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  const needsSeparator = !/\s$/.test(left) && !/^\s/.test(right);
  return `${left}${needsSeparator ? ' ' : ''}${right}`;
}

export function clipNativeToolDetail(value: string, maxChars = 12_000) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[afgekapt]`;
}

/** Alleen het laatste tekstsegment na de laatste tool is het echte eindantwoord. */
export function finalNativeAssistantText(segments: string[], fallback: string) {
  return [...segments].reverse().find((segment) => segment.trim())?.trim() || fallback.trim();
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
