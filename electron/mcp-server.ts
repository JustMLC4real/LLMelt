import { BrowserWindow, app, safeStorage, type IpcMain } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getStore } from './settings-store';
import {
  MCP_TOOL_DEFINITIONS,
  type McpCallLogEntry,
  type McpConfig,
  type McpToolName,
  type McpToolStatus,
  type ShellRunResult,
  executeMcpTool,
  normalizeMcpConfig,
} from '../src/components/mcp-tools';

type RunShell = (command: string, cwd: string) => Promise<ShellRunResult>;

interface McpManagerDeps {
  runShell: RunShell;
  getWindow?: () => BrowserWindow | null;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_MCP_SESSIONS = 32;
const MCP_DIAGNOSTICS_ENABLED = process.env.AI_SUPERAPP_DIAGNOSTICS === '1';

class McpBodyTooLargeError extends Error { }

export interface McpServerStatus {
  enabled: boolean;
  running: boolean;
  endpoint: string;
  statusEndpoint: string;
  tunnelUrl: string;
  roots: McpConfig['roots'];
  tools: typeof MCP_TOOL_DEFINITIONS;
  lastError?: string;
}

let managerInstance: McpServerManager | null = null;

export function getMcpServerManager(deps: McpManagerDeps) {
  if (!managerInstance) managerInstance = new McpServerManager(deps);
  return managerInstance;
}

class McpServerManager {
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private callLog: McpCallLogEntry[] = [];
  private lastError: string | undefined;
  private deps: McpManagerDeps;
  private ephemeralOwnerToken = '';

  constructor(deps: McpManagerDeps) {
    this.deps = deps;
  }

  registerIpcHandlers(ipcMain: IpcMain) {
    ipcMain.handle('mcp:getConfig', async () => this.getConfig());
    ipcMain.handle('mcp:setConfig', async (_event, config: Partial<McpConfig>) => this.setConfig(config));
    ipcMain.handle('mcp:start', async () => this.start());
    ipcMain.handle('mcp:stop', async () => this.stop());
    ipcMain.handle('mcp:getStatus', async () => this.getStatus());
    ipcMain.handle('mcp:getCalls', async () => this.getCallLog());
  }

  async startIfEnabled() {
    const config = await this.getConfig();
    if (config.enabled) {
      await this.start();
    }
  }

  async getConfig() {
    const store = await getStore();
    const raw = store.get('mcp') as Partial<McpConfig> | undefined;
    let ownerToken = this.readProtectedOwnerToken(store);
    if (!ownerToken && typeof raw?.ownerToken === 'string' && raw.ownerToken.trim()) ownerToken = raw.ownerToken.trim();
    if (!ownerToken) ownerToken = this.ephemeralOwnerToken || crypto.randomBytes(24).toString('hex');
    this.ephemeralOwnerToken = ownerToken;
    this.storeProtectedOwnerToken(store, ownerToken);
    const sanitized = { ...(raw || {}) } as Partial<McpConfig>;
    delete sanitized.ownerToken;
    store.set('mcp', sanitized);
    store.delete('mcp.callLog');
    const config = normalizeMcpConfig({ ...sanitized, ownerToken }, app.getAppPath());
    return config;
  }

  async setConfig(next: Partial<McpConfig>) {
    const previous = await this.getConfig();
    const merged = normalizeMcpConfig({
      ...previous,
      ...next,
      roots: Array.isArray(next.roots) ? next.roots : previous.roots,
      ownerToken: typeof next.ownerToken === 'string' && next.ownerToken.trim()
        ? next.ownerToken.trim()
        : previous.ownerToken,
    }, app.getAppPath());
    const store = await getStore();
    this.ephemeralOwnerToken = merged.ownerToken;
    this.storeProtectedOwnerToken(store, merged.ownerToken);
    const persisted = { ...merged } as Partial<McpConfig>;
    delete persisted.ownerToken;
    store.set('mcp', persisted);

    if (!merged.enabled && this.httpServer) await this.stop();
    if (merged.enabled) {
      if (this.httpServer && (previous.port !== merged.port || previous.host !== merged.host)) {
        await this.stop();
      }
      await this.start();
    }
    return this.getConfig();
  }

  private readProtectedOwnerToken(store: any) {
    const protectedValue = store.get('mcpOwnerTokenEncrypted');
    if (!protectedValue || typeof protectedValue !== 'string' || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(protectedValue, 'base64')); }
    catch { return ''; }
  }

