import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCodexNative } from '../electron/codex-native';
import { runGeminiApiNative } from '../electron/gemini-api-native';
import type { NativeToolActivity } from '../electron/native-tools';
import { NATIVE_TOOL_RESPONSE_INSTRUCTIONS } from '../electron/native-response-instructions';
import { runOllamaNative } from '../electron/ollama-native';
import { codexExecutableCandidates, findCliExecutable } from '../electron/cli-discovery';
import { codexSafePreflightArgs } from './components/codex-utils';
import {
  assertSkylineArtifacts,
  createIsolatedNativeExecutor,
  createLiveCaseDirectory,
  SKYLINE_LIVE_PROMPT,
  type LiveProviderRun,
} from './provider-live-test-utils';

const integration = process.env.RUN_NATIVE_PROVIDER_INTEGRATION === '1' ? describe : describe.skip;
const liveProviderFilter = String(process.env.LIVE_PROVIDER_FILTER || '').trim().toLocaleLowerCase();
const includesLiveProvider = (provider: string) => !liveProviderFilter || liveProviderFilter.includes(provider.toLocaleLowerCase());

integration('Native providers live', () => {
  let root = '';
  let geminiModel = '';
  let ollamaModel = '';
  let codexModel = '';
  let codexExe = '';

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-native-providers-'));
    const [google, ollama, executable] = await Promise.all([
      includesLiveProvider('gemini')
        ? discoverGeminiModel(process.env.GEMINI_API_KEY || '')
        : Promise.resolve(''),
      includesLiveProvider('ollama')
        ? discoverOllamaModel(process.env.OLLAMA_BASE_URL || 'http://localhost:11434')
        : Promise.resolve(''),
      includesLiveProvider('codex')
        ? findCliExecutable(codexExecutableCandidates())
        : Promise.resolve(null),
    ]);
    geminiModel = google;
    ollamaModel = ollama;
    codexExe = executable || '';
    codexModel = codexExe ? discoverCodexModel(codexExe) : '';
    console.info('[live providers]', {
      geminiModel,
      ollamaModel,
      codexModel,
      codexExecutable: codexExe ? path.basename(codexExe) : '',
    });
  }, 60_000);

  afterAll(async () => {
    if (root) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it.runIf(includesLiveProvider('gemini'))('Gemini bouwt en runt de volledige skylineopdracht', async () => {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY ontbreekt voor de live Gemini-test.');
    if (!geminiModel) throw new Error('Geen Gemini-model met generateContent gevonden.');
    const cwd = await createLiveCaseDirectory(root, 'gemini-skyline');
    const activities: NativeToolActivity[] = [];
    const result = await runGeminiApiNative({
      apiKey: process.env.GEMINI_API_KEY,
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: SKYLINE_LIVE_PROMPT }] }],
      systemInstruction: { parts: [{ text: NATIVE_TOOL_RESPONSE_INSTRUCTIONS }] },
      signal: AbortSignal.timeout(180_000),
      executeTool: createIsolatedNativeExecutor(cwd),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
    });
    await expectCompleteSkyline(cwd, { text: result.text, activities });
  }, 190_000);

  it.runIf(includesLiveProvider('gemini'))('Gemini repareert een bestaand kapot Pythonbestand en runt de fix', async () => {
    if (!process.env.GEMINI_API_KEY || !geminiModel) throw new Error('Gemini live configuratie ontbreekt.');
    const cwd = await createLiveCaseDirectory(root, 'gemini-repair');
    await expectRepair(cwd, async (prompt, activities) => {
      const result = await runGeminiApiNative({
        apiKey: process.env.GEMINI_API_KEY!,
        model: geminiModel,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: NATIVE_TOOL_RESPONSE_INSTRUCTIONS }] },
        signal: AbortSignal.timeout(120_000),
        executeTool: createIsolatedNativeExecutor(cwd),
        onDelta: () => {},
        onToolActivity: (activity) => activities.push(activity),
      });
      return result.text;
    });
  }, 130_000);

  it.runIf(includesLiveProvider('ollama'))('Ollama bouwt en runt de volledige skylineopdracht', async () => {
    if (!ollamaModel) throw new Error('Geen lokaal Ollama-model met toolondersteuning gevonden.');
    const cwd = await createLiveCaseDirectory(root, 'ollama-skyline');
    const activities: NativeToolActivity[] = [];
    const result = await runOllamaNative({
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: ollamaModel,
      messages: [
        { role: 'system', content: NATIVE_TOOL_RESPONSE_INSTRUCTIONS },
        { role: 'user', content: SKYLINE_LIVE_PROMPT },
      ],
      signal: AbortSignal.timeout(300_000),
      executeTool: createIsolatedNativeExecutor(cwd),
      requireToolUse: true,
      onDelta: () => {},
      onStatus: (status) => console.info('[ollama live status]', status),
      onToolActivity: (activity) => {
        activities.push(activity);
        if (activity.phase === 'result' || activity.phase === 'denied') {
          console.info('[ollama live tool]', {
            tool: activity.toolName,
            ok: activity.ok,
            path: activity.input?.path,
            command: activity.input?.command,
          });
        }
      },
    });
    await expectCompleteSkyline(cwd, { text: result.text, activities });
  }, 310_000);

  it.runIf(includesLiveProvider('ollama'))('Ollama repareert een bestaand kapot Pythonbestand en runt de fix', async () => {
    if (!ollamaModel) throw new Error('Ollama live configuratie ontbreekt.');
    const cwd = await createLiveCaseDirectory(root, 'ollama-repair');
    await expectRepair(cwd, async (prompt, activities) => {
      const result = await runOllamaNative({
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        model: ollamaModel,
        messages: [
          { role: 'system', content: NATIVE_TOOL_RESPONSE_INSTRUCTIONS },
          { role: 'user', content: prompt },
        ],
        signal: AbortSignal.timeout(180_000),
        executeTool: createIsolatedNativeExecutor(cwd),
        requireToolUse: true,
        onDelta: () => {},
        onStatus: (status) => console.info('[ollama repair status]', status),
        onToolActivity: (activity) => {
          activities.push(activity);
          if (activity.phase === 'result' || activity.phase === 'denied') {
            console.info('[ollama repair tool]', {
              tool: activity.toolName,
              ok: activity.ok,
              path: activity.input?.path,
              command: activity.input?.command,
            });
          }
        },
      });
      return result.text;
    });
  }, 190_000);

  it.runIf(includesLiveProvider('codex'))('Codex bouwt en runt de volledige skylineopdracht via mcp-server', async () => {
    if (!codexExe || !codexModel) throw new Error('Ingelogde Codex CLI/catalogus ontbreekt.');
    const cwd = await createLiveCaseDirectory(root, 'codex-skyline');
    const activities: NativeToolActivity[] = [];
    const result = await runCodexNative({
      exe: codexExe,
      model: codexModel,
      prompt: `System:\n${NATIVE_TOOL_RESPONSE_INSTRUCTIONS}\n\nUser:\n${SKYLINE_LIVE_PROMPT}`,
      cwd,
      agentMode: 'ask',
      reasoningEffort: 'medium',
      timeoutSeconds: 300,
      signal: AbortSignal.timeout(310_000),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async () => ({ allow: true }),
    });
    await expectCompleteSkyline(cwd, { text: result.text, activities });
  }, 320_000);
});

