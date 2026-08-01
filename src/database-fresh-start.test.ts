import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const freshProfile = vi.hoisted(() => ({ directory: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`Onverwacht Electron-pad: ${name}`);
      return freshProfile.directory;
    },
  },
}));

afterEach(async () => {
  vi.resetModules();
  if (freshProfile.directory) {
    await fs.promises.rm(freshProfile.directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
    freshProfile.directory = '';
  }
});

describe('lege gebruikersprofiel-database', () => {
  it('maakt alle kernschema’s en accepteert de eerste chat zonder bestaande data', async () => {
    freshProfile.directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-fresh-profile-'));
    const database = await import('../electron/database');
    database.initDatabase();
    const db = database.getDb();

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const table of [
      'schema_migrations',
      'folders',
      'chats',
      'messages',
      'attachments',
      'usage_events',
      'provider_limits',
      'provider_quota_snapshots',
      'turn_execution_actions',
      'prompt_presets',
    ]) {
      expect(tables.has(table), table).toBe(true);
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO chats (id, title, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
    `).run('fresh-chat', 'Nieuw gesprek', now, now);
    db.prepare(`
      INSERT INTO messages (id, chatId, role, content, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run('fresh-message', 'fresh-chat', 'user', 'Hallo', now);

    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('fresh-message'))
      .toMatchObject({ content: 'Hallo' });
    expect(fs.existsSync(path.join(freshProfile.directory, 'attachments'))).toBe(true);
    db.close();
  });
});
