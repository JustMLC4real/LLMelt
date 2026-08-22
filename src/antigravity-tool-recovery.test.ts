import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverUnreportedAntigravityTool } from '../electron/antigravity-tool-recovery';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

describe('Antigravity-toolherstel na vroege CLI-exit', () => {
  it('bevestigt een exact geschreven bestand zonder de tool opnieuw uit te voeren', async () => {
    const cwd = await freshDirectory();
    await fs.promises.writeFile(path.join(cwd, 'skyline.py'), 'print("ok")\r\n', 'utf8');

    await expect(recoverUnreportedAntigravityTool({
      name: 'write_to_file',
      input: { TargetFile: path.join(cwd, 'skyline.py'), CodeContent: 'print("ok")\n' },
    }, cwd)).resolves.toMatchObject({ ok: true });
  });

  it('claimt geen succes bij afwijkende inhoud of een pad buiten de werkmap', async () => {
    const cwd = await freshDirectory();
    const outside = await freshDirectory();
    await fs.promises.writeFile(path.join(cwd, 'skyline.py'), 'anders', 'utf8');
    await fs.promises.writeFile(path.join(outside, 'outside.py'), 'verwacht', 'utf8');

    await expect(recoverUnreportedAntigravityTool({
      name: 'write_to_file',
      input: { TargetFile: 'skyline.py', CodeContent: 'verwacht' },
    }, cwd)).resolves.toMatchObject({ ok: false });
    await expect(recoverUnreportedAntigravityTool({
      name: 'write_to_file',
      input: { TargetFile: path.join(outside, 'outside.py'), CodeContent: 'verwacht' },
    }, cwd)).resolves.toBeNull();
  });
});

async function freshDirectory() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'llmelt-antigravity-recovery-'));
  tempDirectories.push(directory);
  return directory;
}
