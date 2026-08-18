import { describe, expect, it, vi } from 'vitest';
import {
  LANGUAGE_FADE_IN_MS,
  LANGUAGE_FADE_OUT_MS,
  runLanguageTransition,
  type LanguageTransitionEnvironment,
} from './language-transition';

function transitionEnvironment(overrides: Partial<LanguageTransitionEnvironment> = {}) {
  const active = new Set<string>();
  const classList = {
    add: (...names: string[]) => names.forEach((name) => active.add(name)),
    remove: (...names: string[]) => names.forEach((name) => active.delete(name)),
  } as Pick<DOMTokenList, 'add' | 'remove'>;
  const environment: LanguageTransitionEnvironment = {
    classList,
    reducedMotion: false,
    nextFrame: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
  return { active, environment };
}

describe('appbrede taalovergang', () => {
  it('laat Chromium de taalupdate binnen één documentovergang uitvoeren', async () => {
    const update = vi.fn(async () => {});
    const startViewTransition = vi.fn((callback: () => Promise<void>) => ({
      finished: callback(),
    }));
    const { active, environment } = transitionEnvironment({ startViewTransition });

    await runLanguageTransition(update, environment);

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(active.size).toBe(0);
  });

  it('verbergt eerst de hele renderer wanneer de browser-API ontbreekt', async () => {
    const snapshots: string[][] = [];
    const { active, environment } = transitionEnvironment();
    const update = vi.fn(async () => {
      snapshots.push([...active]);
    });

    await runLanguageTransition(update, environment);

    expect(update).toHaveBeenCalledOnce();
    expect(snapshots[0]).toContain('language-transition-fallback-out');
    expect(environment.nextFrame).toHaveBeenCalledTimes(3);
    expect(environment.wait).toHaveBeenNthCalledWith(1, LANGUAGE_FADE_OUT_MS);
    expect(environment.wait).toHaveBeenNthCalledWith(2, LANGUAGE_FADE_IN_MS);
    expect(active.size).toBe(0);
  });

  it('respecteert verminderde beweging en voert de update direct uit', async () => {
    const update = vi.fn(async () => {});
    const { active, environment } = transitionEnvironment({ reducedMotion: true });

    await runLanguageTransition(update, environment);

    expect(update).toHaveBeenCalledOnce();
    expect(environment.nextFrame).not.toHaveBeenCalled();
    expect(environment.wait).not.toHaveBeenCalled();
    expect(active.size).toBe(0);
  });
});