async function expectCompleteSkyline(cwd: string, run: LiveProviderRun) {
  const evidence = await assertSkylineArtifacts(cwd, run);
  if (evidence.pythonFiles.length < 2 || evidence.executedPythonFiles.length < 2 || evidence.failedResults.length) {
    console.info('[live skyline incompleet]', {
      files: evidence.pythonFiles,
      executedFiles: evidence.executedPythonFiles,
      text: run.text.slice(0, 1_000),
      activities: run.activities.map((activity) => ({
        tool: activity.toolName,
        phase: activity.phase,
        ok: activity.ok,
        inputKeys: Object.keys(activity.input || {}),
        output: activity.output?.slice(0, 300),
      })),
    });
  }
  expect(evidence.pythonFiles.length).toBeGreaterThanOrEqual(2);
  expect(evidence.sources.every((source) => source.trim().length > 100)).toBe(true);
  expect(evidence.hasAnsi).toBe(true);
  expect(evidence.hasAnimation).toBe(true);
  expect(evidence.executedPythonFiles.length).toBeGreaterThanOrEqual(2);
  expect(evidence.failedResults).toEqual([]);
  expect(run.text.trim().length).toBeGreaterThan(0);
  expect(run.text).not.toMatch(/zonder eindantwoord|geen apart eindantwoord|geen bevestigd resultaat/i);
}

