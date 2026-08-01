import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isCodexDesktopExecutable,
  newestBundledCodexExecutable,
} from '../electron/codex-cli-discovery';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('newestBundledCodexExecutable', () => {
  it('prefers the newest versioned CLI over the stale top-level executable', () => {
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-codex-'));
    tempRoots.push(localAppData);
    const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    const oldCli = path.join(bin, 'old-release', 'codex.exe');
    const newCli = path.join(bin, 'new-release', 'codex.exe');
    fs.mkdirSync(path.dirname(oldCli), { recursive: true });
    fs.mkdirSync(path.dirname(newCli), { recursive: true });
    fs.writeFileSync(oldCli, 'old');
    fs.writeFileSync(newCli, 'new');
    fs.utimesSync(oldCli, new Date('2026-07-01'), new Date('2026-07-01'));
    fs.utimesSync(newCli, new Date('2026-07-10'), new Date('2026-07-10'));

    expect(newestBundledCodexExecutable(localAppData)).toBe(newCli);
  });

  it('doorzoekt ook de Programs-installatielocatie van Codex Desktop', () => {
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-superapp-codex-programs-'));
    tempRoots.push(localAppData);
    const regularCli = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'oud', 'codex.exe');
    const programsCli = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'nieuw', 'codex.exe');
    fs.mkdirSync(path.dirname(regularCli), { recursive: true });
    fs.mkdirSync(path.dirname(programsCli), { recursive: true });
    fs.writeFileSync(regularCli, 'old');
    fs.writeFileSync(programsCli, 'new');
    fs.utimesSync(regularCli, new Date('2026-07-01'), new Date('2026-07-01'));
    fs.utimesSync(programsCli, new Date('2026-07-20'), new Date('2026-07-20'));

    expect(newestBundledCodexExecutable(localAppData)).toBe(programsCli);
    expect(isCodexDesktopExecutable(programsCli, localAppData)).toBe(true);
    expect(isCodexDesktopExecutable(path.join(localAppData, 'custom', 'codex.exe'), localAppData)).toBe(false);
  });
});
