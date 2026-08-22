import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => ({ temp: '', userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mockedPaths.userData : mockedPaths.temp),
  },
}));

import { runAntigravityNative } from '../electron/antigravity-native';
import { parseAntigravityModelCatalog } from '../electron/antigravity-model-catalog';
import type { NativeToolActivity } from '../electron/native-tools';
import { NATIVE_TOOL_RESPONSE_INSTRUCTIONS } from '../electron/native-response-instructions';
import { assertSkylineArtifacts } from './provider-live-test-utils';

const integration = process.env.RUN_ANTIGRAVITY_INTEGRATION === '1' ? describe : describe.skip;

integration('Antigravity native integratie', () => {
  let root = '';
  let testModel = '';
  let complexTestModel = '';

  const caseDirectory = async (name: string) => {
    const directory = path.join(root, name);
    await fs.promises.mkdir(directory, { recursive: true });
    return directory;
  };

  const runCase = async (
    cwd: string,
    prompt: string,
    modelId = testModel,
  ) => {
    const exe = process.env.AGY_EXE;
    if (!exe) throw new Error('AGY_EXE ontbreekt voor de Antigravity-integratietest.');
    const activities: NativeToolActivity[] = [];
    const statuses: string[] = [];
    const result = await runAntigravityNative({
      exe,
      modelId,
      prompt,
      cwd,
      agentMode: 'ask',
      signal: AbortSignal.timeout(180_000),
      onDelta: () => {},
      onStatus: (status) => statuses.push(status),
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async () => ({ allow: true }),
    });
    return { result, activities, statuses };
  };

  beforeAll(async () => {
    const exe = process.env.AGY_EXE;
    if (!exe) throw new Error('AGY_EXE ontbreekt voor de Antigravity-integratietest.');
    const liveModels = parseAntigravityModelCatalog(
      execFileSync(exe, ['models'], { encoding: 'utf8', timeout: 30_000 }),
    );
    if (!liveModels.length) throw new Error('Antigravity gaf geen live modellen terug.');
    testModel = process.env.AGY_TEST_MODEL
      || liveModels.find((model) => /(?:^|[-_( ])low(?:\)?$)/i.test(model.id))?.id
      || liveModels[0].id;
    complexTestModel = process.env.AGY_COMPLEX_TEST_MODEL
      || liveModels.find((model) => /(?:^|[-_( ])high(?:\)?$)/i.test(model.id))?.id
      || testModel;
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-agy-integration-'));
    mockedPaths.temp = root;
    mockedPaths.userData = path.join(root, 'user-data');
    await fs.promises.mkdir(mockedPaths.userData, { recursive: true });
  });

  afterAll(async () => {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  });

  it('maakt een bestand, ontvangt toolresultaten en sluit af met een eindantwoord', async () => {
    const cwd = await caseDirectory('smoke');
    const { result, activities } = await runCase(
      cwd,
      [
        'Werk uitsluitend in de huidige projectmap.',
        'Maak met write_to_file het bestand antigravity_native_smoke.txt met exact deze inhoud: ANTIGRAVITY_NATIVE_FILE_OK',
        'Controleer het bestand daarna met view_file.',
        'Antwoord na alle tools exact met: ANTIGRAVITY_NATIVE_TOOL_OK',
      ].join('\n'),
    );

    const fileContent = await fs.promises.readFile(path.join(cwd, 'antigravity_native_smoke.txt'), 'utf8').catch(() => null);
    expect({
      fileContent,
      result: result.text.slice(0, 1_000),
      activities: activities.map((activity) => ({
        name: activity.toolName,
        phase: activity.phase,
        ok: activity.ok,
        output: activity.output?.slice(0, 500),
      })),
    }).toMatchObject({
      fileContent: expect.stringMatching(/^ANTIGRAVITY_NATIVE_FILE_OK\s*$/),
      result: expect.stringContaining('ANTIGRAVITY_NATIVE_TOOL_OK'),
      activities: expect.arrayContaining([
        expect.objectContaining({ phase: 'requested' }),
        expect.objectContaining({ phase: 'result', ok: true }),
      ]),
    });
  }, 190_000);

  it('bouwt de volledige skylineprompt met twee scripts, animatie en succesvolle uitvoer', async () => {
    const cwd = await caseDirectory('skyline');
    const userPrompt = 'Maak nu als Python-script een artistieke stadsskyline tekenen, visueel duidelijk verschillend zijn, ANSI-kleuren en een korte animatie gebruiken, Sla de definitieve scripts op, voer ze allebei uit en toon hier zowel de volledige code als de uiteindelijke terminaluitvoer zonder kleurcodes.';
    const prompt = `System:\n${NATIVE_TOOL_RESPONSE_INSTRUCTIONS}\n\nUser:\n${userPrompt}`;
    const { result, activities } = await runCase(
      cwd,
      prompt,
      complexTestModel,
    );
    const evidence = await assertSkylineArtifacts(cwd, { text: result.text, activities });
    expect(evidence.pythonFiles.length).toBeGreaterThanOrEqual(2);
    expect(evidence.sources.every((source) => source.trim().length > 100)).toBe(true);
    expect(evidence.hasAnsi).toBe(true);
    expect(evidence.hasAnimation).toBe(true);
    // Eén shell-call mag beide scripts achter elkaar uitvoeren. De acceptatie is
    // dat ieder bestand aantoonbaar in een geslaagde commandoregel voorkomt.
    expect(evidence.executedPythonFiles.length).toBeGreaterThanOrEqual(2);
    expect(evidence.failedResults).toEqual([]);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.text).not.toMatch(/zonder eindantwoord|geen apart eindantwoord|geen bevestigd resultaat/i);
  }, 190_000);

  it('repareert een bestaand kapot Pythonbestand en voert de herstelde versie uit', async () => {
    const cwd = await caseDirectory('repair');
    const target = path.join(cwd, 'price_report.py');
    await fs.promises.writeFile(target, [
      'values = [10, 12, 20]',
      'print(f"TOTAL={sum(values) + missing}")',
      '',
    ].join('\n'), 'utf8');
    const { result, activities } = await runCase(
      cwd,
      [
        'In de huidige projectmap staat price_report.py met een fout.',
        'Repareer het bestaande bestand met een edit-tool zodat het zonder fout exact TOTAL=42 print.',
        'Voer het gerepareerde script echt uit en controleer de uitvoer.',
        'Antwoord daarna exact met: ANTIGRAVITY_REPAIR_OK',
      ].join('\n'),
      complexTestModel,
    );
    const repaired = await fs.promises.readFile(target, 'utf8');
    const successfulEdit = activities.some((activity) => (
      /replace|edit/i.test(activity.toolName) && activity.phase === 'result' && activity.ok === true
    ));
    const successfulRun = activities.some((activity) => (
      activity.toolName.toLowerCase() === 'run_command' && activity.phase === 'result' && activity.ok === true
    ));

    expect(repaired).not.toContain('missing');
    expect(successfulEdit).toBe(true);
    expect(successfulRun).toBe(true);
    expect(result.text).toContain('ANTIGRAVITY_REPAIR_OK');
  }, 190_000);

  it('laat een geweigerde tool niet door de CLI-permissionoverride glippen', async () => {
    const exe = process.env.AGY_EXE;
    if (!exe) throw new Error('AGY_EXE ontbreekt voor de Antigravity-integratietest.');
    const cwd = await caseDirectory('denied');
    const deniedFile = path.join(cwd, 'antigravity_native_denied.txt');
    const activities: NativeToolActivity[] = [];
    const result = await runAntigravityNative({
      exe,
      modelId: testModel,
      prompt: [
        'Werk uitsluitend in de huidige projectmap.',
        'Probeer met write_to_file het bestand antigravity_native_denied.txt te maken.',
        'Antwoord na de geweigerde tool exact met: ANTIGRAVITY_NATIVE_DENIED_OK',
      ].join('\n'),
      cwd,
      agentMode: 'ask',
      signal: AbortSignal.timeout(180_000),
      onDelta: () => {},
      onStatus: () => {},
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async () => ({ allow: false, message: 'Geweigerd door integratietest.' }),
    });

    await expect(fs.promises.access(deniedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.text).toContain('ANTIGRAVITY_NATIVE_DENIED_OK');
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'requested' }),
      expect.objectContaining({ phase: 'denied' }),
    ]));
    expect(activities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'result', ok: true }),
    ]));
  }, 190_000);
});
