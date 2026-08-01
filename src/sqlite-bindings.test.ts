import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { providerLimitUpdateBindings } from '../electron/sqlite-bindings';

describe('SQLite named bindings', () => {
  it('stuurt de ongebruikte provider-limit-id niet mee naar een UPDATE', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE provider_limits (id TEXT PRIMARY KEY, provider TEXT NOT NULL, known INTEGER NOT NULL)');
    db.prepare('INSERT INTO provider_limits (id, provider, known) VALUES (?, ?, ?)').run('openai:account', 'openai', 0);

    const bindings = providerLimitUpdateBindings({ id: 'openai:account', provider: 'openai', known: 1 });
    expect(bindings).toEqual({ provider: 'openai', known: 1 });
    expect(() => db.prepare('UPDATE provider_limits SET known = @known WHERE provider = @provider').run(bindings)).not.toThrow();
    expect(db.prepare('SELECT known FROM provider_limits WHERE provider = ?').get('openai')).toEqual({ known: 1 });
    db.close();
  });
});
