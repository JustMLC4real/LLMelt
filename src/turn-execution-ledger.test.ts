import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  duplicateTurnAction,
  executionLedgerResumePrompt,
  markPendingTurnActionsUncertain,
  recordTurnExecutionActivity,
  stableJson,
} from '../electron/turn-execution-ledger';

function createLedgerDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE turn_execution_actions (
      id TEXT PRIMARY KEY,
      turnId TEXT NOT NULL,
      provider TEXT NOT NULL,
      toolUseId TEXT,
      toolName TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL,
      inputJson TEXT NOT NULL,
      output TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  return db;
}

describe('turn execution ledger', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
  });

  it('werkt een aangevraagde toolactie bij naar voltooid en blokkeert een exact duplicaat', () => {
    const db = createLedgerDb();
    databases.push(db);
    const input = { content: 'inhoud', path: 'voorbeeld.txt' };

    recordTurnExecutionActivity(db, 'turn-1', {
      provider: 'codex',
      toolName: 'write_file',
      toolUseId: 'tool-1',
      input,
      phase: 'requested',
    }, 'C:/project');
    recordTurnExecutionActivity(db, 'turn-1', {
      provider: 'codex',
      toolName: 'write_file',
      toolUseId: 'tool-1',
      input,
      phase: 'result',
      ok: true,
      output: 'gemaakt',
    }, 'C:/project');

    expect(duplicateTurnAction(db, 'turn-1', 'write_file', input, 'C:/project')).toMatchObject({
      status: 'completed',
      provider: 'codex',
      output: 'gemaakt',
    });
    expect(executionLedgerResumePrompt(db, 'turn-1', 'nl')).toContain('VOLTOOID write_file');
  });

  it('markeert onafgemaakte acties onzeker voor veilige providerfallback', () => {
    const db = createLedgerDb();
    databases.push(db);
    const input = { command: 'npm test' };

    recordTurnExecutionActivity(db, 'turn-2', {
      provider: 'antigravity',
      toolName: 'run_command',
      input,
      phase: 'approved',
    }, 'C:/project');
    markPendingTurnActionsUncertain(db, 'turn-2', 'antigravity');

    expect(duplicateTurnAction(db, 'turn-2', 'run_command', input, 'C:/project')).toMatchObject({
      status: 'uncertain',
      provider: 'antigravity',
    });
    expect(executionLedgerResumePrompt(db, 'turn-2', 'en')).toContain('UNCERTAIN run_command');
  });

  it('maakt objecthandtekeningen onafhankelijk van de sleutelvolgorde', () => {
    expect(stableJson({ z: 1, nested: { b: 2, a: 1 } }))
      .toBe(stableJson({ nested: { a: 1, b: 2 }, z: 1 }));
  });
});
