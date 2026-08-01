import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parsePythonInstallerProgress,
  parsePythonVersion,
  prependPathEntry,
  PYTHON_INSTALL_MANAGER_PACKAGE_ID,
  pythonInstallManagerCommands,
  pythonRuntimeEnvironment,
} from '../electron/python-runtime';

describe('Python-runtime', () => {
  it('accepteert alleen echte Python-versie-uitvoer', () => {
    expect(parsePythonVersion('Python 3.14.5\r\n')).toBe('Python 3.14.5');
    expect(parsePythonVersion('Python 3.15.0rc1')).toBe('Python 3.15.0rc1');
    expect(parsePythonVersion('Open de Microsoft Store om Python te installeren')).toBeNull();
  });

  it('leidt alleen uit echte manageruitvoer een downloadpercentage af', () => {
    expect(parsePythonInstallerProgress('  7.2 MB / 24 MB')).toEqual({
      percent: 30,
      transferred: Math.round(7.2 * 1024 ** 2),
      total: 24 * 1024 ** 2,
    });
    expect(parsePythonInstallerProgress('Downloading... 48.6%')).toEqual({ percent: 49 });
    expect(parsePythonInstallerProgress('Python Install Manager configureren...')).toBeNull();
  });

  it('zet het gevonden runtimepad vooraan zonder duplicaten', () => {
    const entry = path.resolve('C:/Python/bin');
    const current = [path.resolve('C:/Windows'), entry, path.resolve('C:/Tools')].join(path.delimiter);
    const result = prependPathEntry(current, entry).split(path.delimiter);
    expect(result[0]).toBe(entry);
    expect(result.filter((item) => path.resolve(item) === entry)).toHaveLength(1);
  });

  it('voegt alleen een absoluut ingesteld Pythonpad aan de commandomgeving toe', () => {
    const executable = path.resolve('C:/Python/bin/python.exe');
    const env = pythonRuntimeEnvironment({
      PATH: path.resolve('C:/Windows'),
      AI_SUPERAPP_PYTHON: executable,
    });
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(executable));
  });

  it('gebruikt de officiële manager-id en installeert Python 3 zonder interactieve prompt', () => {
    expect(PYTHON_INSTALL_MANAGER_PACKAGE_ID).toBe('9NQ7512CXL7T');
    expect(pythonInstallManagerCommands()).toEqual([
      {
        phase: 'configuring',
        status: 'Python Install Manager configureren...',
        args: ['install', '--configure', '-y'],
      },
      {
        phase: 'installing',
        status: 'Nieuwste stabiele Python 3-runtime installeren...',
        args: ['install', '3', '-y'],
      },
    ]);
  });
});
