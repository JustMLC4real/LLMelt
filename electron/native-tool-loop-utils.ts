import type { NativeToolExecutionResult } from './native-tools';
import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import path from 'path';

const MAX_MODEL_TOOL_OUTPUT_CHARS = 48_000;
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_CSI_PATTERN = new RegExp(`${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC_PATTERN = new RegExp(`${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`, 'g');

export function nativeToolCallSignature(toolName: string | undefined, input: unknown, language: UiLanguage = 'nl') {
  return `${String(toolName || localizedText(language, 'onbekende_tool', 'unknown_tool')).toLowerCase()}:${stableJson(normalizeObject(input))}`;
}

/**
 * Providerneutrale handtekening voor de duurzame uitvoeringsledger. CLI's en
 * function-callingproviders gebruiken andere namen en veldnamen voor dezelfde
 * lokale actie; die verschillen mogen een failover geen tweede side-effect geven.
 */
export function nativeToolLedgerSignature(
  toolName: string | undefined,
  input: unknown,
  cwd?: string,
) {
  const normalizedName = canonicalLedgerToolName(toolName);
  return `${normalizedName}:${stableJson(canonicalLedgerInput(normalizedName, normalizeObject(input), cwd))}`;
}

export function nativeToolFeedback(result: NativeToolExecutionResult, replayBlocked: boolean, language: UiLanguage = 'nl') {
  const output = modelSafeToolOutput(result.output, language);
  if (result.ok) return { ok: true, output };
  const denied = !!result.denied;
  return {
    ok: false,
    output,
    error: output,
    errorCode: denied ? 'USER_DENIED' : replayBlocked ? 'NO_PROGRESS_REPEAT' : 'TOOL_FAILED',
    retryable: !denied && !replayBlocked,
    instruction: denied
      ? localizedText(language, 'Vraag geen nieuwe PC-toolactie; leg in het eindantwoord uit dat toestemming ontbrak.', 'Do not request another PC tool action; explain in the final answer that permission was not granted.')
      : replayBlocked
        ? localizedText(language, 'Herhaal deze call niet. Gebruik een andere reparatiestap of rond eerlijk af.', 'Do not repeat this call. Use a different repair step or finish honestly.')
        : localizedText(language, 'Onderzoek de fout, wijzig eerst de oorzaak en voer pas daarna opnieuw uit.', 'Investigate the error, change its cause first, and only then execute again.'),
  };
}

export function modelSafeToolOutput(value: string, language: UiLanguage = 'nl') {
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
  return `${plain.slice(0, MAX_MODEL_TOOL_OUTPUT_CHARS)}\n${localizedText(language, '...[tool-output voor model afgekapt]', '...[tool output for model truncated]')}`;
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

export function clipNativeToolDetail(value: string, maxChars = 12_000, language: UiLanguage = 'nl') {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n${localizedText(language, '...[afgekapt]', '...[truncated]')}`;
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

function canonicalLedgerToolName(toolName: string | undefined) {
  const raw = String(toolName || 'unknown_tool')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const aliases: Record<string, string> = {
    bash: 'run_command',
    command: 'run_command',
    exec_command: 'run_command',
    execute_command: 'run_command',
    run_shell_command: 'run_command',
    shell: 'run_command',
    write: 'write_file',
    writefile: 'write_file',
    write_to_file: 'write_file',
    create_file: 'write_file',
    file_create: 'write_file',
    edit: 'edit_file',
    editfile: 'edit_file',
    apply_patch: 'edit_file',
    patch: 'edit_file',
    replace: 'edit_file',
    replace_file_content: 'edit_file',
    read: 'read_file',
    readfile: 'read_file',
    view_file: 'read_file',
  };
  return aliases[raw] || raw || 'unknown_tool';
}

function canonicalLedgerInput(toolName: string, input: Record<string, unknown>, cwd?: string) {
  const pathValue = firstLedgerValue(input, ['path', 'file_path', 'filePath', 'filename', 'file', 'target_path', 'absolute_path']);
  const normalizedPath = normalizeLedgerPath(pathValue, cwd);
  if (toolName === 'run_command') {
    const commandValue = firstLedgerValue(input, ['command', 'cmd', 'command_line', 'script']);
    const command = Array.isArray(commandValue)
      ? commandValue.map(String).join(' ').trim()
      : String(commandValue ?? '').trim();
    return compactLedgerObject({
      command,
      cwd: normalizeLedgerPath(firstLedgerValue(input, ['cwd', 'working_directory', 'workdir']) ?? cwd),
    });
  }
  if (toolName === 'read_file') return compactLedgerObject({ path: normalizedPath });
  if (toolName === 'write_file') {
    return compactLedgerObject({
      path: normalizedPath,
      content: firstLedgerValue(input, ['content', 'text', 'file_text', 'new_content']),
      changes: normalizeLedgerChanges(input.changes, cwd),
    });
  }
  if (toolName === 'edit_file') {
    return compactLedgerObject({
      path: normalizedPath,
      old_text: firstLedgerValue(input, ['old_text', 'oldText', 'old_string']),
      new_text: firstLedgerValue(input, ['new_text', 'newText', 'new_string', 'replacement']),
      replace_all: firstLedgerValue(input, ['replace_all', 'replaceAll']),
      changes: normalizeLedgerChanges(input.changes ?? input.patch, cwd),
    });
  }
  return input;
}

function firstLedgerValue(input: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

function normalizeLedgerChanges(value: unknown, cwd?: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]): [string, unknown] => [normalizeLedgerPath(key, cwd) || key, entry])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeLedgerPath(value: unknown, cwd?: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const resolved = cwd && !path.isAbsolute(raw) ? path.resolve(cwd, raw) : path.normalize(raw);
  const portable = resolved.replace(/\\/g, '/');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
}

function compactLedgerObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
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
