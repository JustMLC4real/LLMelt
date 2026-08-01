import type { ServiceTier } from '../providers/types';

function tierValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((tier: any) => (typeof tier === 'string' ? tier : (tier?.id || tier?.name || tier?.slug || tier?.tier)))
    .filter((s: any): s is string => typeof s === 'string' && !!s.trim())
    .map((s: string) => s.trim());
}

export function codexServiceTiersFromCatalog(model: any): ServiceTier[] {
  const speed = tierValues(model?.additional_speed_tiers || model?.additionalSpeedTiers)
    .filter((tier) => tier === 'fast' || tier === 'flex');
  return Array.from(new Set(['standard', ...speed]));
}

export function codexCliServiceTier(value: unknown): ServiceTier | undefined {
  return value === 'fast' || value === 'flex' ? value : undefined;
}

/** Overschrijft een verouderde service_tier zonder versiegebonden CLI-vlaggen. */
export function codexSafePreflightArgs(...command: string[]) {
  return ['-c', 'service_tier="fast"', ...command];
}
