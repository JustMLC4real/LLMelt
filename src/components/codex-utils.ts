import type { ServiceTier } from '../providers/types';

function tierValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((tier: any) => (typeof tier === 'string' ? tier : (tier?.id || tier?.name || tier?.slug || tier?.tier)))
    .filter((s: any): s is string => typeof s === 'string' && !!s.trim())
    .map((s: string) => s.trim());
}

export function codexServiceTiersFromCatalog(model: any): ServiceTier[] {
  const speed = tierValues(model?.additional_speed_tiers || model?.additionalSpeedTiers);
  // Alleen echt geadverteerde overrides horen in de capabilitylijst. De UI voegt
  // zelf een lege `Standaard`-keuze toe, die bewust geen CLI-argument
  // verstuurt. Zo ontstaan geen dubbele Standard/default-keuzes.
  return Array.from(new Set(speed.filter((tier) => {
    const normalized = tier.toLowerCase();
    return normalized !== 'standard' && normalized !== 'default';
  })));
}

export function codexCliServiceTier(value: unknown, advertised: ServiceTier[]): ServiceTier | undefined {
  if (typeof value !== 'string') return undefined;
  const tier = value.trim();
  if (!tier || tier === 'standard') return undefined;
  return advertised.includes(tier) ? tier : undefined;
}

/** Eerste preflight gebruikt uitsluitend de gevraagde CLI-opdracht. */
export function codexSafePreflightArgs(...command: string[]) {
  return command;
}

/**
 * Een verouderde config kan de CLI al vóór de opdracht laten stoppen. Lees in
 * dat geval de door deze geïnstalleerde CLI genoemde geldige waarden en probeer
 * met de eerste live waarde opnieuw, zonder ingebouwde fast/flex-allowlist.
 */
export function codexRecoveredPreflightArgs(errorText: string, ...command: string[]) {
  const expected = String(errorText).match(/\bexpected\s+([^\r\n]+)/i)?.[1] || '';
  const advertised = Array.from(expected.matchAll(/[`'"]([a-z][a-z0-9._-]*)[`'"]/gi), (match) => match[1]);
  const tier = advertised[0];
  return tier ? ['-c', `service_tier="${tier}"`, ...command] : undefined;
}
