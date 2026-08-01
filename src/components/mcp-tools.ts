import fs from 'fs';
import path from 'path';
import { assertRealPathInsideRoot } from '../../electron/path-security';

export type McpToolName =
  | 'workspace.list'
  | 'workspace.open'
  | 'file.read'
  | 'file.create'
  | 'file.edit'
  | 'search.rg'
  | 'shell.run';

export type McpToolStatus = 'ok' | 'error' | 'denied';

export interface McpWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  read: boolean;
  write: boolean;
  shell: boolean;
}

export interface McpConfig {
  enabled: boolean;
  host: string;
  port: number;
  ownerToken: string;
  tunnelUrl: string;
  readToolsEnabled: boolean;
  writeToolsEnabled: boolean;
  shellToolsEnabled: boolean;
  roots: McpWorkspaceRoot[];
}

export interface McpCallLogEntry {
  id: string;
  tool: McpToolName | string;
  rootId?: string;
  path?: string;
  command?: string;
  status: McpToolStatus;
  startedAt: string;
  durationMs: number;
  outputSize: number;
  error?: string;
}

export interface ShellRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  cwd?: string;
  denied?: boolean;
  error?: string;
}

export interface McpToolRuntime {
  runShell?: (command: string, cwd: string) => Promise<ShellRunResult>;
}

export interface McpToolResponse {
  status: McpToolStatus;
  text: string;
  structuredContent?: Record<string, unknown>;
  outputSize: number;
}

export const DEFAULT_MCP_PORT = 8787;
export const MAX_MCP_FILE_BYTES = 1024 * 1024;
export const MAX_MCP_SEARCH_RESULTS = 50;

export const MCP_TOOL_DEFINITIONS: Array<{
  name: McpToolName;
  title: string;
  description: string;
  kind: 'read' | 'write' | 'shell';
}> = [
    {
      name: 'workspace.list',
      title: 'List approved workspaces',
      description: 'List the local workspace roots that LLMelt exposes to this connector.',
      kind: 'read',
    },
    {
      name: 'workspace.open',
      title: 'Open workspace',
      description: 'Inspect one approved workspace root and its enabled capabilities.',
      kind: 'read',
    },
    {
      name: 'file.read',
      title: 'Read file',
      description: 'Read a text file from an approved workspace root.',
      kind: 'read',
    },
    {
      name: 'file.create',
      title: 'Create file',
      description: 'Create a new text file in an approved workspace root. Overwrite is off by default.',
      kind: 'write',
    },
    {
      name: 'file.edit',
      title: 'Edit file',
      description: 'Replace exact text inside an existing file in an approved workspace root.',
      kind: 'write',
    },
    {
      name: 'search.rg',
      title: 'Search workspace',
      description: 'Search text inside an approved workspace root with ripgrep-like results.',
      kind: 'read',
    },
    {
      name: 'shell.run',
      title: 'Run shell command',
      description: 'Run a shell command inside an approved workspace root using LLMelt approval settings.',
      kind: 'shell',
    },
  ];

export function createDefaultMcpConfig(defaultRootPath = process.cwd()): McpConfig {
  const rootPath = path.resolve(defaultRootPath);
  return {
    enabled: false,
    host: '127.0.0.1',
    port: DEFAULT_MCP_PORT,
    ownerToken: '',
    tunnelUrl: '',
    readToolsEnabled: true,
    writeToolsEnabled: false,
    shellToolsEnabled: false,
    roots: [
      {
        id: 'project',
        name: path.basename(rootPath) || 'Project',
        path: rootPath,
        read: true,
        write: false,
        shell: false,
      },
    ],
  };
}

export function normalizeMcpConfig(raw: Partial<McpConfig> | undefined, defaultRootPath = process.cwd()): McpConfig {
  const defaults = createDefaultMcpConfig(defaultRootPath);
  const roots = Array.isArray(raw?.roots) && raw?.roots.length
    ? raw.roots.map((root, index) => normalizeRoot(root, index, defaultRootPath)).filter(Boolean) as McpWorkspaceRoot[]
    : defaults.roots;

  return {
    enabled: raw?.enabled === true,
    // De control-plane blijft lokaal; externe toegang hoort via een tunnel met
    // authenticatie te lopen, niet via een onverwachte LAN-listener.
    host: normalizeLoopbackHost(raw?.host),
    port: normalizePort(raw?.port),
    ownerToken: typeof raw?.ownerToken === 'string' ? raw.ownerToken.trim() : '',
    tunnelUrl: typeof raw?.tunnelUrl === 'string' ? raw.tunnelUrl.trim() : '',
    readToolsEnabled: raw?.readToolsEnabled !== false,
    writeToolsEnabled: raw?.writeToolsEnabled === true,
    shellToolsEnabled: raw?.shellToolsEnabled === true,
    roots,
  };
}

