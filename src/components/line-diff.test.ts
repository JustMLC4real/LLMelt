import { describe, expect, it } from 'vitest';
import { changedLineDiff } from './line-diff';

describe('changedLineDiff', () => {
  it('laat bij verspreide bewerkingen alleen gewijzigde regels zien', () => {
    expect(changedLineDiff(
      ['een', 'oud A', 'blijft', 'oud B', 'einde'].join('\n'),
      ['een', 'nieuw A', 'blijft', 'nieuw B', 'einde'].join('\n'),
    )).toEqual([
      { type: 'remove', text: 'oud A' },
      { type: 'add', text: 'nieuw A' },
      { type: 'remove', text: 'oud B' },
      { type: 'add', text: 'nieuw B' },
    ]);
  });

  it('behandelt een nieuw bestand als uitsluitend toegevoegde regels', () => {
    expect(changedLineDiff('', 'regel 1\nregel 2')).toEqual([
      { type: 'add', text: 'regel 1' },
      { type: 'add', text: 'regel 2' },
    ]);
  });

  it('lokaliseert de begrenzing van een lange diff', () => {
    const before = ['oud 1', 'oud 2', 'oud 3'].join('\n');
    const after = ['nieuw 1', 'nieuw 2', 'nieuw 3'].join('\n');

    expect(changedLineDiff(before, after, 1, 'nl').at(-1)?.text).toContain('gewijzigde regels afgekapt');
    expect(changedLineDiff(before, after, 1, 'en').at(-1)?.text).toContain('changed lines truncated');
  });
});
