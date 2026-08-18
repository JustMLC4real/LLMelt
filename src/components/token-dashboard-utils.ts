import type { AIModel, ProviderQuotaSnapshot, TokenDashboard } from '../providers/types';
import { providerSurfaceForModel } from '../providers/quota-display';

/**
 * Modelverbruik is appbreed, terwijl het contextvenster bij het geopende gesprek
 * hoort. Houd die twee scopes bewust gescheiden wanneer de IPC-resultaten worden
 * samengevoegd.
 */
export function mergeTokenDashboards(
  appWide: TokenDashboard,
  currentChat?: TokenDashboard | null,
): TokenDashboard {
  return {
    ...appWide,
    context: currentChat?.context || appWide.context,
  };
}

/** Verwijder verlopen providerwaarnemingen voordat ze als actuele quota verschijnen. */
export function currentQuotaSnapshots(
  snapshots: ProviderQuotaSnapshot[],
  now = Date.now(),
): ProviderQuotaSnapshot[] {
  return snapshots.filter((snapshot) => {
    if (!snapshot.staleAfter) return true;
    const staleAt = Date.parse(snapshot.staleAfter);
    return Number.isFinite(staleAt) && staleAt > now;
  });
}

type UnknownSurface = Pick<ProviderQuotaSnapshot, 'provider' | 'surface'>;

const EXPLICIT_UNKNOWN_SURFACES: UnknownSurface[] = [
  { provider: 'openai', surface: 'api' },
  { provider: 'anthropic', surface: 'api' },
  { provider: 'remote', surface: 'remote' },
];

/**
 * Een actieve API/remote-surface zonder quotatelemetrie is niet hetzelfde als een
 * ontbrekende provider. Toon daarom één expliciete `unknown`-rij per surface, maar
 * nooit naast een echte, actuele snapshot voor dezelfde surface.
 */
export function quotaSnapshotsForDashboard(
  snapshots: ProviderQuotaSnapshot[],
  models: AIModel[],
  now = Date.now(),
): ProviderQuotaSnapshot[] {
  const current = currentQuotaSnapshots(snapshots, now);
  const activeModels = models.filter((model) => model.canChat !== false && model.executionMode !== 'connector');
  const synthetic = EXPLICIT_UNKNOWN_SURFACES.flatMap(({ provider, surface }) => {
    const model = activeModels.find((candidate) => (
      candidate.provider === provider && providerSurfaceForModel(candidate) === surface
    ));
    if (!model) return [];
    if (current.some((snapshot) => snapshot.provider === provider && snapshot.surface === surface)) return [];
    return [{
      id: `dashboard-unknown:${provider}:${surface}`,
      provider,
      surface,
      limitGroupKey: model.limitGroupKey || `${provider}:${surface}`,
      state: 'unknown',
      source: 'unknown',
      accuracy: 'unavailable',
      observedAt: new Date(now).toISOString(),
      buckets: [],
    } satisfies ProviderQuotaSnapshot];
  });
  return [...current, ...synthetic];
}
