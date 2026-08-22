import crypto from 'crypto';
import path from 'path';
import type { IpcMain } from 'electron';
import { notifyChatsChanged } from './app-events';
import {
  removeManagedAttachmentFilesForChat,
  removeManagedAttachmentFilesForMessage,
} from './attachment-service';
import { getDb } from './database';
import type {
  AgentApprovalMode,
  Chat,
  Folder,
  MemoryEntry,
  Message,
  ModelRunConfig,
} from '../src/providers/types';

const AGENT_APPROVAL_MODES: AgentApprovalMode[] = ['ask', 'auto-project', 'full'];

export function registerDatabaseIpcHandlers(ipcMain: IpcMain) {
  ipcMain.handle('db:getChats', async () => getDb().prepare('SELECT * FROM chats ORDER BY updatedAt DESC').all().map(mapChatRow));
  ipcMain.handle('db:getChat', async (_event, id: string) => getChatById(id));
  ipcMain.handle('db:createChat', async (_event, title: string, folderId?: string, id?: string) => {
    const chat = createChat(title, folderId, id);
    notifyChatsChanged();
    return chat;
  });
  ipcMain.handle('db:updateChat', async (_event, id: string, data: Partial<Chat>) => {
    const chat = updateChat(id, data);
    notifyChatsChanged();
    return chat;
  });
  ipcMain.handle('db:deleteChat', async (_event, id: string) => {
    await removeManagedAttachmentFilesForChat(id);
    getDb().prepare('DELETE FROM chats WHERE id = ?').run(id);
    notifyChatsChanged();
    return true;
  });

  ipcMain.handle('db:getMessages', async (_event, chatId: string) =>
    getDb().prepare('SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC').all(chatId),
  );
  ipcMain.handle('db:addMessage', async (_event, msg: Message) => insertMessage(msg));
  ipcMain.handle('db:deleteMessage', async (_event, id: string) => {
    await removeManagedAttachmentFilesForMessage(id);
    getDb().prepare('DELETE FROM attachments WHERE messageId = ?').run(id);
    getDb().prepare('DELETE FROM messages WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('db:getFolders', async () => getDb().prepare('SELECT * FROM folders ORDER BY sortOrder ASC').all());
  ipcMain.handle('db:createFolder', async (_event, name: string, parentId?: string) => {
    const folder = {
      id: crypto.randomUUID(),
      name: String(name || '').trim() || 'Nieuwe map',
      parentId: parentId || null,
      projectPath: null,
      sortOrder: (getDb().prepare('SELECT COUNT(*) as count FROM folders').get() as { count: number }).count,
      createdAt: new Date().toISOString(),
    };
    getDb()
      .prepare('INSERT INTO folders (id, name, parentId, projectPath, sortOrder, createdAt) VALUES (@id, @name, @parentId, @projectPath, @sortOrder, @createdAt)')
      .run(folder);
    return folder;
  });
  ipcMain.handle('db:updateFolder', async (_event, id: string, nameOrData: string | Partial<Folder>) => {
    const data = typeof nameOrData === 'string' ? { name: nameOrData } : (nameOrData || {});
    const clean: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(data, 'name')) clean.name = String(data.name || '').trim() || 'Map';
    if (Object.prototype.hasOwnProperty.call(data, 'projectPath')) clean.projectPath = normalizeProjectPath(data.projectPath);
    if (Object.keys(clean).length) {
      const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
      getDb().prepare(`UPDATE folders SET ${updates} WHERE id = @id`).run({ ...clean, id });
    }
    return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id);
  });
  ipcMain.handle('db:deleteFolder', async (_event, id: string) => {
    const db = getDb();
    const chatRows = db.prepare('SELECT id FROM chats WHERE folderId = ?').all(id) as Array<{ id: string }>;
    for (const chat of chatRows) await removeManagedAttachmentFilesForChat(chat.id);
    // Een project verwijderen wist ook z'n gesprekken. Zonder deze expliciete
    // DELETE zou ON DELETE SET NULL ze als losse gesprekken laten staan.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chats WHERE folderId = ?').run(id);
      db.prepare("DELETE FROM memories WHERE type = 'project' AND scopeId = ?").run(id);
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    notifyChatsChanged();
    return true;
  });

  ipcMain.handle('db:getMemory', async (_event, type?: string, scopeId?: string) => {
    let query = 'SELECT * FROM memories WHERE 1=1';
    const params: string[] = [];
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    if (scopeId) {
      query += ' AND scopeId = ?';
      params.push(scopeId);
    }
    return getDb().prepare(query).all(...params);
  });
  ipcMain.handle('db:addMemory', async (_event, mem: MemoryEntry) => {
    const memory = {
      id: String(mem.id || '') || crypto.randomUUID(),
      type: mem.type,
      scopeId: mem.scopeId ? String(mem.scopeId) : null,
      title: String(mem.title || '').trim() || 'Memory',
      content: String(mem.content || ''),
      maxTokens: Number(mem.maxTokens || 1000),
      enabled: mem.enabled === false ? 0 : 1,
      createdAt: String(mem.createdAt || '') || new Date().toISOString(),
    };
    getDb()
      .prepare('INSERT INTO memories (id, type, scopeId, title, content, maxTokens, enabled, createdAt) VALUES (@id, @type, @scopeId, @title, @content, @maxTokens, @enabled, @createdAt)')
      .run(memory);
    return memory;
  });
  ipcMain.handle('db:updateMemory', async (_event, id: string, data: Record<string, unknown>) => updateMemory(id, data));
  ipcMain.handle('db:deleteMemory', async (_event, id: string) => {
    getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('db:getPresets', async () => getDb().prepare('SELECT * FROM prompt_presets ORDER BY updatedAt DESC').all());
  ipcMain.handle('db:savePreset', async (_event, preset: Record<string, unknown>) => savePromptPreset(preset));
  ipcMain.handle('db:deletePreset', async (_event, id: string) => {
    getDb().prepare('DELETE FROM prompt_presets WHERE id = ?').run(id);
    return true;
  });
}

export function normalizeAgentApprovalMode(mode: unknown): AgentApprovalMode | undefined {
  return AGENT_APPROVAL_MODES.includes(mode as AgentApprovalMode) ? mode as AgentApprovalMode : undefined;
}

export function serializeRunConfig(runConfig?: ModelRunConfig) {
  if (!runConfig || !Object.keys(runConfig).length) return null;
  return JSON.stringify(runConfig);
}

export function expandPath(value: string) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, process.env.APPDATA || '');
}

export function normalizeProjectPath(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(expandPath(trimmed));
}

export function mapChatRow(row: Record<string, unknown> | undefined): Chat | undefined {
  if (!row) return undefined;
  let activeRunConfig: ModelRunConfig | null = null;
  if (row.activeRunConfig) {
    try { activeRunConfig = JSON.parse(String(row.activeRunConfig)); } catch { activeRunConfig = null; }
  }
  return {
    ...row,
    activeRunConfig,
    agentMode: normalizeAgentApprovalMode(row.agentMode) || null,
  } as unknown as Chat;
}

export function getChatById(id: string) {
  return mapChatRow(getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

function createChat(title: string, folderId?: string, requestedId?: string) {
  const now = new Date().toISOString();
  const id = String(requestedId || '').trim();
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Ongeldig gesprek-id.');
  const chat: Chat = {
    id: id || crypto.randomUUID(),
    title: String(title || '').trim() || 'New chat',
    folderId: folderId || null,
    projectPath: null,
    systemPrompt: null,
    activeModelId: null,
    activeProvider: null,
    activeRunConfig: null,
    agentMode: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare('INSERT INTO chats (id, title, folderId, projectPath, systemPrompt, activeModelId, activeProvider, activeRunConfig, agentMode, createdAt, updatedAt) VALUES (@id, @title, @folderId, @projectPath, @systemPrompt, @activeModelId, @activeProvider, @activeRunConfig, @agentMode, @createdAt, @updatedAt)')
    .run({ ...chat, activeRunConfig: null, agentMode: null });
  return chat;
}

export function updateChat(id: string, data: Partial<Chat>) {
  const allowed = ['title', 'folderId', 'projectPath', 'systemPrompt', 'activeModelId', 'activeProvider', 'agentMode'] as const;
  const clean: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (key === 'projectPath') clean[key] = normalizeProjectPath(data[key]);
    else if (key === 'agentMode') clean[key] = normalizeAgentApprovalMode(data[key]) || null;
    else clean[key] = data[key] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'activeRunConfig')) {
    clean.activeRunConfig = serializeRunConfig(data.activeRunConfig || undefined);
  }
  if (Object.keys(clean).length) {
    const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
    getDb()
      .prepare(`UPDATE chats SET ${updates}, updatedAt = @updatedAt WHERE id = @id`)
      .run({ ...clean, id, updatedAt: new Date().toISOString() });
  }
  return getChatById(id);
}

export function insertMessage(message: Message) {
  const normalized = {
    id: message.id || crypto.randomUUID(),
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    modelId: message.modelId || null,
    provider: message.provider || null,
    inputTokens: Number(message.inputTokens || 0),
    outputTokens: Number(message.outputTokens || 0),
    fallbackFrom: message.fallbackFrom || null,
    attachments: message.attachments || null,
    runConfig: message.runConfig || null,
    toolRun: message.toolRun || null,
    createdAt: message.createdAt || new Date().toISOString(),
  };
  getDb()
    .prepare('INSERT INTO messages (id, chatId, role, content, modelId, provider, inputTokens, outputTokens, fallbackFrom, attachments, runConfig, toolRun, createdAt) VALUES (@id, @chatId, @role, @content, @modelId, @provider, @inputTokens, @outputTokens, @fallbackFrom, @attachments, @runConfig, @toolRun, @createdAt)')
    .run(normalized);
  getDb().prepare('UPDATE chats SET updatedAt = ? WHERE id = ?').run(new Date().toISOString(), normalized.chatId);
  return normalized;
}

function updateMemory(id: string, data: Record<string, unknown>) {
  const allowed = ['type', 'scopeId', 'title', 'content', 'maxTokens', 'enabled'] as const;
  const clean: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, key)) clean[key] = data[key];
  }
  if (clean.enabled !== undefined) clean.enabled = clean.enabled ? 1 : 0;
  if (Object.keys(clean).length) {
    const updates = Object.keys(clean).map((key) => `${key} = @${key}`).join(', ');
    getDb().prepare(`UPDATE memories SET ${updates} WHERE id = @id`).run({ ...clean, id });
  }
  return getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function savePromptPreset(preset: Record<string, unknown>) {
  const now = new Date().toISOString();
  const row = {
    id: String(preset.id || '') || crypto.randomUUID(),
    name: String(preset.name || '').trim() || 'Prompt preset',
    content: String(preset.content || ''),
    isDefault: preset.isDefault ? 1 : 0,
    createdAt: String(preset.createdAt || '') || now,
    updatedAt: now,
  };
  getDb()
    .prepare('INSERT INTO prompt_presets (id, name, content, isDefault, createdAt, updatedAt) VALUES (@id, @name, @content, @isDefault, @createdAt, @updatedAt) ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, isDefault = excluded.isDefault, updatedAt = excluded.updatedAt')
    .run(row);
  return row;
}
