import { describe, expect, it } from 'vitest';
import {
  allowsPrerelease,
  buildUpdateChannel,
  isChannelOverridden,
  isEmptyChannelError,
  normalizeUpdateChannel,
  resolveUpdateChannel,
} from './update-channel';

describe('updatekanaal', () => {
  it('accepteert alleen de twee bekende kanalen', () => {
    expect(normalizeUpdateChannel('stable')).toBe('stable');
    expect(normalizeUpdateChannel('  PRERELEASE ')).toBe('prerelease');
    expect(normalizeUpdateChannel('beta')).toBeUndefined();
    expect(normalizeUpdateChannel(undefined)).toBeUndefined();
    expect(normalizeUpdateChannel(3)).toBeUndefined();
  });

  it('valt zonder bruikbaar buildkanaal terug op stabiel', () => {
    expect(buildUpdateChannel('prerelease')).toBe('prerelease');
    expect(buildUpdateChannel(undefined)).toBe('stable');
    expect(buildUpdateChannel('nightly')).toBe('stable');
  });

  it('laat een prereleasebuild standaard prereleases volgen', () => {
    expect(resolveUpdateChannel(undefined, 'prerelease')).toBe('prerelease');
    expect(resolveUpdateChannel(undefined, 'stable')).toBe('stable');
  });

  it('geeft de keuze van de gebruiker voorrang op het buildkanaal', () => {
    expect(resolveUpdateChannel('stable', 'prerelease')).toBe('stable');
    expect(resolveUpdateChannel('prerelease', 'stable')).toBe('prerelease');
    // Onzin uit de opslag mag de build niet overrulen.
    expect(resolveUpdateChannel('nightly', 'prerelease')).toBe('prerelease');
  });

  it('vertaalt het kanaal naar allowPrerelease', () => {
    expect(allowsPrerelease('prerelease')).toBe(true);
    expect(allowsPrerelease('stable')).toBe(false);
  });

  it('herkent een leeg kanaal aan de melding van de provider', () => {
    // De echte tekst die GitHub's provider teruggeeft als er geen stabiele
    // release bestaat; dat is geen storing maar een leeg kanaal.
    expect(isEmptyChannelError(
      'Cannot parse releases feed: Error: Unable to find latest version on GitHub'
      + ' (https://github.com/JustMLC4real/LLMelt/releases/latest), please ensure a production'
      + ' release exists: HttpError: 406',
    )).toBe(true);
    expect(isEmptyChannelError('No published versions on GitHub')).toBe(true);
    expect(isEmptyChannelError('net::ERR_INTERNET_DISCONNECTED')).toBe(false);
    expect(isEmptyChannelError(undefined)).toBe(false);
  });

  it('herkent wanneer de gebruiker van zijn buildkanaal afwijkt', () => {
    expect(isChannelOverridden('stable', 'prerelease')).toBe(true);
    expect(isChannelOverridden('prerelease', 'prerelease')).toBe(false);
    expect(isChannelOverridden(undefined, 'prerelease')).toBe(false);
  });
});