async function expectRepair(
  cwd: string,
  run: (prompt: string, activities: NativeToolActivity[]) => Promise<string>,
) {
  const target = path.join(cwd, 'price_report.py');
  await fs.promises.writeFile(target, 'values = [10, 12, 20]\nprint(f"TOTAL={sum(values) + missing}")\n', 'utf8');
  const activities: NativeToolActivity[] = [];
  const text = await run([
    'Repareer price_report.py met edit_file zodat het zonder fout exact TOTAL=42 print.',
    'Voer het gerepareerde bestand echt uit en controleer de uitvoer.',
    'Antwoord daarna kort en eerlijk.',
  ].join('\n'), activities);
  const repaired = await fs.promises.readFile(target, 'utf8');
  let verifiedOutput = '';
  try {
    verifiedOutput = execFileSync('python', [target], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }).trim();
  } catch (error) {
    verifiedOutput = error instanceof Error ? error.message : String(error);
  }
  if (verifiedOutput !== 'TOTAL=42') {
    console.info('[live repair incompleet]', {
      text: text.slice(0, 1_000),
      activities: activities.map((activity) => ({
        tool: activity.toolName,
        phase: activity.phase,
        ok: activity.ok,
        inputKeys: Object.keys(activity.input || {}),
        output: activity.output?.slice(0, 300),
      })),
    });
  }
  expect(repaired.trim().length).toBeGreaterThan(0);
  expect(verifiedOutput).toBe('TOTAL=42');
  expect(activities.some((activity) => activity.toolName === 'edit_file' && activity.phase === 'result' && activity.ok)).toBe(true);
  expect(activities.some((activity) => activity.toolName === 'run_command' && activity.phase === 'result' && activity.ok)).toBe(true);
  // Een lokaal model mag een mislukte tussenpoging herstellen. De harde
  // acceptatie is de uiteindelijke correcte file plus geslaagde edit en run.
  expect(activities.some((activity) => activity.toolName === 'edit_file' && activity.phase === 'result' && activity.ok === true)).toBe(true);
  expect(activities.some((activity) => activity.toolName === 'run_command' && activity.phase === 'result' && activity.ok === true)).toBe(true);
  expect(text.trim()).not.toBe('');
}

async function discoverGeminiModel(apiKey: string) {
  if (!apiKey) return '';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gemini models.list faalde met HTTP ${response.status}.`);
  const data = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  const models = (data.models || [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return models.sort((left, right) => modelRank(right) - modelRank(left) || left.localeCompare(right))[0] || '';
}

async function discoverOllamaModel(baseUrl: string) {
  if (process.env.OLLAMA_TEST_MODEL?.trim()) return process.env.OLLAMA_TEST_MODEL.trim();
  const tags = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  if (!tags.ok) return '';
  const data = await tags.json() as { models?: Array<{ name?: string; size?: number }> };
  const candidates: Array<{ name: string; size: number; vision: boolean }> = [];
  for (const model of data.models || []) {
    const name = String(model.name || '');
    if (!name) continue;
    const show = await fetch(`${baseUrl.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!show.ok) continue;
    const detail = await show.json() as { capabilities?: string[] };
    if (detail.capabilities?.includes('tools')) {
      candidates.push({
        name,
        size: Number(model.size) || 0,
        vision: detail.capabilities.includes('vision'),
      });
    }
  }
  // Tool- en vision-capabilities komen live uit /api/show. Voor deze tekstuele
  // coding-smoke heeft een tekstgericht model voorrang: een vision-stack kost extra
  // geheugen en zegt niets over toolbetrouwbaarheid. Kies daarna het grootste model
  // tot 8 GiB. Er is geen modelnaam-allowlist.
  const interactive = candidates.filter((candidate) => candidate.size <= 8 * 1024 ** 3);
  const pool = interactive.length ? interactive : candidates;
  const textOnly = pool.filter((candidate) => !candidate.vision);
  return (textOnly.length ? textOnly : pool).sort((left, right) => (
    right.size - left.size || left.name.localeCompare(right.name)
  ))[0]?.name || '';
}

function discoverCodexModel(exe: string) {
  const raw = execFileSync(exe, codexSafePreflightArgs('debug', 'models'), {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; visibility?: string; upgrade?: unknown }> };
  return (parsed.models || []).find((model) => model.visibility !== 'hide' && !model.upgrade && model.slug)?.slug || '';
}

function modelRank(name: string) {
  const family = /^gemini-/i.test(name) ? 10_000 : 0;
  const decimal = name.match(/(?<!\d)(\d{1,2})\.(\d+)(?!\d)/);
  const version = decimal ? Number(decimal[1]) * 1000 + Number(decimal[2]) : 0;
  const stable = /preview|experimental|exp/i.test(name) ? 0 : 100;
  return family + version + stable;
}