function normalizeLoopbackHost(value: unknown) {
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (host === 'localhost' || host === '::1' || host === '[::1]') return host === '[::1]' ? '::1' : host;
  return '127.0.0.1';
}

export function resolveWorkspacePath(
  config: McpConfig,
  rootId: string,
  requestedPath: string,
  purpose: 'read' | 'write' | 'shell',
) {
  const root = findRoot(config, rootId);
  if (purpose === 'read' && (!config.readToolsEnabled || !root.read)) {
    throw new Error('Read access is not enabled for this workspace.');
  }
  if (purpose === 'write' && (!config.writeToolsEnabled || !root.write)) {
    throw new Error('Write access is not enabled for this workspace.');
  }
  if (purpose === 'shell' && (!config.shellToolsEnabled || !root.shell)) {
    throw new Error('Shell access is not enabled for this workspace.');
  }

  const rootPath = path.resolve(root.path);
  const targetPath = requestedPath?.trim()
    ? path.resolve(rootPath, requestedPath)
    : rootPath;
  assertInsideRoot(rootPath, targetPath);
  return { root, rootPath, targetPath };
}

export async function executeMcpTool(
  config: McpConfig,
  tool: McpToolName,
  args: Record<string, unknown>,
  runtime: McpToolRuntime = {},
): Promise<McpToolResponse> {
  switch (tool) {
    case 'workspace.list':
      return response({
        workspaces: config.roots.map((root) => workspaceSummary(root, config)),
      });

    case 'workspace.open': {
      const root = findRoot(config, stringArg(args.rootId, 'rootId'));
      return response({ workspace: workspaceSummary(root, config, true) });
    }

    case 'file.read':
      return readFileTool(config, args);

    case 'file.create':
      return createFileTool(config, args);

    case 'file.edit':
      return editFileTool(config, args);

    case 'search.rg':
      return searchTool(config, args);

    case 'shell.run':
      return shellTool(config, args, runtime);

    default:
      throw new Error(`Unknown MCP tool: ${tool}`);
  }
}

function normalizeRoot(root: Partial<McpWorkspaceRoot>, index: number, defaultRootPath: string) {
  const rawPath = typeof root.path === 'string' && root.path.trim() ? root.path.trim() : defaultRootPath;
  const resolvedPath = path.resolve(rawPath);
  const fallbackId = index === 0 ? 'project' : `workspace-${index + 1}`;
  const id = sanitizeRootId(root.id || fallbackId);
  if (!id) return null;
  return {
    id,
    name: typeof root.name === 'string' && root.name.trim() ? root.name.trim() : path.basename(resolvedPath) || id,
    path: resolvedPath,
    read: root.read !== false,
    write: root.write === true,
    shell: root.shell === true,
  };
}

function normalizePort(value: unknown) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return DEFAULT_MCP_PORT;
  return port;
}

function sanitizeRootId(value: unknown) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id.slice(0, 64);
}

function findRoot(config: McpConfig, rootId: string) {
  const root = config.roots.find((item) => item.id === rootId);
  if (!root) throw new Error(`Workspace root not found: ${rootId}`);
  return root;
}

function assertInsideRoot(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes the approved workspace root.');
  }
}

function workspaceSummary(root: McpWorkspaceRoot, config: McpConfig, includePath = false) {
  return {
    id: root.id,
    name: root.name,
    ...(includePath ? { path: root.path } : {}),
    read: config.readToolsEnabled && root.read,
    write: config.writeToolsEnabled && root.write,
    shell: config.shellToolsEnabled && root.shell,
  };
}

async function readFileTool(config: McpConfig, args: Record<string, unknown>) {
  const { rootPath, targetPath } = resolveWorkspacePath(config, stringArg(args.rootId, 'rootId'), stringArg(args.path, 'path'), 'read');
  await assertRealPathInsideRoot(rootPath, targetPath, false);
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) throw new Error('Path is not a file.');
  const maxBytes = Math.min(numberArg(args.maxBytes, MAX_MCP_FILE_BYTES), MAX_MCP_FILE_BYTES);
  if (stat.size > maxBytes) throw new Error(`File is too large (${stat.size} bytes, max ${maxBytes}).`);
  const text = await fs.promises.readFile(targetPath, 'utf8');
  return response({ path: targetPath, size: stat.size, content: text }, text);
}

