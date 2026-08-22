import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import type { AttachmentKind, AttachmentRef, ChatMessage } from '../src/providers/types';
import type { AttachmentRecord } from './provider-adapters';
import { getDb } from './database';
import { selectDefaultWorkspacePath } from './default-workspace';

const importedAttachmentIds = new Set<string>();
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

export function forgetImportedAttachment(id: string) {
  importedAttachmentIds.delete(id);
}

export async function selectAndImportFiles(chatId?: string) {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'csv', 'json', 'md', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_ATTACHMENT_COUNT) throw new Error(`Selecteer maximaal ${MAX_ATTACHMENT_COUNT} bestanden tegelijk.`);
  const stats = await Promise.all(result.filePaths.map((filePath) => fs.promises.stat(filePath)));
  if (stats.reduce((sum, stat) => sum + stat.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error('Bijlagen mogen samen maximaal 50 MB zijn.');
  }
  return Promise.all(result.filePaths.map((filePath) => importAttachment(filePath, chatId)));
}

export async function selectDirectory() {
  const defaultPath = ensureDefaultWorkspacePath();
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

export function getAttachmentById(id: string) {
  if (!importedAttachmentIds.has(id)) {
    const found = getDb().prepare('SELECT id FROM attachments WHERE id = ?').get(id);
    if (!found) throw new Error('Attachment is not available.');
  }
  const row = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRecord | undefined;
  if (!row) throw new Error('Attachment not found.');
  return toAttachmentRef(row);
}

export function getAttachments(ids: string[], chatId: string) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM attachments WHERE (chatId = ? OR chatId IS NULL) AND id IN (${placeholders})`)
    .all(chatId, ...ids) as unknown as AttachmentRecord[];
  if (rows.length !== new Set(ids).size) throw new Error('Een of meer bijlagen horen niet bij dit gesprek.');
  return rows;
}

export async function hydrateMessageAttachments(messages: ChatMessage[]) {
  return Promise.all(messages.map(async (message) => ({
    ...message,
    attachments: message.attachments ? await hydrateAttachments(message.attachments as AttachmentRecord[]) : undefined,
  })));
}

export async function hydrateAttachments(attachments: AttachmentRecord[]) {
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.kind !== 'image' || attachment.base64Content || !attachment.path) return attachment;
    const buffer = await fs.promises.readFile(attachment.path);
    if (buffer.length > 25 * 1024 * 1024) throw new Error(`Afbeelding ${attachment.name} is groter dan 25 MB.`);
    return { ...attachment, base64Content: buffer.toString('base64') };
  }));
}

export async function removeManagedAttachmentFilesForChat(chatId: string) {
  const rows = getDb().prepare('SELECT path FROM attachments WHERE chatId = ?').all(chatId) as unknown as Array<{ path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
}

export async function removeManagedAttachmentFilesForMessage(messageId: string) {
  const rows = getDb().prepare('SELECT path FROM attachments WHERE messageId = ?').all(messageId) as unknown as Array<{ path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
}

export async function cleanupStalePendingAttachments() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb().prepare(
    'SELECT id, path FROM attachments WHERE messageId IS NULL AND createdAt < ?',
  ).all(cutoff) as unknown as Array<{ id: string; path?: string }>;
  await Promise.all(rows.map((row) => row.path ? removeManagedAttachmentPath(row.path) : undefined));
  const remove = getDb().prepare('DELETE FROM attachments WHERE id = ? AND messageId IS NULL');
  for (const row of rows) {
    remove.run(row.id);
    importedAttachmentIds.delete(row.id);
  }
}

async function importAttachment(filePath: string, chatId?: string) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Alleen bestanden kunnen worden geïmporteerd.');
  if (stat.size > 25 * 1024 * 1024) throw new Error('Dit bestand is te groot. De limiet is 25 MB.');
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.promises.readFile(filePath);
  const id = crypto.randomUUID();
  const kind = kindFromExt(ext);
  let textContent: string | null = null;
  let storedPath = filePath;
  if (kind === 'text') textContent = buffer.toString('utf8');
  if (kind === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    textContent = ((await parser.getText()).text || '').slice(0, MAX_EXTRACTED_TEXT_CHARS);
  }
  if (kind === 'image') {
    const managedDir = managedAttachmentDirectory();
    await fs.promises.mkdir(managedDir, { recursive: true });
    storedPath = path.join(managedDir, `${id}${ext}`);
    await fs.promises.writeFile(storedPath, buffer, { flag: 'wx' });
  }
  const row = {
    id, chatId: chatId || null, messageId: null, name: path.basename(filePath), path: storedPath,
    mimeType: mimeFromExt(ext), kind, size: stat.size, tokenEstimate: estimateTokens(textContent || ''),
    textContent, base64Content: null, createdAt: new Date().toISOString(),
  };
  getDb().prepare('INSERT INTO attachments (id, chatId, messageId, name, path, mimeType, kind, size, tokenEstimate, textContent, base64Content, createdAt) VALUES (@id, @chatId, @messageId, @name, @path, @mimeType, @kind, @size, @tokenEstimate, @textContent, @base64Content, @createdAt)').run(row);
  importedAttachmentIds.add(id);
  return toAttachmentRef(row as AttachmentRecord);
}

function managedAttachmentDirectory() {
  return path.join(app.getPath('userData'), 'attachments');
}

export async function removeManagedAttachmentPath(filePath: string) {
  const root = path.resolve(managedAttachmentDirectory());
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;
  await fs.promises.rm(target, { force: true }).catch(() => {});
}

function ensureDefaultWorkspacePath() {
  try {
    const workspace = selectDefaultWorkspacePath(app.getPath('documents'), fs.existsSync);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  } catch {
    return process.cwd();
  }
}

function toAttachmentRef(row: AttachmentRecord): AttachmentRef {
  return {
    id: row.id, chatId: row.chatId, messageId: row.messageId, name: row.name, path: row.path,
    mimeType: row.mimeType, kind: row.kind, size: row.size, tokenEstimate: row.tokenEstimate,
    contentPreview: row.textContent ? row.textContent.slice(0, 500) : undefined, createdAt: row.createdAt,
  };
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function mimeFromExt(ext: string) {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown',
    '.txt': 'text/plain', '.py': 'text/x-python', '.js': 'text/javascript', '.ts': 'text/typescript',
    '.jsx': 'text/javascript', '.tsx': 'text/typescript', '.html': 'text/html', '.css': 'text/css',
  };
  return map[ext] || 'application/octet-stream';
}

function kindFromExt(ext: string): AttachmentKind {
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.txt', '.csv', '.json', '.md', '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css'].includes(ext)) return 'text';
  return 'binary';
}
