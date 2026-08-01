import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type BraceExpansionCompat = ((pattern: string) => string[]) & {
  expand: (pattern: string) => string[]
}

const require = createRequire(import.meta.url)
const braceExpansion = require('brace-expansion') as BraceExpansionCompat

describe('brace-expansion compatibiliteitslaag', () => {
  it('ondersteunt zowel oude CommonJS- als moderne named-export-consumers', () => {
    expect(typeof braceExpansion).toBe('function')
    expect(braceExpansion('bestand-{a,b}.txt')).toEqual([
      'bestand-a.txt',
      'bestand-b.txt',
    ])
    expect(braceExpansion.expand('deel-{1..3}')).toEqual([
      'deel-1',
      'deel-2',
      'deel-3',
    ])
  })
})
