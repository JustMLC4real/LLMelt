import { describe, expect, it, vi } from 'vitest';
import { createSerialTaskQueue } from './serial-task-queue';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('serial-task-queue', () => {
  it('start een tweede taak pas nadat de eerste klaar is', async () => {
    const queue = createSerialTaskQueue();
    const firstDone = deferred();
    const firstStarted = deferred();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push('eerste-start');
      firstStarted.resolve();
      await firstDone.promise;
      order.push('eerste-klaar');
    });
    const second = queue.run(async () => {
      order.push('tweede-start');
    });

    await firstStarted.promise;
    expect(order).toEqual(['eerste-start']);
    firstDone.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['eerste-start', 'eerste-klaar', 'tweede-start']);
  });

  it('voorkomt dat twee chats hetzelfde antwoord uit een gedeelde buffer lezen', async () => {
    const queue = createSerialTaskQueue();
    const firstStarted = deferred();
    const firstMayFinish = deferred();
    let sharedBrowserBuffer = '';

    const chatA = queue.run(async () => {
      sharedBrowserBuffer = 'antwoord voor chat A';
      firstStarted.resolve();
      await firstMayFinish.promise;
      return sharedBrowserBuffer;
    });
    const chatB = queue.run(async () => {
      sharedBrowserBuffer = 'antwoord voor chat B';
      return sharedBrowserBuffer;
    });

    await firstStarted.promise;
    expect(sharedBrowserBuffer).toBe('antwoord voor chat A');
    firstMayFinish.resolve();
    await expect(Promise.all([chatA, chatB])).resolves.toEqual([
      'antwoord voor chat A',
      'antwoord voor chat B',
    ]);
  });

  it('meldt wanneer een taak op een voorganger wacht', async () => {
    const queue = createSerialTaskQueue();
    const firstDone = deferred();
    const onWait = vi.fn();

    const first = queue.run(() => firstDone.promise);
    const second = queue.run(async () => undefined, { onWait });
    expect(onWait).toHaveBeenCalledOnce();
    firstDone.resolve();
    await Promise.all([first, second]);
  });

  it('voert een geannuleerde wachtende taak niet later alsnog uit', async () => {
    const queue = createSerialTaskQueue();
    const firstDone = deferred();
    const controller = new AbortController();
    const skipped = vi.fn();
    const third = vi.fn();

    const first = queue.run(() => firstDone.promise);
    const second = queue.run(async () => skipped(), { signal: controller.signal });
    const last = queue.run(async () => third());
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(skipped).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    firstDone.resolve();
    await Promise.all([first, last]);
    expect(third).toHaveBeenCalledOnce();
    expect(queue.pendingCount).toBe(0);
  });
});
