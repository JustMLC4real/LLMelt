import { execFileSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCodexNative } from '../electron/codex-native';
import { agentToolEnvironmentInstructions } from '../electron/agent-tool-instructions';
import { claudeCliModelsFromHelp } from '../electron/claude-cli-catalog';
import { claudeCliLoggedInFromStatus } from '../electron/claude-cli-status';
import { claudeCliEnvironment, runClaudeNative } from '../electron/claude-native';
import { runGeminiApiNative } from '../electron/gemini-api-native';
import type { NativeToolActivity } from '../electron/native-tools';
import { NATIVE_TOOL_RESPONSE_INSTRUCTIONS } from '../electron/native-response-instructions';
import { runOllamaNative } from '../electron/ollama-native';
import { claudeExecutableCandidates, codexExecutableCandidates, findCliExecutable } from '../electron/cli-discovery';
import { cliSpawnSpec } from '../electron/process-utils';
import { codexRecoveredPreflightArgs, codexSafePreflightArgs } from './components/codex-utils';
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
  let geminiModels: string[] = [];
  let geminiModel = '';
  let ollamaModel = '';
  let codexModel = '';
  let codexExe = '';
  let claudeModel = '';
  let claudeExe = '';
  let claudeCatalog: string[] = [];

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-native-providers-'));
    const [google, ollama, executable, claude] = await Promise.all([
      includesLiveProvider('gemini')
        ? discoverGeminiModels(process.env.GEMINI_API_KEY || '')
        : Promise.resolve([] as string[]),
      includesLiveProvider('ollama')
        ? discoverOllamaModel(process.env.OLLAMA_BASE_URL || 'http://localhost:11434')
        : Promise.resolve(''),
      includesLiveProvider('codex')
        ? findCliExecutable(codexExecutableCandidates())
        : Promise.resolve(null),
      includesLiveProvider('claude')
        ? discoverClaudeRuntime()
        : Promise.resolve({ executable: '', models: [] as string[] }),
    ]);
    geminiModels = google;
    geminiModel = google[0] || '';
    ollamaModel = ollama;
    codexExe = executable || '';
    codexModel = codexExe ? discoverCodexModel(codexExe) : '';
    claudeExe = claude.executable;
    claudeCatalog = claude.models;
    claudeModel = await selectClaudeLiveModel(claudeExe, claudeCatalog);
    console.info('[live providers]', {
      geminiModel,
      geminiTestModels: geminiModels.slice(0, 3),
      ollamaModel,
      codexModel,
      codexExecutable: codexExe ? path.basename(codexExe) : '',
      claudeModel,
      claudeCatalog,
      claudeExecutable: claudeExe ? path.basename(claudeExe) : '',
    });
  }, 60_000);

  afterAll(async () => {
    if (root) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it.runIf(includesLiveProvider('gemini'))('Gemini antwoordt gewoon zonder onverwachte toolactie', async () => {
    if (!process.env.GEMINI_API_KEY || !geminiModels[0]) throw new Error('Gemini live configuratie ontbreekt.');
    const marker = `LLMELT_GEMINI_PLAIN_${crypto.randomUUID()}`;
    let toolCalled = false;
    const result = await runGeminiApiNative({
      apiKey: process.env.GEMINI_API_KEY,
      model: geminiModels[0],
      contents: [{ role: 'user', parts: [{ text: `Antwoord uitsluitend exact met ${marker}` }] }],
      signal: AbortSignal.timeout(60_000),
      executeTool: async () => {
        toolCalled = true;
        return { ok: false, output: 'Onverwachte toolactie in plain-chat.' };
      },
      onDelta: () => {},
    });
    expect(result.text.trim()).toBe(marker);
    expect(toolCalled).toBe(false);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  }, 70_000);

  it.runIf(includesLiveProvider('gemini'))('Gemini voert een toegestane native write geisoleerd uit', async () => {
    if (!process.env.GEMINI_API_KEY || !geminiModels.length) throw new Error('Gemini live configuratie ontbreekt.');
    const cwd = await createLiveCaseDirectory(root, 'gemini-allow');
    const model = geminiModels[1] || geminiModels[0];
    const target = 'gemini-allow.txt';
    const marker = 'LLMELT_GEMINI_ALLOW_OK';
    const activities: NativeToolActivity[] = [];
    const result = await runGeminiApiNative({
      apiKey: process.env.GEMINI_API_KEY,
      model,
      contents: [{ role: 'user', parts: [{
        text: `Gebruik verplicht write_file om ${target} met exact ${marker} te maken. Antwoord daarna kort.`,
      }] }],
      systemInstruction: geminiLiveSystemInstruction(),
      signal: AbortSignal.timeout(90_000),
      executeTool: createIsolatedNativeExecutor(cwd),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
    });
    expect(await fs.promises.readFile(path.join(cwd, target), 'utf8')).toBe(marker);
    expect(activities.some((activity) => (
      activity.toolName === 'write_file' && activity.phase === 'result' && activity.ok === true
    ))).toBe(true);
    expect(activities.some((activity) => activity.phase === 'denied')).toBe(false);
    expect(result.text.trim()).not.toBe('');
  }, 100_000);

  it.runIf(includesLiveProvider('gemini'))('Gemini laat een geweigerde native write zonder side effect', async () => {
    if (!process.env.GEMINI_API_KEY || !geminiModels.length) throw new Error('Gemini live configuratie ontbreekt.');
    const cwd = await createLiveCaseDirectory(root, 'gemini-deny');
    const model = geminiModels[2] || geminiModels[1] || geminiModels[0];
    const target = 'gemini-denied.txt';
    const activities: NativeToolActivity[] = [];
    const result = await runGeminiApiNative({
      apiKey: process.env.GEMINI_API_KEY,
      model,
      contents: [{ role: 'user', parts: [{
        text: `Gebruik verplicht write_file om ${target} met exact DENIED te maken. Stop als toestemming wordt geweigerd.`,
      }] }],
      systemInstruction: geminiLiveSystemInstruction(),
      signal: AbortSignal.timeout(90_000),
      executeTool: async () => ({ ok: false, denied: true, output: 'Door de testgebruiker geweigerd.' }),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
    });
    expect(fs.existsSync(path.join(cwd, target))).toBe(false);
    expect(activities.some((activity) => (
      activity.toolName === 'write_file' && activity.phase === 'denied' && activity.ok === false
    ))).toBe(true);
    expect(activities.some((activity) => (
      activity.toolName === 'write_file' && activity.phase === 'result' && activity.ok === true
    ))).toBe(false);
    expect(result.text.trim()).not.toBe('');
  }, 100_000);

  it.runIf(includesLiveProvider('gemini'))('Gemini bouwt en runt de volledige skylineopdracht', async () => {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY ontbreekt voor de live Gemini-test.');
    if (!geminiModel) throw new Error('Geen Gemini-model met generateContent gevonden.');
    const cwd = await createLiveCaseDirectory(root, 'gemini-skyline');
    const activities: NativeToolActivity[] = [];
    const result = await runGeminiApiNative({
      apiKey: process.env.GEMINI_API_KEY,
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: SKYLINE_LIVE_PROMPT }] }],
      systemInstruction: geminiLiveSystemInstruction(),
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
        systemInstruction: geminiLiveSystemInstruction(),
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

  it.runIf(includesLiveProvider('claude'))('Claude-account en modelcatalogus komen live uit de ingelogde CLI', async () => {
    if (!claudeExe) throw new Error('Claude CLI ontbreekt of is niet ingelogd.');
    expect(claudeCatalog.length).toBeGreaterThan(0);
    expect(new Set(claudeCatalog).size).toBe(claudeCatalog.length);

    const helpModels = discoverClaudeHelpModels(claudeExe);
    expect(helpModels.length).toBeGreaterThan(0);
    expect(claudeCatalog).toEqual(helpModels.map((model) => `claude-cli:${model}`));
  });

  it.runIf(includesLiveProvider('claude'))('Claude voert Write, Read en Bash uit na ask-goedkeuring', async () => {
    assertClaudeLiveReady(claudeExe, claudeModel);
    const cwd = await createLiveCaseDirectory(root, 'claude-ask-allow');
    const marker = 'LLMELT_CLAUDE_ASK_OK';
    const source = 'claude-ask-source.txt';
    const target = 'claude-ask.txt';
    await fs.promises.writeFile(path.join(cwd, source), marker, 'utf8');
    const activities: NativeToolActivity[] = [];
    const approvalTools: string[] = [];
    const result = await runClaudeNative({
      exe: claudeExe,
      modelId: claudeModel,
      prompt: claudeToolPrompt(source, target, true),
      cwd,
      effort: 'low',
      agentMode: 'ask',
      signal: AbortSignal.timeout(180_000),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async (toolName) => {
        approvalTools.push(toolName);
        return { allow: true };
      },
    });

    expect(await fs.promises.readFile(path.join(cwd, target), 'utf8')).toBe(marker);
    // Claude Code beschouwt Read binnen de werkmap als veilig en roept de
    // permission-prompt-tool daarvoor niet aan. De native stream moet Read wél
    // volledig als requested/result-activiteit doorgeven.
    expect(approvalTools.map(normalizeToolName)).toEqual(expect.arrayContaining(['write', 'bash']));
    expect(approvalTools.map(normalizeToolName)).not.toContain('read');
    expectSuccessfulClaudeTool(activities, 'write');
    expectSuccessfulClaudeTool(activities, 'read');
    expectSuccessfulClaudeTool(activities, 'bash');
    expect(result.text.trim()).not.toBe('');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  }, 190_000);

  it.runIf(includesLiveProvider('claude'))('Claude laat een geweigerde ask-write niet uitvoeren', async () => {
    assertClaudeLiveReady(claudeExe, claudeModel);
    const cwd = await createLiveCaseDirectory(root, 'claude-ask-deny');
    const target = 'claude-denied.txt';
    const activities: NativeToolActivity[] = [];
    const result = await runClaudeNative({
      exe: claudeExe,
      modelId: claudeModel,
      prompt: `Gebruik verplicht de native Write-tool om ${target} met exact DENIED te maken. Als toestemming wordt geweigerd, stop dan en meld dat kort.`,
      cwd,
      effort: 'low',
      agentMode: 'ask',
      signal: AbortSignal.timeout(120_000),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async () => ({ allow: false, message: 'LLMelt-live-test weigert deze actie.' }),
    });

    expect(fs.existsSync(path.join(cwd, target))).toBe(false);
    expect(activities.some((activity) => normalizeToolName(activity.toolName) === 'write' && activity.phase === 'denied')).toBe(true);
    expect(activities.some((activity) => normalizeToolName(activity.toolName) === 'write' && activity.phase === 'result' && activity.ok === true)).toBe(false);
    expect(result.text.trim()).not.toBe('');
  }, 130_000);

  it.runIf(includesLiveProvider('claude'))('Claude auto-project routeert bestandstools door de app-gate', async () => {
    assertClaudeLiveReady(claudeExe, claudeModel);
    const cwd = await createLiveCaseDirectory(root, 'claude-auto-project');
    const marker = 'LLMELT_CLAUDE_AUTO_OK';
    const source = 'claude-auto-source.txt';
    const target = 'claude-auto.txt';
    await fs.promises.writeFile(path.join(cwd, source), marker, 'utf8');
    const approvalTools: string[] = [];
    const activities: NativeToolActivity[] = [];
    const result = await runClaudeNative({
      exe: claudeExe,
      modelId: claudeModel,
      prompt: claudeToolPrompt(source, target, false),
      cwd,
      effort: 'low',
      agentMode: 'auto-project',
      signal: AbortSignal.timeout(150_000),
      onDelta: () => {},
      onToolActivity: (activity) => activities.push(activity),
      requestPermission: async (toolName) => {
        approvalTools.push(toolName);
        return { allow: ['write', 'read'].includes(normalizeToolName(toolName)) };
      },
    });

    expect(await fs.promises.readFile(path.join(cwd, target), 'utf8')).toBe(marker);
    expect(approvalTools.map(normalizeToolName)).toContain('write');
    expect(approvalTools.map(normalizeToolName)).not.toContain('read');
    expectSuccessfulClaudeTool(activities, 'write');
    expectSuccessfulClaudeTool(activities, 'read');
    expect(result.text.trim()).not.toBe('');
  }, 160_000);

  it.runIf(includesLiveProvider('claude'))('Claude full voert geïsoleerd uit zonder approval-callback', async () => {
    assertClaudeLiveReady(claudeExe, claudeModel);
    const cwd = await createLiveCaseDirectory(root, 'claude-full');
    const target = 'claude-full.txt';
    let approvalCalled = false;
    const result = await runClaudeNative({
      exe: claudeExe,
      modelId: claudeModel,
      prompt: `Gebruik de native Write-tool om ${target} met exact LLMELT_CLAUDE_FULL_OK te maken. Antwoord daarna kort.`,
      cwd,
      effort: 'low',
      agentMode: 'full',
      signal: AbortSignal.timeout(120_000),
      onDelta: () => {},
      requestPermission: async () => {
        approvalCalled = true;
        return { allow: false };
      },
    });

    expect(await fs.promises.readFile(path.join(cwd, target), 'utf8')).toBe('LLMELT_CLAUDE_FULL_OK');
    expect(approvalCalled).toBe(false);
    expect(result.text.trim()).not.toBe('');
  }, 130_000);

  it.runIf(includesLiveProvider('claude'))('Claude houdt twee gelijktijdige platte gesprekken geïsoleerd', async () => {
    assertClaudeLiveReady(claudeExe, claudeModel);
    const firstMarker = `LLMELT_CHAT_A_${crypto.randomUUID()}`;
    const secondMarker = `LLMELT_CHAT_B_${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      runClaudePlainLive(claudeExe, claudeModel, `Antwoord uitsluitend exact met ${firstMarker}`),
      runClaudePlainLive(claudeExe, claudeModel, `Antwoord uitsluitend exact met ${secondMarker}`),
    ]);

    expect(first.trim()).toBe(firstMarker);
    expect(second.trim()).toBe(secondMarker);
    expect(first).not.toContain(secondMarker);
    expect(second).not.toContain(firstMarker);
  }, 100_000);

  it.runIf(includesLiveProvider('claude'))('Claude rapporteert een ongeldig model als fout zonder tooluitvoering', async () => {
    if (!claudeExe) throw new Error('Claude CLI ontbreekt of is niet ingelogd.');
    const cwd = await createLiveCaseDirectory(root, 'claude-invalid-model');
    const activities: NativeToolActivity[] = [];
    let approvalCalled = false;
    let failure: (Error & { partialExecution?: boolean }) | undefined;
    try {
      await runClaudeNative({
        exe: claudeExe,
        modelId: '__llmelt_invalid_model__',
        prompt: 'Antwoord exact met OK.',
        cwd,
        effort: 'low',
        agentMode: 'ask',
        signal: AbortSignal.timeout(60_000),
        onDelta: () => {},
        onToolActivity: (activity) => activities.push(activity),
        requestPermission: async () => {
          approvalCalled = true;
          return { allow: true };
        },
      });
    } catch (error) {
      failure = error as Error & { partialExecution?: boolean };
    }

    expect(failure?.message).toMatch(/selected model|model.*(?:exist|access)|ongeldig/i);
    expect(failure?.partialExecution).not.toBe(true);
    expect(approvalCalled).toBe(false);
    expect(activities).toEqual([]);
    expect((await fs.promises.readdir(cwd))).toEqual([]);
  }, 70_000);
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

async function discoverGeminiModels(apiKey: string) {
  if (!apiKey) return [];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gemini models.list faalde met HTTP ${response.status}.`);
  const data = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  const models = (data.models || [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return models.sort((left, right) => modelRank(right) - modelRank(left) || left.localeCompare(right));
}

function geminiLiveSystemInstruction() {
  return {
    parts: [{
      text: `${NATIVE_TOOL_RESPONSE_INSTRUCTIONS}\n${agentToolEnvironmentInstructions('powershell', 'win32')}`,
    }],
  };
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
  const options = { encoding: 'utf8' as const, timeout: 30_000, windowsHide: true };
  let raw: string;
  try {
    raw = execFileSync(exe, codexSafePreflightArgs('debug', 'models'), options);
  } catch (error: any) {
    const detail = `${String(error?.stderr || '')}\n${String(error?.message || '')}`;
    const recovered = codexRecoveredPreflightArgs(detail, 'debug', 'models');
    if (!recovered) throw error;
    raw = execFileSync(exe, recovered, options);
  }
  const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; visibility?: string; upgrade?: unknown }> };
  return (parsed.models || []).find((model) => model.visibility !== 'hide' && !model.upgrade && model.slug)?.slug || '';
}

async function discoverClaudeRuntime() {
  const executable = await findCliExecutable(claudeExecutableCandidates());
  if (!executable || !claudeCliAuthenticated(executable)) {
    return { executable: executable || '', models: [] as string[] };
  }
  return {
    executable,
    models: discoverClaudeHelpModels(executable).map((model) => `claude-cli:${model}`),
  };
}

function discoverClaudeHelpModels(exe: string) {
  const help = captureCliOutput(exe, ['--help']);
  return claudeCliModelsFromHelp(help).map((model) => model.id);
}

function claudeCliAuthenticated(exe: string) {
  try {
    const raw = captureCliOutput(exe, ['auth', 'status']);
    return claudeCliLoggedInFromStatus(raw);
  } catch {
    return false;
  }
}

function captureCliOutput(exe: string, args: string[]) {
  const spec = cliSpawnSpec(exe, args);
  const result = spawnSync(spec.command, spec.args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `CLI stopte met afsluitcode ${result.status}.`));
  }
  return result.stdout || '';
}