async function createFileTool(config: McpConfig, args: Record<string, unknown>) {
  const { rootPath, targetPath } = resolveWorkspacePath(config, stringArg(args.rootId, 'rootId'), stringArg(args.path, 'path'), 'write');
  await assertRealPathInsideRoot(rootPath, targetPath, true);
  const overwrite = args.overwrite === true;
  if (!overwrite && fs.existsSync(targetPath)) {
    throw new Error('File already exists. Set overwrite=true to replace it.');
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await assertRealPathInsideRoot(rootPath, path.dirname(targetPath), false);
  const content = stringArg(args.content, 'content', true);
  await fs.promises.writeFile(targetPath, content, 'utf8');
  return response({ path: targetPath, bytesWritten: Buffer.byteLength(content, 'utf8') }, `Created ${targetPath}`);
}

async function editFileTool(config: McpConfig, args: Record<string, unknown>) {
  const { rootPath, targetPath } = resolveWorkspacePath(config, stringArg(args.rootId, 'rootId'), stringArg(args.path, 'path'), 'write');
  await assertRealPathInsideRoot(rootPath, targetPath, false);
  const oldText = stringArg(args.oldText, 'oldText', true);
  const newText = stringArg(args.newText, 'newText', true);
  const replaceAll = args.replaceAll === true;
  const current = await fs.promises.readFile(targetPath, 'utf8');
  if (!current.includes(oldText)) throw new Error('oldText was not found in the file.');
  const next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
  await fs.promises.writeFile(targetPath, next, 'utf8');
  return response({
    path: targetPath,
    replacements: replaceAll ? current.split(oldText).length - 1 : 1,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
  }, `Edited ${targetPath}`);
}

async function searchTool(config: McpConfig, args: Record<string, unknown>) {
  const { rootPath, targetPath } = resolveWorkspacePath(config, stringArg(args.rootId, 'rootId'), stringArg(args.path || '.', 'path', true), 'read');
  await assertRealPathInsideRoot(rootPath, targetPath, false);
  const query = stringArg(args.query, 'query');
  const maxResults = Math.min(numberArg(args.maxResults, MAX_MCP_SEARCH_RESULTS), MAX_MCP_SEARCH_RESULTS);
  const results: Array<{ path: string; line: number; text: string }> = [];
  await walkTextFiles(targetPath, async (filePath) => {
    if (results.length >= maxResults) return;
    const text = await fs.promises.readFile(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
      if (lines[i].toLowerCase().includes(query.toLowerCase())) {
        results.push({ path: path.relative(rootPath, filePath), line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
  });
  return response({ results, truncated: results.length >= maxResults }, formatSearchResults(results));
}

async function shellTool(config: McpConfig, args: Record<string, unknown>, runtime: McpToolRuntime) {
  const { root, rootPath } = resolveWorkspacePath(config, stringArg(args.rootId, 'rootId'), '.', 'shell');
  await assertRealPathInsideRoot(rootPath, rootPath, false);
  const command = stringArg(args.command, 'command');
  if (!runtime.runShell) throw new Error('Shell runtime is not available.');
  const result = await runtime.runShell(command, rootPath);
  const stdout = result.stdout || '';
  const stderr = result.stderr || result.error || '';
  const text = [
    `$ ${command}`,
    stdout.trimEnd(),
    stderr.trimEnd(),
    result.denied ? '[denied by user]' : '',
    `[exit ${result.code ?? 'unknown'}]`,
  ].filter(Boolean).join('\n');
  const status: McpToolStatus = result.denied ? 'denied' : result.ok ? 'ok' : 'error';
  return {
    status,
    text,
    structuredContent: {
      rootId: root.id,
      cwd: result.cwd || rootPath,
      command,
      ok: result.ok,
      code: result.code ?? null,
      denied: result.denied === true,
      stdout,
      stderr,
    },
    outputSize: Buffer.byteLength(text, 'utf8'),
  };
}

async function walkTextFiles(startPath: string, visit: (filePath: string) => Promise<void>) {
  const stat = await fs.promises.stat(startPath);
  if (stat.isFile()) {
    if (isLikelyTextFile(startPath, stat.size)) await visit(startPath);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.promises.readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-electron') continue;
    const nextPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) await walkTextFiles(nextPath, visit);
    else if (entry.isFile()) {
      const entryStat = await fs.promises.stat(nextPath);
      if (isLikelyTextFile(nextPath, entryStat.size)) await visit(nextPath);
    }
  }
}

function isLikelyTextFile(filePath: string, size: number) {
  if (size > MAX_MCP_FILE_BYTES) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return true;
  return [
    '.css', '.csv', '.html', '.js', '.json', '.jsx', '.md', '.py', '.ts', '.tsx',
    '.txt', '.xml', '.yaml', '.yml',
  ].includes(ext);
}

function formatSearchResults(results: Array<{ path: string; line: number; text: string }>) {
  if (!results.length) return 'No matches.';
  return results.map((result) => `${result.path}:${result.line}: ${result.text}`).join('\n');
}

function response(structuredContent: Record<string, unknown>, text?: string): McpToolResponse {
  const body = text ?? JSON.stringify(structuredContent, null, 2);
  return {
    status: 'ok',
    text: body,
    structuredContent,
    outputSize: Buffer.byteLength(body, 'utf8'),
  };
}

function stringArg(value: unknown, name: string, allowEmpty = false) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`${name} is required.`);
  return allowEmpty ? value : trimmed;
}

function numberArg(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}
