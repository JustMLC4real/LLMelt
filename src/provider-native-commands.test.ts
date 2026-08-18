import { describe, expect, it } from 'vitest';
import { collaborationModesFromResponse, skillsFromResponse } from '../electron/codex-app-server';
import { nativeCliModeCommands, nativeCodexCommands } from '../electron/provider-native-commands';

describe('native providercommands', () => {
  it('neemt collaboration modes en skills live uit Codex App Server over', () => {
    const collaborationModes = collaborationModesFromResponse({
      data: [{ name: 'Plan', mode: 'plan', model: 'future-model', reasoning_effort: 'future-effort' }],
    });
    const skills = skillsFromResponse({
      data: [{ cwd: 'C:/project', skills: [{ name: 'release audit', description: 'Audit release', path: 'C:/skills/release', enabled: true }] }],
    });
    const commands = nativeCodexCommands({ collaborationModes, skills, goal: true, review: true }, 'en');

    expect(commands.find((command) => command.kind === 'collaboration-mode')).toMatchObject({
      slash: '/plan', mode: 'plan', model: 'future-model', reasoningEffort: 'future-effort', source: 'app-server',
    });
    expect(commands.find((command) => command.kind === 'skill')).toMatchObject({
      slash: '/skill-release-audit', name: 'release audit', path: 'C:/skills/release',
    });
    expect(commands.some((command) => command.kind === 'goal' && command.slash === '/goal')).toBe(true);
    expect(commands.some((command) => command.kind === 'review' && command.slash === '/review')).toBe(true);
    expect(commands.some((command) => command.id.endsWith(':terminal'))).toBe(false);
  });

  it('verbergt uitgeschakelde skills', () => {
    expect(skillsFromResponse({ data: [{ skills: [{ name: 'off', path: 'x', enabled: false }] }] })).toEqual([]);
  });

  it('toont alleen live ontdekte, headless ondersteunde Claude- en Antigravity-modi', () => {
    expect(nativeCliModeCommands('claude', ['acceptEdits', 'plan'], 'en')).toEqual([
      expect.objectContaining({ provider: 'anthropic', kind: 'collaboration-mode', mode: 'plan', slash: '/plan', source: 'cli-help' }),
    ]);
    expect(nativeCliModeCommands('antigravity', ['accept-edits', 'plan'], 'nl')).toEqual([
      expect.objectContaining({ provider: 'antigravity', kind: 'collaboration-mode', mode: 'plan', slash: '/plan', source: 'cli-help' }),
    ]);
    expect(nativeCliModeCommands('claude', ['acceptEdits'], 'en')).toEqual([]);
  });
});
