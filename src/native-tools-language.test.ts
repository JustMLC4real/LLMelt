import { describe, expect, it } from 'vitest';
import { nativeAppToolDeclarations, nativeToolInputProtocolError } from '../electron/native-tools';

describe('native toolprotocol per UI-taal', () => {
  it('levert Engelse function declarations voor Gemini en Ollama', () => {
    const declarations = nativeAppToolDeclarations('en');
    expect(declarations.find((tool) => tool.name === 'read_file')?.description).toContain('Read one existing');
    expect(JSON.stringify(declarations)).not.toContain('projectmap');
  });

  it('geeft protocolfouten in de gekozen taal terug', () => {
    expect(nativeToolInputProtocolError('read_file', {}, 'en')).toContain('path is missing');
    expect(nativeToolInputProtocolError('read_file', { path: '.' }, 'en')).toContain('not a folder or wildcard');
    expect(nativeToolInputProtocolError('run_command', {}, 'en')).toBe('run_command.command is missing.');
    expect(nativeToolInputProtocolError('read_file', {}, 'nl')).toContain('pad');
  });
});
