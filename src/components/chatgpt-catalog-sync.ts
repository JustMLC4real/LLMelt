import type { AIModel, ChatgptVersion } from '../providers/types';

export interface ChatgptCatalogSnapshot {
  models: AIModel[];
  versions: ChatgptVersion[];
  sessionActive: boolean;
}

export const CHATGPT_CATALOG_RETRY_DELAYS_MS = [0, 1_000, 2_500, 5_000, 10_000] as const;

export function enabledChatgptModelIds(versions: ChatgptVersion[]) {
  const ids = new Set<string>();
  for (const version of versions) {
    if (!version.enabled) continue;
    if (version.presets.length) {
      for (const preset of version.presets) {
        if (preset.available) ids.add(`chatgpt:${preset.modelSlug}`);
      }
      continue;
    }
    for (const slug of version.slugs) ids.add(`chatgpt:${slug}`);
  }
  return ids;
}

/**
 * Modellen en versies komen uit dezelfde live endpoint, maar worden in twee
 * rendererstores bewaard. Laat een stale models-snapshot daarom nooit combineren
 * met nieuwere presets (of andersom): alleen de kruising is bruikbaar.
 */
export function modelsInCurrentChatgptCatalog(models: AIModel[], versions: ChatgptVersion[]) {
  const enabledIds = enabledChatgptModelIds(versions);
  return models.filter((model) => (
    model.provider !== 'openai'
    || !model.id.startsWith('chatgpt:')
    || enabledIds.has(model.id)
  ));
}

export function isChatgptCatalogReady(models: AIModel[], versions: ChatgptVersion[]) {
  const enabledIds = enabledChatgptModelIds(versions);
  return models.some((model) => enabledIds.has(model.id));
}

export async function retryChatgptCatalog(options: {
  load: () => Promise<ChatgptCatalogSnapshot>;
  apply: (snapshot: ChatgptCatalogSnapshot) => void;
  isCancelled?: () => boolean;
  delays?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const delays = options.delays || CHATGPT_CATALOG_RETRY_DELAYS_MS;
  const wait = options.wait || ((milliseconds: number) => new Promise<void>(
    (resolve) => window.setTimeout(resolve, milliseconds),
  ));

  for (const delay of delays) {
    if (options.isCancelled?.()) return false;
    if (delay > 0) await wait(delay);
    if (options.isCancelled?.()) return false;

    try {
      const snapshot = await options.load();
      if (options.isCancelled?.()) return false;
      options.apply(snapshot);
      if (!snapshot.sessionActive) return false;
      if (isChatgptCatalogReady(snapshot.models, snapshot.versions)) return true;
    } catch {
      // Een sessie kan net na login nog niet door /backend-api/models worden
      // bediend. De volgende poging haalt dezelfde live catalogus opnieuw op.
    }
  }

  return false;
}
