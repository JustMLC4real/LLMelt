/**
 * Sommige providers geven bij hun eerste processtart al een geldige, maar nog
 * niet bijgewerkte catalogus terug. Vraag na een korte opwarmperiode nogmaals
 * expliciet vers op; een niet-lege eerste snapshot is dus niet automatisch het
 * definitieve resultaat.
 */
export const LIVE_CATALOG_SETTLE_DELAYS_MS = [1_500, 4_500] as const;

export async function settleLiveCatalog<T>(options: {
  refresh: () => Promise<T>;
  apply: (snapshot: T) => void;
  isCancelled?: () => boolean;
  delays?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const delays = options.delays || LIVE_CATALOG_SETTLE_DELAYS_MS;
  const wait = options.wait || ((milliseconds: number) => new Promise<void>(
    (resolve) => window.setTimeout(resolve, milliseconds),
  ));
  let applied = 0;

  for (const delay of delays) {
    if (options.isCancelled?.()) break;
    if (delay > 0) await wait(delay);
    if (options.isCancelled?.()) break;
    try {
      const snapshot = await options.refresh();
      if (options.isCancelled?.()) break;
      options.apply(snapshot);
      applied += 1;
    } catch {
      // Een tijdelijke providerfout mag de volgende stabilisatiepoging niet
      // overslaan; de laatst-bekend-goede catalogus blijft ondertussen staan.
    }
  }

  return applied;
}
