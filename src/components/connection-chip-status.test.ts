import { describe, expect, it } from 'vitest';
import { cliConnectionChipStatus } from './connection-chip-status';

describe('CLI-verbindingslampje', () => {
  it('is online bij auth of een live leesbare catalogus', () => {
    expect(cliConnectionChipStatus({ authenticated: true, hasLiveCatalog: false, refreshing: false })).toBe('online');
    expect(cliConnectionChipStatus({ authenticated: false, hasLiveCatalog: true, refreshing: false })).toBe('online');
  });

  it('wordt pas rood nadat detectie echt klaar en mislukt is', () => {
    expect(cliConnectionChipStatus({ authenticated: false, hasLiveCatalog: false, refreshing: true })).toBe('limited');
    expect(cliConnectionChipStatus({ authenticated: false, hasLiveCatalog: false, refreshing: false })).toBe('offline');
  });
});
