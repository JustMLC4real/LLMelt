import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import nl from './locales/nl.json';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key));
}

function leafValues(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return typeof value === 'string' ? [value] : [];
  }
  return Object.values(value as Record<string, unknown>).flatMap(leafValues);
}

describe('locale-pariteit', () => {
  it('houdt alle Nederlandse en Engelse vertaalsleutels symmetrisch', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(nl).sort());
  });

  it('bevat geen lege zichtbare vertalingen', () => {
    expect(leafValues(en).every((value) => value.trim().length > 0)).toBe(true);
    expect(leafValues(nl).every((value) => value.trim().length > 0)).toBe(true);
  });

  it('lokaliseert kernstatussen en goedkeuringen echt naar Engels', () => {
    expect(en.chat.approval.allow).toBe('Allow');
    expect(en.models.cliAuthRequired).toBe('CLI sign-in required');
    expect(en.autoMode.phases.responder.title).toContain('responder');
    expect(en.terminal.notFound).toBe('not found');
  });
});
