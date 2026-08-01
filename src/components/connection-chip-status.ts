export type ConnectionChipStatus = 'online' | 'limited' | 'offline';

/**
 * Een live catalogus is voor CLI-providers dezelfde geldige fallback als in de
 * backend. Tijdens detectie tonen we "bezig" en geen voortijdige rode fout.
 */
export function cliConnectionChipStatus(options: {
  authenticated: boolean;
  hasLiveCatalog: boolean;
  refreshing: boolean;
}): ConnectionChipStatus {
  if (options.authenticated || options.hasLiveCatalog) return 'online';
  return options.refreshing ? 'limited' : 'offline';
}
