import crypto from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeToolActivity } from './native-tools';
import { nativeToolLedgerSignature } from './native-tool-loop-utils';
import { boundedString } from './settings-security';
import type { ProviderType, UiLanguage } from '../src/providers/types';

export type TurnActionStatus = 'requested' | 'approved' | 'completed' | 'failed' | 'denied' | 'uncertain';

export function recordTurnExecutionActivity(
  db: DatabaseSync,
  turnId: string,
  activity: NativeToolActivity,
  cwd?: string,
) {
  const signature = nativeToolLedgerSignature(activity.toolName, activity.input, cwd);
  const now = new Date().toISOString();
  const status: TurnActionStatus = activity.phase === 'result'
    ? (activity.ok ? 'completed' : 'failed')
    : activity.phase === 'denied'
      ? 'denied'
      : activity.phase;
  const id = crypto.createHash('sha256')
    .update(`${turnId}\0${activity.provider}\0${activity.toolUseId || ''}\0${signature}`)
    .digest('hex');

  db.prepare(`
    INSERT INTO turn_execution_actions
      (id, turnId, provider, toolUseId, toolName, signature, status, inputJson, output, createdAt, updatedAt)
    VALUES
      (@id, @turnId, @provider, @toolUseId, @toolName, @signature, @status, @inputJson, @output, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, output=excluded.output, updatedAt=excluded.updatedAt
  `).run({
    id,
    turnId,
    provider: activity.provider,
    toolUseId: activity.toolUseId || null,
    toolName: activity.toolName,
    signature,
    status,
    inputJson: stableJson(activity.input),
    output: activity.output || activity.detail || null,
    createdAt: now,
    updatedAt: now,
  });
}

export function duplicateTurnAction(
  db: DatabaseSync,
  turnId: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
) {
  return db.prepare(`
    SELECT status, provider, output FROM turn_execution_actions
    WHERE turnId = ? AND signature = ? AND status IN ('completed', 'uncertain')
    ORDER BY updatedAt DESC LIMIT 1
  `).get(turnId, nativeToolLedgerSignature(toolName, input, cwd)) as {
    status: TurnActionStatus;
    provider: string;
    output?: string;
  } | undefined;
}

export function markPendingTurnActionsUncertain(db: DatabaseSync, turnId: string, provider: ProviderType) {
  db.prepare(`
    UPDATE turn_execution_actions SET status = 'uncertain', updatedAt = ?
    WHERE turnId = ? AND provider = ? AND status IN ('requested', 'approved')
  `).run(new Date().toISOString(), turnId, provider);
}

export function executionLedgerResumePrompt(
  db: DatabaseSync,
  turnId: string,
  language: UiLanguage = 'nl',
) {
  const rows = db.prepare(`
    SELECT toolName, inputJson, status, output FROM turn_execution_actions
    WHERE turnId = ? AND status IN ('completed', 'uncertain') ORDER BY createdAt
  `).all(turnId) as Array<{
    toolName: string;
    inputJson: string;
    status: TurnActionStatus;
    output?: string;
  }>;
  if (!rows.length) return '';

  const completed = rows.filter((row) => row.status === 'completed');
  const uncertain = rows.filter((row) => row.status === 'uncertain');
  return language === 'en'
    ? [
      'SAFE RESUMPTION OF THE SAME TURN:',
      'Do not repeat exact actions that already completed; the app also blocks duplicates technically.',
      ...completed.map((row) => `- COMPLETED ${row.toolName} ${row.inputJson}${row.output ? ` -> ${boundedString(row.output, 300, 'Tool output')}` : ''}`),
      ...(uncertain.length ? ['Check uncertain actions read-only first; do not repeat them blindly.'] : []),
      ...uncertain.map((row) => `- UNCERTAIN ${row.toolName} ${row.inputJson}`),
      'New mutating actions go through the normal approval flow again.',
    ].join('\n')
    : [
      'VEILIGE HERVATTING VAN DEZELFDE BEURT:',
      'Voer voltooide exacte acties niet opnieuw uit; de app blokkeert duplicaten ook technisch.',
      ...completed.map((row) => `- VOLTOOID ${row.toolName} ${row.inputJson}${row.output ? ` -> ${boundedString(row.output, 300, 'Tooluitvoer')}` : ''}`),
      ...(uncertain.length ? ['Controleer onzekere acties eerst read-only; voer ze niet blind opnieuw uit.'] : []),
      ...uncertain.map((row) => `- ONZEKER ${row.toolName} ${row.inputJson}`),
      'Nieuwe muterende acties doorlopen de normale goedkeuring opnieuw.',
    ].join('\n');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
