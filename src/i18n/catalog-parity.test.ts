import { describe, expect, it } from 'vitest';
import nl from './locales/nl.json';
import en from './locales/en.json';

interface TranslationTree {
  [key: string]: string | TranslationTree;
}

function flatten(tree: TranslationTree, prefix = '', output = new Map<string, string>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') output.set(path, value);
    else flatten(value, path, output);
  }
  return output;
}

function interpolationNames(value: string) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]).sort();
}

describe('NL/EN vertaalcatalogus', () => {
  const nlEntries = flatten(nl as TranslationTree);
  const enEntries = flatten(en as TranslationTree);

  it('heeft in beide talen exact dezelfde sleutels', () => {
    expect([...nlEntries.keys()].sort()).toEqual([...enEntries.keys()].sort());
  });

  it('houdt interpolatievariabelen per vertaling gelijk', () => {
    for (const [key, nlValue] of nlEntries) {
      expect(interpolationNames(nlValue), key).toEqual(interpolationNames(enEntries.get(key) || ''));
    }
  });

  it('bevat geen lege zichtbare vertalingen', () => {
    expect([...nlEntries.values()].filter((value) => !value.trim())).toEqual([]);
    expect([...enEntries.values()].filter((value) => !value.trim())).toEqual([]);
  });
});