  private storeProtectedOwnerToken(store: any, ownerToken: string) {
    if (!safeStorage.isEncryptionAvailable()) return;
    store.set('mcpOwnerTokenEncrypted', safeStorage.encryptString(ownerToken).toString('base64'));
  }

  async start() {
    const config = await this.getConfig();
    if (this.httpServer) return this.getStatus();

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.writeJson(res, error instanceof McpBodyTooLargeError ? 413 : 500, { error: this.lastError });
        });
      });
      server.on('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        reject(error);
      });
      server.listen(config.port, config.host, () => {
        this.httpServer = server;
        this.lastError = undefined;
        resolve();
      });
    });

    const store = await getStore();
    store.set('mcp.enabled', true);
    return this.getStatus();
  }

  async stop() {
    for (const session of this.sessions.values()) {
      await session.transport.close().catch(() => { });
      await session.server.close().catch(() => { });
    }
    this.sessions.clear();

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const store = await getStore();
    store.set('mcp.enabled', false);
    return this.getStatus();
  }

  async getStatus(): Promise<McpServerStatus> {
    const config = await this.getConfig();
    return {
      enabled: config.enabled,
      running: !!this.httpServer,
      endpoint: `http://${config.host}:${config.port}/mcp`,
      statusEndpoint: `http://${config.host}:${config.port}/status`,
      tunnelUrl: config.tunnelUrl,
      roots: config.roots,
      tools: MCP_TOOL_DEFINITIONS,
      lastError: this.lastError,
    };
  }

  async getCallLog() {
    return this.callLog.slice(0, 100);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      this.writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname !== '/mcp' && url.pathname !== '/status') {
      this.writeJson(res, 404, { error: 'Not found. Use /mcp for MCP or /status for health.' });
      return;
    }

    const config = await this.getConfig();
    if (!this.isAuthorized(req, url, config.ownerToken)) {
      this.writeJson(res, 401, { error: 'Unauthorized. Use Authorization: Bearer <owner token>.' });
      return;
    }

    if (url.pathname === '/status') {
      this.writeJson(res, 200, await this.getPublicStatus());
      return;
    }

    const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
    const sessionId = stringHeader(req.headers['mcp-session-id']);
    let session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session && req.method === 'POST' && containsInitializeRequest(parsedBody)) {
      if (this.sessions.size >= MAX_MCP_SESSIONS) {
        this.writeJson(res, 503, { error: 'Maximum aantal MCP-sessies bereikt.' });
        return;
      }
      session = await this.createSession();
    }

    if (!session) {
      this.writeJson(res, sessionId ? 404 : 400, {
        error: sessionId ? 'MCP session not found.' : 'Missing MCP session. Send initialize first.',
      });
      return;
    }

    await session.transport.handleRequest(req, res, parsedBody);
  }

  private async createSession(): Promise<McpSession> {
    let sessionId = '';
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessionId = id;
      },
      onsessionclosed: (id) => {
        const session = this.sessions.get(id);
        if (session) {
          session.server.close().catch(() => { });
          this.sessions.delete(id);
        }
      },
    });
    transport.onclose = () => {
      if (sessionId) this.sessions.delete(sessionId);
    };
    const server = this.createProtocolServer();
    await server.connect(transport);
    const session = { server, transport };
    const originalHandleRequest = transport.handleRequest.bind(transport);
    transport.handleRequest = async (...args) => {
      await originalHandleRequest(...args);
      if (transport.sessionId && !this.sessions.has(transport.sessionId)) {
        sessionId = transport.sessionId;
        this.sessions.set(transport.sessionId, session);
      }
    };
    return session;
  }

  private createProtocolServer() {
    const server = new McpServer({
      name: 'LLMelt-local-control-plane',
      version: '1.0.0',
    });

    server.registerTool('workspace.list', {
      title: 'List approved workspaces',
      description: 'List local workspace roots approved in LLMelt.',
      inputSchema: {},
    }, async () => this.runTool('workspace.list', {}));

    server.registerTool('workspace.open', {
      title: 'Open workspace',
      description: 'Inspect a specific approved workspace root.',
      inputSchema: { rootId: z.string().describe('Workspace root id from workspace.list.') },
    }, async (args) => this.runTool('workspace.open', args));

    server.registerTool('file.read', {
      title: 'Read file',
      description: 'Read a UTF-8 text file from an approved workspace.',
      inputSchema: {
        rootId: z.string(),
        path: z.string(),
        maxBytes: z.number().int().positive().optional(),
      },
    }, async (args) => this.runTool('file.read', args));

    server.registerTool('file.create', {
      title: 'Create file',
      description: 'Create a new UTF-8 text file. Refuses overwrite unless overwrite=true.',
      inputSchema: {
        rootId: z.string(),
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional(),
      },
    }, async (args) => this.runTool('file.create', args));

    server.registerTool('file.edit', {
      title: 'Edit file',
      description: 'Replace exact text inside an existing UTF-8 file.',
      inputSchema: {
        rootId: z.string(),
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
        replaceAll: z.boolean().optional(),
      },
    }, async (args) => this.runTool('file.edit', args));

    server.registerTool('search.rg', {
      title: 'Search workspace',
      description: 'Search text inside an approved workspace with ripgrep-like path:line results.',
      inputSchema: {
        rootId: z.string(),
        query: z.string(),
        path: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    }, async (args) => this.runTool('search.rg', args));

    server.registerTool('shell.run', {
      title: 'Run shell command',
      description: 'Run a shell command inside an approved workspace using LLMelt approval settings.',
      inputSchema: {
        rootId: z.string(),
        command: z.string(),
      },
    }, async (args) => this.runTool('shell.run', args));

    return server;
  }

  private async runTool(tool: McpToolName, args: Record<string, unknown>) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    try {
      const config = await this.getConfig();
      const result = await executeMcpTool(config, tool, args, {
        runShell: async (command, cwd) => this.deps.runShell(command, cwd),
      });
      await this.recordCall({
        id: crypto.randomUUID(),
        tool,
        rootId: stringValue(args.rootId),
        path: stringValue(args.path),
        command: stringValue(args.command),
        status: result.status,
        startedAt,
        durationMs: Date.now() - started,
        outputSize: result.outputSize,
      });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        structuredContent: result.structuredContent,
        isError: result.status !== 'ok',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordCall({
        id: crypto.randomUUID(),
        tool,
        rootId: stringValue(args.rootId),
        path: stringValue(args.path),
        command: stringValue(args.command),
        status: inferErrorStatus(message),
        startedAt,
        durationMs: Date.now() - started,
        outputSize: Buffer.byteLength(message, 'utf8'),
        error: message,
      });
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  }

  private async recordCall(entry: McpCallLogEntry) {
    this.callLog = [entry, ...this.callLog].slice(0, 100);
    this.deps.getWindow?.()?.webContents.send('mcp:call', entry);
    appendMcpDebugLog(entry);
  }

  private async getPublicStatus() {
    const status = await this.getStatus();
    return {
      name: 'LLMelt MCP',
      running: status.running,
      endpoint: status.endpoint,
      tools: status.tools.map((tool) => tool.name),
      roots: status.roots.map((root) => ({ id: root.id, name: root.name, read: root.read, write: root.write, shell: root.shell })),
      lastError: status.lastError,
    };
  }

  private isAuthorized(req: IncomingMessage, url: URL, ownerToken: string) {
    if (!ownerToken) return false;
    const auth = stringHeader(req.headers.authorization);
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return bearer === ownerToken;
  }

  private writeJson(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return;
    this.writeCors(res);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  }

  private writeCors(res: ServerResponse) {
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
  }
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_MCP_BODY_BYTES) throw new McpBodyTooLargeError('MCP-request is groter dan 1 MB.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function containsInitializeRequest(body: unknown) {
  if (Array.isArray(body)) return body.some((item) => isInitializeRequest(item));
  return isInitializeRequest(body);
}

function stringHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.slice(0, 500) : undefined;
}

function inferErrorStatus(message: string): McpToolStatus {
  return /denied|geweigerd/i.test(message) ? 'denied' : 'error';
}

function appendMcpDebugLog(entry: McpCallLogEntry) {
  if (!MCP_DIAGNOSTICS_ENABLED) return;
  try {
    const logPath = path.join(app.getPath('logs'), 'mcp-debug.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ${entry.tool} ${entry.status} ${JSON.stringify({
        rootId: entry.rootId,
        path: entry.path,
        command: entry.command,
        durationMs: entry.durationMs,
        outputSize: entry.outputSize,
        error: entry.error,
      })}\n`,
    );
  } catch {
    // best-effort diagnostics
  }
}
