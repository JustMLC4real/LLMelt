import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRealPathInsideRoot, canAutoApproveAgentAction, isRealPathInsideRoot } from '../electron/path-security';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fs.promises.rm(target, { recursive: true, force: true })));
});

describe('canonieke werkmapgrenzen', () => {
  it('staat normale bestaande en nieuwe paden binnen de root toe', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const root = path.join(base, 'root');
    await fs.promises.mkdir(path.join(root, 'sub'), { recursive: true });
    await expect(isRealPathInsideRoot(root, 'sub/nieuw.txt', true)).resolves.toBe(true);
    await expect(assertRealPathInsideRoot(root, 'sub', false)).resolves.toBeUndefined();
  });

  it('weigert een junction of symlink die buiten de root wijst', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'geheim');
    const link = path.join(root, 'link');
    await fs.promises.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(isRealPathInsideRoot(root, path.join('link', 'secret.txt'), false)).resolves.toBe(false);
    await expect(isRealPathInsideRoot(root, path.join('link', 'nieuw.txt'), true)).resolves.toBe(false);
    await expect(assertRealPathInsideRoot(root, path.join('link', 'nieuw.txt'), true)).rejects.toThrow(/veilig.*werkmap/i);
  });

  it('staat een werkmap toe die zelf via een junction bereikbaar is', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const realRoot = path.join(base, 'echte-root');
    const junctionRoot = path.join(base, 'documents-root');
    await fs.promises.mkdir(realRoot, { recursive: true });
    await fs.promises.symlink(realRoot, junctionRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(isRealPathInsideRoot(junctionRoot, 'nieuw.py', true)).resolves.toBe(true);
    await fs.promises.writeFile(path.join(realRoot, 'bestaand.py'), 'print("ok")');
    await expect(isRealPathInsideRoot(junctionRoot, 'bestaand.py', false)).resolves.toBe(true);
  });

  it('blokkeert ook vanuit een junction-root een geneste junction naar buiten', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const realRoot = path.join(base, 'echte-root');
    const junctionRoot = path.join(base, 'documents-root');
    const outside = path.join(base, 'buiten');
    await fs.promises.mkdir(realRoot, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.symlink(realRoot, junctionRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.promises.symlink(outside, path.join(realRoot, 'ontsnapping'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(isRealPathInsideRoot(junctionRoot, 'ontsnapping/nieuw.py', true)).resolves.toBe(false);
  });

  it('accepteert een absoluut bestaand pad binnen de root en weigert een absoluut pad erbuiten', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const root = path.join(base, 'root');
    const inside = path.join(root, 'binnen.py');
    const outside = path.join(base, 'buiten.py');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(inside, 'print("binnen")');
    await fs.promises.writeFile(outside, 'print("buiten")');

    await expect(isRealPathInsideRoot(root, inside, false)).resolves.toBe(true);
    await expect(isRealPathInsideRoot(root, outside, false)).resolves.toBe(false);
  });

  it('weigert ook een direct lexicaal pad buiten de root', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-path-'));
    cleanup.push(base);
    const root = path.join(base, 'root');
    await fs.promises.mkdir(root, { recursive: true });
    await expect(isRealPathInsideRoot(root, '../buiten.txt', true)).resolves.toBe(false);
  });

  it('keurt in auto-project alleen interne bestandstools automatisch goed', () => {
    expect(canAutoApproveAgentAction('auto-project', 'file-edit', true)).toBe(true);
    expect(canAutoApproveAgentAction('auto-project', 'file-edit', false)).toBe(false);
    expect(canAutoApproveAgentAction('auto-project', 'command', true)).toBe(false);
    expect(canAutoApproveAgentAction('ask', 'file-edit', true)).toBe(false);
    expect(canAutoApproveAgentAction('full', 'file-edit', true)).toBe(false);
  });
});
