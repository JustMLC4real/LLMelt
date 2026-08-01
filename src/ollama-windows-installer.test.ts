import { describe, expect, it } from 'vitest';
import {
  OLLAMA_WINDOWS_INSTALLER_ARGS,
  OLLAMA_WINDOWS_INSTALLER_URL,
  ollamaAuthenticodeVerificationPowerShell,
} from '../electron/ollama-windows-installer';

describe('Ollama Windows-installer', () => {
  it('gebruikt de vaste officiële installer en stille officiële argumenten', () => {
    expect(OLLAMA_WINDOWS_INSTALLER_URL).toBe('https://ollama.com/download/OllamaSetup.exe');
    expect(OLLAMA_WINDOWS_INSTALLER_ARGS).toEqual([
      '/VERYSILENT',
      '/NORESTART',
      '/SUPPRESSMSGBOXES',
    ]);
  });

  it('eist een geldige Authenticode-handtekening van Ollama Inc.', () => {
    const command = ollamaAuthenticodeVerificationPowerShell("C:\\Temp\\Ollama's Setup.exe");
    expect(command).toContain("Get-AuthenticodeSignature -LiteralPath 'C:\\Temp\\Ollama''s Setup.exe'");
    expect(command).toContain("$signature.Status -ne 'Valid'");
    expect(command).toContain('O=Ollama Inc\\.');
    expect(command).toContain('AI_SUPERAPP_OLLAMA_SIGNATURE_VALID');
    expect(command).not.toMatch(/\b(?:irm|iex|Invoke-WebRequest)\b/i);
  });
});
