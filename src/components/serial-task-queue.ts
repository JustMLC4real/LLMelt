export interface SerialTaskOptions {
  signal?: AbortSignal;
  onWait?: () => void;
}

export interface SerialTaskQueue {
  readonly pendingCount: number;
  run<T>(task: () => Promise<T>, options?: SerialTaskOptions): Promise<T>;
}

function abortError() {
  const error = new Error('Aanvraag geannuleerd.');
  error.name = 'AbortError';
  return error;
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal) {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) throw abortError();

  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortError());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Voert taken strikt na elkaar uit. Een geannuleerde wachtende taak slaat zijn
 * werk over, maar verbreekt de volgorde voor latere taken niet.
 */
export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return {
    get pendingCount() {
      return pendingCount;
    },

    async run<T>(task: () => Promise<T>, options: SerialTaskOptions = {}) {
      const previous = tail.catch(() => undefined);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = previous.then(() => gate);

      const mustWait = pendingCount > 0;
      pendingCount += 1;
      try {
        if (mustWait) options.onWait?.();
        await waitForTurn(previous, options.signal);
        if (options.signal?.aborted) throw abortError();
        return await task();
      } finally {
        pendingCount -= 1;
        release();
      }
    },
  };
}
