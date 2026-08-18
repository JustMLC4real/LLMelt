import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type i18n } from 'i18next';
import type { CommandRun } from '../providers/types';
import nl from '../i18n/locales/nl.json';
import en from '../i18n/locales/en.json';
import { localizedCommandRunGroupLabel, localizedCommandRunStatusLabel } from './CommandRunActivity';

const completedRun: CommandRun = {
  id: 'run-1',
  source: 'model',
  command: 'npm test',
  shell: 'powershell',
  cwd: 'C:\\project',
  status: 'completed',
  stdout: '',
  stderr: '',
  exitCode: 0,
  startedAt: '2026-08-11T10:00:00.000Z',
  endedAt: '2026-08-11T10:00:01.000Z',
  durationMs: 1000,
};

let translations: i18n;

beforeAll(async () => {
  translations = createInstance();
  await translations.init({
    lng: 'nl',
    fallbackLng: 'nl',
    resources: { nl: { translation: nl }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});

describe('gelokaliseerde commandoruns', () => {
  it('vertaalt groeps- en afsluitstatussen zonder de commandodata te veranderen', async () => {
    const group = { key: 'group', runs: [{ key: 'run-1', run: completedRun, live: false }] };

    await translations.changeLanguage('nl');
    expect(localizedCommandRunGroupLabel(group, translations.t)).toBe('Voerde 1 opdracht uit');
    expect(localizedCommandRunStatusLabel(completedRun, Date.now(), translations.t)).toBe('Afsluitcode 0');

    await translations.changeLanguage('en');
    expect(localizedCommandRunGroupLabel(group, translations.t)).toBe('Ran 1 command');
    expect(localizedCommandRunStatusLabel(completedRun, Date.now(), translations.t)).toBe('Exit code 0');
  });

  it('vertaalt een actieve goedkeuringsfase', async () => {
    const group = {
      key: 'approval',
      runs: [{ key: 'approval', phase: 'approval_pending' as const, live: true }],
    };

    await translations.changeLanguage('nl');
    expect(localizedCommandRunGroupLabel(group, translations.t)).toBe('Wacht op goedkeuring');
    await translations.changeLanguage('en');
    expect(localizedCommandRunGroupLabel(group, translations.t)).toBe('Waiting for approval');
  });

  it('vertaalt een eindstatus ook zonder afsluitcode', async () => {
    const failedRun = { ...completedRun, status: 'failed' as const, exitCode: null };
    const finishedRun = { ...completedRun, exitCode: null };

    await translations.changeLanguage('nl');
    expect(localizedCommandRunStatusLabel(failedRun, Date.now(), translations.t)).toBe('Mislukt');
    expect(localizedCommandRunStatusLabel(finishedRun, Date.now(), translations.t)).toBe('Klaar');

    await translations.changeLanguage('en');
    expect(localizedCommandRunStatusLabel(failedRun, Date.now(), translations.t)).toBe('Failed');
    expect(localizedCommandRunStatusLabel(finishedRun, Date.now(), translations.t)).toBe('Done');
  });
});
