import { describe, expect, it } from 'vitest';
import { agentToolEnvironmentInstructions, agentToolInstructions } from '../../electron/agent-tool-instructions';
import { nativeToolResponseInstructions } from '../../electron/native-response-instructions';
import { localizedText, normalizeUiLanguage } from './language';

describe('UI-taalcontract', () => {
  it('normaliseert volledige localecodes en gebruikt een expliciete fallback', () => {
    expect(normalizeUiLanguage('nl-NL')).toBe('nl');
    expect(normalizeUiLanguage('EN_us')).toBe('en');
    expect(normalizeUiLanguage('de-DE', 'nl')).toBe('nl');
  });

  it('kiest uitsluitend tekst uit de gevraagde taal', () => {
    expect(localizedText('nl', 'Nederlands', 'English')).toBe('Nederlands');
    expect(localizedText('en', 'Nederlands', 'English')).toBe('English');
  });

  it('geeft tool- en antwoordinstructies volledig in de gekozen taal door', () => {
    const nlTools = agentToolInstructions('nl');
    const enTools = agentToolInstructions('en');
    const nlResponse = nativeToolResponseInstructions('nl');
    const enResponse = nativeToolResponseInstructions('en');

    expect(nlTools).toContain('BELANGRIJK - TOOLTOEGANG');
    expect(nlTools).not.toContain('IMPORTANT - TOOL ACCESS');
    expect(enTools).toContain('IMPORTANT - TOOL ACCESS');
    expect(enTools).not.toContain('BELANGRIJK - TOOLTOEGANG');
    expect(nlResponse).toContain('Na gebruik van tools');
    expect(nlResponse).not.toContain('After using tools');
    expect(enResponse).toContain('After using tools');
    expect(enResponse).not.toContain('Na gebruik van tools');
  });

  it('lokaliseert ook de verborgen Windows-shellinstructies', () => {
    const nl = agentToolEnvironmentInstructions('powershell', 'win32', 'nl');
    const en = agentToolEnvironmentInstructions('powershell', 'win32', 'en');

    expect(nl).toContain('COMMANDO-OMGEVING');
    expect(nl).toContain('Windows PowerShell 5.1');
    expect(nl).not.toContain('COMMAND ENVIRONMENT');
    expect(en).toContain('COMMAND ENVIRONMENT');
    expect(en).toContain('Windows PowerShell 5.1');
    expect(en).not.toContain('COMMANDO-OMGEVING');
  });
});
