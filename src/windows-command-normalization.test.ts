import { describe, expect, it } from 'vitest';
import { normalizePowerShell5ConditionalChain } from '../electron/windows-command-normalization';

describe('Windows PowerShell 5.1-commandonormalisatie', () => {
  it('vertaalt een success-chain naar geldige PowerShell 5.1-syntax', () => {
    expect(normalizePowerShell5ConditionalChain(
      'python een.py && python twee.py',
      'powershell',
      'win32',
    )).toBe('python een.py; if (-not $?) { exit 1 }; python twee.py');
  });

  it('vertaalt meerdere opeenvolgende stappen zonder de laatste stap te bewaken', () => {
    const normalized = normalizePowerShell5ConditionalChain(
      'python een.py && python twee.py && python drie.py',
      'powershell',
      'win32',
    );
    expect(normalized.match(/if \(-not \$\?\)/g)).toHaveLength(2);
    expect(normalized).toMatch(/python drie\.py$/);
  });

  it('laat operators binnen quotes en andere shells ongemoeid', () => {
    expect(normalizePowerShell5ConditionalChain(
      'python -c "print(\'a && b\')"',
      'powershell',
      'win32',
    )).toBe('python -c "print(\'a && b\')"');
    expect(normalizePowerShell5ConditionalChain('a && b', 'pwsh', 'win32')).toBe('a && b');
    expect(normalizePowerShell5ConditionalChain('a && b', 'cmd', 'win32')).toBe('a && b');
    expect(normalizePowerShell5ConditionalChain('a && b', 'powershell', 'linux')).toBe('a && b');
  });
});
