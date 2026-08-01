import type { FallbackReason } from '../src/providers/types';

/** Stop is een normale lifecycle-uitkomst en hoort geen providerfout in de chat op te slaan. */
export function shouldPersistProviderFailure(reason: FallbackReason) {
  return reason !== 'cancelled';
}

/** Koppelt Stop aan een lokale timeout zonder de bovenliggende controller te muteren. */
export function linkedTimeoutSignal(parent: AbortSignal, timeoutMs: number, onTimeout?: () => void) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    onTimeout?.();
    controller.abort(new Error(`Timeout na ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}
