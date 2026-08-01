import { describe, expect, it } from 'vitest';
import { linkedTimeoutSignal, shouldPersistProviderFailure } from '../electron/request-lifecycle';

describe('request-lifecycle', () => {
  it('maakt van Stop geen blijvende providerfout', () => {
    expect(shouldPersistProviderFailure('cancelled')).toBe(false);
    expect(shouldPersistProviderFailure('provider_error')).toBe(true);
    expect(shouldPersistProviderFailure('network')).toBe(true);
  });

  it('breekt een vastgelopen vervolg af en ruimt de timer op', async () => {
    const parent = new AbortController();
    let timedOut = false;
    const linked = linkedTimeoutSignal(parent.signal, 5, () => { timedOut = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(linked.signal.aborted).toBe(true);
    expect(timedOut).toBe(true);
    linked.dispose();
  });

  it('neemt een handmatige Stop direct over', () => {
    const parent = new AbortController();
    const linked = linkedTimeoutSignal(parent.signal, 10_000);
    parent.abort('gestopt');
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe('gestopt');
    linked.dispose();
  });
});