function runClaudePlainLive(exe: string, model: string, prompt: string) {
  const spec = cliSpawnSpec(exe, [
    '-p',
    '--model', model,
    '--permission-mode', 'plan',
    '--safe-mode',
    '--no-session-persistence',
    '--effort', 'low',
  ]);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: os.tmpdir(),
      env: claudeCliEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude platte live-test stopte niet binnen 90 seconden.'));
    }, 90_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `Claude eindigde met code ${code ?? 'onbekend'}.`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function selectClaudeLiveModel(exe: string, models: string[]) {
  const requested = String(process.env.CLAUDE_TEST_MODEL || '').trim().replace(/^claude-cli:/, '');
  const candidates = requested && models.includes(`claude-cli:${requested}`)
    ? [`claude-cli:${requested}`, ...models.filter((model) => model !== `claude-cli:${requested}`)]
    : models;
  for (const candidate of candidates) {
    const model = candidate.replace(/^claude-cli:/, '');
    try {
      const marker = `LLMELT_MODEL_PROBE_${crypto.randomUUID()}`;
      const text = await runClaudePlainLive(exe, model, `Antwoord uitsluitend exact met ${marker}`);
      if (text.includes(marker)) return model;
    } catch (error) {
      console.info('[claude live model niet bruikbaar]', {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return '';
}

function assertClaudeLiveReady(exe: string, model: string) {
  if (!exe || !model) throw new Error('Ingelogde Claude CLI/live modelcatalogus ontbreekt.');
}

function normalizeToolName(toolName: string) {
  return toolName.trim().toLowerCase();
}

function expectSuccessfulClaudeTool(activities: NativeToolActivity[], toolName: string) {
  expect(activities.some((activity) => (
    normalizeToolName(activity.toolName) === toolName
      && activity.phase === 'result'
      && activity.ok === true
  ))).toBe(true);
}

function claudeToolPrompt(source: string, target: string, includeBash: boolean) {
  return [
    `Gebruik verplicht eerst de native Read-tool om de onbekende inhoud van ${source} te lezen.`,
    `Gebruik daarna verplicht de native Write-tool om ${target} te maken met exact de zojuist gelezen inhoud, zonder extra newline.`,
    ...(includeBash
      ? [`Gebruik daarna verplicht de native Bash-tool met: python -c "from pathlib import Path; print(Path('${target}').read_text(encoding='utf-8'))"`]
      : []),
    'Controleer dat de gelezen/uitgevoerde waarde exact klopt en antwoord daarna in één korte zin.',
  ].join('\n');
}

function modelRank(name: string) {
  const family = /^gemini-/i.test(name) ? 10_000 : 0;
  const decimal = name.match(/(?<!\d)(\d{1,2})\.(\d+)(?!\d)/);
  const version = decimal ? Number(decimal[1]) * 1000 + Number(decimal[2]) : 0;
  const stable = /preview|experimental|exp/i.test(name) ? 0 : 100;
  return family + version + stable;
}
