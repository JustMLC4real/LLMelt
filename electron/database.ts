import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

let db: DatabaseSync;

function tableColumns(tableName: string) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row: any) => row.name as string),
  );
}

function addColumnIfMissing(tableName: string, columnName: string, definition: string) {
  const columns = tableColumns(tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function hasMigration(id: string) {
  return !!db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id);
}

function recordMigration(id: string) {
  db.prepare('INSERT INTO schema_migrations (id, appliedAt) VALUES (?, ?)').run(
    id,
    new Date().toISOString(),
  );
}

function runMigration(id: string, migrate: () => void) {
  if (hasMigration(id)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    migrate();
    recordMigration(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function initDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'superapp.db');
  db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parentId TEXT,
      sortOrder INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folderId TEXT,
      systemPrompt TEXT,
      activeModelId TEXT,
      activeProvider TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY(folderId) REFERENCES folders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      modelId TEXT,
      provider TEXT,
      inputTokens INTEGER DEFAULT 0,
      outputTokens INTEGER DEFAULT 0,
      fallbackFrom TEXT,
      attachments TEXT,
      runConfig TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(chatId) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      scopeId TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      maxTokens INTEGER DEFAULT 1000,
      enabled BOOLEAN DEFAULT 1,
      createdAt TEXT NOT NULL
    );
  `);

  runMigration('2026-06-06-core-stabilization', () => {
    addColumnIfMissing('chats', 'systemPrompt', 'TEXT');
    addColumnIfMissing('chats', 'activeModelId', 'TEXT');
    addColumnIfMissing('chats', 'activeProvider', 'TEXT');
    addColumnIfMissing('messages', 'fallbackFrom', 'TEXT');
    addColumnIfMissing('messages', 'attachments', 'TEXT');
    addColumnIfMissing('messages', 'runConfig', 'TEXT');
    addColumnIfMissing('messages', 'toolRun', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        chatId TEXT,
        messageId TEXT,
        name TEXT NOT NULL,
        path TEXT,
        mimeType TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        tokenEstimate INTEGER DEFAULT 0,
        textContent TEXT,
        base64Content TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(chatId) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(messageId) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        chatId TEXT,
        messageId TEXT,
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        totalTokens INTEGER DEFAULT 0,
        cachedTokens INTEGER DEFAULT 0,
        reasoningTokens INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(chatId) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(messageId) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS provider_limits (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        modelId TEXT,
        known INTEGER DEFAULT 0,
        source TEXT NOT NULL,
        limitScope TEXT,
        limitGroupKey TEXT,
        displayState TEXT,
        requestsLimit INTEGER,
        requestsRemaining INTEGER,
        tokensLimit INTEGER,
        tokensRemaining INTEGER,
        resetRequestsAt TEXT,
        resetTokensAt TEXT,
        retryAfterMs INTEGER,
        note TEXT,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        isDefault INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chatId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_attachments_chat ON attachments(chatId);
      CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(provider, modelId, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_limits_unique ON provider_limits(provider, IFNULL(modelId, ''));
    `);
  });

  runMigration('2026-06-07-message-run-config', () => {
    addColumnIfMissing('messages', 'runConfig', 'TEXT');
  });

  runMigration('2026-06-20-limit-scope-metadata', () => {
    addColumnIfMissing('provider_limits', 'limitScope', 'TEXT');
    addColumnIfMissing('provider_limits', 'limitGroupKey', 'TEXT');
    addColumnIfMissing('provider_limits', 'displayState', 'TEXT');
  });

  runMigration('2026-06-21-chat-run-config', () => {
    // Per-chat run config (e.g. ChatGPT thinking effort) so each chat remembers it.
    addColumnIfMissing('chats', 'activeRunConfig', 'TEXT');
  });

  runMigration('2026-06-28-project-context', () => {
    addColumnIfMissing('chats', 'projectPath', 'TEXT');
    addColumnIfMissing('folders', 'projectPath', 'TEXT');
  });

  runMigration('2026-06-28-command-run-cards', () => {
    addColumnIfMissing('messages', 'toolRun', 'TEXT');
  });

  runMigration('2026-07-01-chat-agent-mode', () => {
    addColumnIfMissing('chats', 'agentMode', 'TEXT');
  });

  runMigration('2026-07-12-external-image-attachments', () => {
    const attachmentDir = path.join(app.getPath('userData'), 'attachments');
    fs.mkdirSync(attachmentDir, { recursive: true });
    const images = db.prepare("SELECT id, path, mimeType, base64Content FROM attachments WHERE kind = 'image' AND base64Content IS NOT NULL").all() as Array<Record<string, any>>;
    const update = db.prepare('UPDATE attachments SET path = ?, base64Content = NULL WHERE id = ?');
    for (const image of images) {
      const ext = path.extname(String(image.path || '')) || extensionForMime(String(image.mimeType || ''));
      const destination = path.join(attachmentDir, `${image.id}${ext}`);
      if (!fs.existsSync(destination)) fs.writeFileSync(destination, Buffer.from(String(image.base64Content || ''), 'base64'), { flag: 'wx' });
      update.run(destination, image.id);
    }
  });

  runMigration('2026-08-01-provider-quota-and-safe-resume', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_quota_snapshots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        surface TEXT NOT NULL,
        modelId TEXT,
        limitGroupKey TEXT NOT NULL,
        planTier TEXT,
        state TEXT NOT NULL,
        source TEXT NOT NULL,
        accuracy TEXT NOT NULL,
        observedAt TEXT NOT NULL,
        staleAfter TEXT,
        delayedBySeconds INTEGER,
        note TEXT,
        bucketsJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_execution_actions (
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

      CREATE INDEX IF NOT EXISTS idx_provider_quota_group
        ON provider_quota_snapshots(limitGroupKey, observedAt);
      CREATE INDEX IF NOT EXISTS idx_turn_execution_actions_turn
        ON turn_execution_actions(turnId, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_execution_actions_tool
        ON turn_execution_actions(turnId, provider, IFNULL(toolUseId, ''), signature);
    `);
  });

  return db;
}

function extensionForMime(mimeType: string) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.jpg';
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
