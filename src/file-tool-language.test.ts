import { describe, expect, it } from 'vitest';
import {
  fileCreatedDetail,
  fileEditedDetail,
  fileReadDetail,
  fileUnchangedDetail,
} from '../electron/file-tool-language';

describe('native file-tooldetails', () => {
  it('maakt dezelfde feitelijke details in Nederlands en Engels', () => {
    expect(fileReadDetail('demo.txt', 12, 'nl')).toBe('gelezen demo.txt (12 tekens)');
    expect(fileReadDetail('demo.txt', 12, 'en')).toBe('read demo.txt (12 chars)');
    expect(fileUnchangedDetail('demo.txt', 12, 'nl')).toBe('ongewijzigd demo.txt (12 tekens)');
    expect(fileUnchangedDetail('demo.txt', 12, 'en')).toBe('unchanged demo.txt (12 chars)');
    expect(fileCreatedDetail('demo.txt', 12, 'nl')).toBe('gemaakt demo.txt (12 tekens)');
    expect(fileCreatedDetail('demo.txt', 12, 'en')).toBe('created demo.txt (12 chars)');
    expect(fileEditedDetail('demo.txt', -2, 'nl')).toBe('bewerkt demo.txt (-2 tekens)');
    expect(fileEditedDetail('demo.txt', -2, 'en')).toBe('edited demo.txt (-2 chars)');
  });
});
