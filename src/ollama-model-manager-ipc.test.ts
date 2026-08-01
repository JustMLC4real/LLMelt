import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc-handlers.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'src', 'components', 'OllamaModelManager.tsx'), 'utf8');

const channels = [
  'ollama:listInstalled',
  'ollama:searchLibrary',
  'ollama:listLibraryTags',
  'ollama:pullModel',
  'ollama:cancelPull',
  'ollama:deleteModel',
  'ollama:openLibrary',
  'ollama:modelPullProgress',
];

describe('Ollama-modelbeheer IPC-contract', () => {
  it('registreert elk renderer-kanaal ook in het main-proces', () => {
    for (const channel of channels) {
      expect(preloadSource, `preload mist ${channel}`).toContain(channel);
      expect(ipcSource, `main mist ${channel}`).toContain(channel);
    }
  });

  it('haalt de Ollama-URL uitsluitend uit de beveiligde settingslaag', () => {
    const listHandler = ipcSource.slice(
      ipcSource.indexOf("ipcMain.handle('ollama:listInstalled'"),
      ipcSource.indexOf("ipcMain.handle('runtime:getStatus'"),
    );
    expect(listHandler).toContain('ollamaTitleBaseUrl()');
    expect(listHandler).not.toMatch(/\(_event,\s*baseUrl/);
    expect(listHandler).not.toContain('shell.exec');
  });

  it('biedt ook zonder online zoekresultaten een exacte modelnaam en officiële bibliotheeklink', () => {
    expect(settingsSource).toContain('Exacte modelnaam');
    expect(settingsSource).toContain('openLibrary');
    expect(settingsSource).toContain('pullModel');
    expect(settingsSource).toContain('deleteModel');
    expect(settingsSource).toContain('cancelPull');
  });
});
