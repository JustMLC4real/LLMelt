import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_TOOL_DEFINITIONS,
  type McpConfig,
  createDefaultMcpConfig,
  executeMcpTool,
  normalizeMcpConfig,
  resolveWorkspacePath,
} from './mcp-tools';

const tempDirs: string[] = [];

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-mcp-'));
  tempDirs.push(dir);
  return dir;
}

function configFor(rootPath: string, overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    ...createDefaultMcpConfig(rootPath),
    ownerToken: 'test-token',
    readToolsEnabled: true,
    writeToolsEnabled: false,
    shellToolsEnabled: false,
    roots: [
      {
        id: 'project',
        name: 'Project',
        path: rootPath,
        read: true,
        write: false,
        shell: false,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP workspace policy', () => {
  it('keeps relative paths inside the approved root', () => {
    const root = makeTempWorkspace();
    const cfg = configFor(root);
    const resolved = resolveWorkspacePath(cfg, 'project', 'src/index.ts', 'read');
    expect(resolved.targetPath).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('rejects .. path escapes', () => {
    const root = makeTempWorkspace();
    const cfg = configFor(root);
    expect(() => resolveWorkspacePath(cfg, 'project', '..\\outside.txt', 'read')).toThrow(/escapes/i);
  });

  it('rejects absolute paths outside the approved root', () => {
    const root = makeTempWorkspace();
    const outside = path.join(os.tmpdir(), 'outside-ai-superapp-mcp.txt');
    const cfg = configFor(root);
    expect(() => resolveWorkspacePath(cfg, 'project', outside, 'read')).toThrow(/escapes/i);
  });

  it('normalizes invalid ports and keeps a read-only default root', () => {
    const root = makeTempWorkspace();
    const cfg = normalizeMcpConfig({ port: 12, roots: [] }, root);
    expect(cfg.port).toBe(8787);
    expect(cfg.roots[0]).toMatchObject({ id: 'project', read: true, write: false, shell: false });
  });
});

describe('MCP file tools', () => {
  it('reads files from allowed roots', async () => {
    const root = makeTempWorkspace();
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hello mcp', 'utf8');
    const result = await executeMcpTool(configFor(root), 'file.read', { rootId: 'project', path: 'hello.txt' });
    expect(result.text).toBe('hello mcp');
    expect(result.structuredContent?.size).toBe(9);
  });

  it('blocks writes until global and root write access are enabled', async () => {
    const root = makeTempWorkspace();
    await expect(executeMcpTool(configFor(root), 'file.create', {
      rootId: 'project',
      path: 'new.txt',
      content: 'new',
    })).rejects.toThrow(/write access/i);
  });

  it('creates files without overwriting by default', async () => {
    const root = makeTempWorkspace();
    const cfg = configFor(root, {
      writeToolsEnabled: true,
      roots: [{ id: 'project', name: 'Project', path: root, read: true, write: true, shell: false }],
    });
    await executeMcpTool(cfg, 'file.create', { rootId: 'project', path: 'new.txt', content: 'first' });
    await expect(executeMcpTool(cfg, 'file.create', {
      rootId: 'project',
      path: 'new.txt',
      content: 'second',
    })).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('first');
  });

  it('edits exact text only inside writable roots', async () => {
    const root = makeTempWorkspace();
    fs.writeFileSync(path.join(root, 'edit.txt'), 'hello old world', 'utf8');
    const cfg = configFor(root, {
      writeToolsEnabled: true,
      roots: [{ id: 'project', name: 'Project', path: root, read: true, write: true, shell: false }],
    });
    await executeMcpTool(cfg, 'file.edit', {
      rootId: 'project',
      path: 'edit.txt',
      oldText: 'old',
      newText: 'new',
    });
    expect(fs.readFileSync(path.join(root, 'edit.txt'), 'utf8')).toBe('hello new world');
  });
});

describe('MCP shell and schema metadata', () => {
  it('routes shell.run through the supplied approval-aware runtime', async () => {
    const root = makeTempWorkspace();
    const cfg = configFor(root, {
      shellToolsEnabled: true,
      roots: [{ id: 'project', name: 'Project', path: root, read: true, write: false, shell: true }],
    });
    const result = await executeMcpTool(
      cfg,
      'shell.run',
      { rootId: 'project', command: 'echo hello' },
      { runShell: async (command, cwd) => ({ ok: true, stdout: `${command} @ ${cwd}`, code: 0, cwd }) },
    );
    expect(result.status).toBe('ok');
    expect(result.text).toContain('echo hello');
    expect(result.text).toContain(root);
  });

  it('reports denied approval separately from generic errors', async () => {
    const root = makeTempWorkspace();
    const cfg = configFor(root, {
      shellToolsEnabled: true,
      roots: [{ id: 'project', name: 'Project', path: root, read: true, write: false, shell: true }],
    });
    const result = await executeMcpTool(
      cfg,
      'shell.run',
      { rootId: 'project', command: 'npm test' },
      { runShell: async () => ({ ok: false, denied: true, error: 'Geweigerd door gebruiker.', code: null }) },
    );
    expect(result.status).toBe('denied');
    expect(result.structuredContent?.denied).toBe(true);
  });

  it('keeps the V1 MCP tool names stable', () => {
    expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'workspace.list',
      'workspace.open',
      'file.read',
      'file.create',
      'file.edit',
      'search.rg',
      'shell.run',
    ]);
  });
});
