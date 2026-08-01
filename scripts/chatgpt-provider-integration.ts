import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NativeToolActivity } from '../electron/native-tools';
import type { AgentToolCall, ToolRepairResult } from '../src/components/agent-commands';
import type { ChatMessage } from '../src/providers/types';

const realUserData = path.join(process.env.APPDATA || '', 'ai-superapp');
if (realUserData) app.setPath('userData', realUserData);

async function main() {
  const [
    { chatgptScraper },
    { AGENT_TOOL_INSTRUCTIONS, agentToolEnvironmentInstructions },
    { NATIVE_TOOL_RESPONSE_INSTRUCTIONS },
    {
      buildToolFailureRepairPrompt,
      buildToolRepairPrompt,
      buildToolSuccessSummaryPrompt,
      normalizeFileToolPayload,
      missingRequestedFileExecutions,
      requestRequiresEveryFileExecution,
      parseAgentToolCalls,
      validateFileToolPayload,
    },
    { assertSkylineArtifacts, createIsolatedNativeExecutor, SKYLINE_LIVE_PROMPT },
  ] = await Promise.all([
    import('../electron/chatgpt-scraper'),
    import('../electron/agent-tool-instructions'),
    import('../electron/native-response-instructions'),
    import('../src/components/agent-commands'),
    import('../src/provider-live-test-utils'),
  ]);

  if (!await withDiagnosticTimeout(
    chatgptScraper.isSessionActive(),
    30_000,
    'ChatGPT-sessiecontrole duurde te lang.',
  )) {
    throw new Error('De opgeslagen ChatGPT-websessie is niet actief. Log opnieuw in via Instellingen.');
  }
  const models = await withDiagnosticTimeout(
    chatgptScraper.listSessionModels(),
    45_000,
    'ChatGPT-modelcatalogus duurde te lang.',
  );
  const versions = await withDiagnosticTimeout(
    chatgptScraper.listSessionVersions(),
    15_000,
    'ChatGPT-versiecatalogus duurde te lang.',
  );
  console.info('[chatgpt catalogus]', {
    models: models.map((model) => ({ id: model.id, name: model.name })),
    versions,
  });
  if (process.env.CHATGPT_CATALOG_ONLY === '1') return;
  if (!models.length) throw new Error('De actieve ChatGPT-websessie leverde geen live modellen op.');
  const newestVersion = versions[0];
  const availablePresets = newestVersion?.presets.filter((preset) => preset.available) || [];
  const selectedPreset = availablePresets[Math.max(0, availablePresets.length - 2)];
  const fallbackModel = models.find((candidate) => candidate.chatgptWorkMode) || models[0];
  const modelSlug = selectedPreset?.modelSlug || fallbackModel.id.replace(/^chatgpt:/, '');
  const thinkingEffort = selectedPreset?.thinkingEffort;
  console.info('[chatgpt live]', {
    model: selectedPreset ? `${newestVersion.title} · ${selectedPreset.title}` : fallbackModel.name,
    modelSlug,
    catalogSize: models.length,
  });

  const smokeToken = `CHATGPT_WEB_OK_${Date.now().toString(36).toUpperCase()}`;
  const smoke = await chatgptScraper.sendChatViaSession({
    modelSlug,
    thinkingEffort,
    messages: [{ role: 'user', content: `Antwoord exact met: ${smokeToken}` }],
    attachments: [],
    signal: AbortSignal.timeout(180_000),
    onDelta: () => {},
    onStatus: (status) => console.info('[chatgpt status]', status),
  });
  if (!smoke.text.includes(smokeToken)) {
    throw new Error(`ChatGPT-websessie gaf niet het gevraagde smoketesttoken terug (${smoke.text.slice(0, 240)}).`);
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-superapp-chatgpt-live-'));
  try {
    const activities: NativeToolActivity[] = [];
    const execute = createIsolatedNativeExecutor(root);
    const messages: ChatMessage[] = [{ role: 'user', content: SKYLINE_LIVE_PROMPT }];
    const systemPrompt = `${AGENT_TOOL_INSTRUCTIONS}\n${NATIVE_TOOL_RESPONSE_INSTRUCTIONS}\n${agentToolEnvironmentInstructions('powershell', 'win32')}`;
    let finalText = '';
    let complianceRetried = false;
    const changedFilePaths = new Set<string>();
    const successfulCommands: string[] = [];

    for (let round = 0; round < 6; round++) {
      const result = await chatgptScraper.sendChatViaSession({
        modelSlug,
        thinkingEffort,
        messages,
        systemPrompt,
        attachments: [],
        signal: AbortSignal.timeout(240_000),
        onDelta: () => {},
        onStatus: (status) => console.info('[chatgpt status]', status),
      });
      const calls = parseAgentToolCalls(result.text, { includeShellFences: false });
      messages.push({ role: 'assistant', content: result.text });

      if (!calls.length) {
        if (!activities.length && !complianceRetried) {
          complianceRetried = true;
          messages.push({
            role: 'user',
            content: buildToolRepairPrompt({ userInput: SKYLINE_LIVE_PROMPT, badReply: result.text }),
          });
          continue;
        }
        finalText = result.text;
        break;
      }

      const outputs: string[] = [];
      const toolResults: ToolRepairResult[] = [];
      let hadFailure = false;
      for (const [index, call] of calls.entries()) {
        const normalizedCall = call.type === 'file-create' || call.type === 'file-edit'
          ? normalizeFileToolPayload(call).call
          : call;
        if (normalizedCall.type === 'file-create' || normalizedCall.type === 'file-edit') {
          const validation = validateFileToolPayload(normalizedCall);
          if (!validation.ok) {
            hadFailure = true;
            const output = `[invalid file payload] ${validation.message || 'Ongeldige file-tool inhoud.'}`;
            outputs.push(`Tool output (${normalizedCall.type}):\n${JSON.stringify({ ok: false, output })}`);
            toolResults.push({ text: output });
            continue;
          }
        }
        const mapped = mapTagCall(normalizedCall);
        const toolUseId = `chatgpt-${round}-${index}`;
        activities.push({
          provider: 'openai', toolName: mapped.name, input: mapped.input, toolUseId, phase: 'requested',
        });
        const toolResult = await execute(mapped.name, mapped.input, toolUseId);
        if (toolResult.ok && mapped.name === 'run_command') successfulCommands.push(String(mapped.input.command || ''));
        if (toolResult.ok && (mapped.name === 'write_file' || mapped.name === 'edit_file')) {
          changedFilePaths.add(String(mapped.input.path || ''));
        }
        hadFailure ||= !toolResult.ok;
        activities.push({
          provider: 'openai', toolName: mapped.name, input: mapped.input, toolUseId,
          phase: toolResult.denied ? 'denied' : 'result', ok: toolResult.ok, output: toolResult.output,
        });
        outputs.push(`Tool output (${mapped.name}):\n${JSON.stringify({ ok: toolResult.ok, output: toolResult.output })}`);
        toolResults.push({
          text: toolResult.output,
          ...(mapped.name === 'run_command' ? {
            run: {
              command: String(mapped.input.command || ''),
              shell: String(mapped.input.shell || 'powershell'),
              cwd: root,
              status: toolResult.ok ? 'completed' : toolResult.denied ? 'denied' : 'failed',
              exitCode: toolResult.ok ? 0 : 1,
            },
          } : {}),
        });
      }
      messages.push({ role: 'user', content: outputs.join('\n\n') });
      if (hadFailure) {
        messages.push({ role: 'user', content: buildToolFailureRepairPrompt(toolResults) });
      } else {
        const missingExecutionPaths = missingRequestedFileExecutions(
          SKYLINE_LIVE_PROMPT,
          changedFilePaths,
          successfulCommands,
        );
        messages.push({
          role: 'user',
          content: buildToolSuccessSummaryPrompt(toolResults, {
            missingExecutionPaths,
            verifiedAllRequestedExecutions: requestRequiresEveryFileExecution(SKYLINE_LIVE_PROMPT)
              && changedFilePaths.size > 0
              && successfulCommands.length > 0
              && missingExecutionPaths.length === 0,
          }),
        });
      }
    }

    const evidence = await assertSkylineArtifacts(root, { text: finalText, activities });
    console.info('[chatgpt skyline]', {
      files: evidence.pythonFiles,
      successfulCommands: evidence.successfulCommands.length,
      executedPythonFiles: evidence.executedPythonFiles,
      failedResults: evidence.failedResults.length,
      hasAnsi: evidence.hasAnsi,
      hasAnimation: evidence.hasAnimation,
      failures: evidence.failedResults.map((activity) => ({
        tool: activity.toolName,
        output: activity.output?.slice(0, 400),
      })),
      successfulCommandInputs: evidence.successfulCommands.map((activity) => activity.input?.command),
    });
    if (evidence.pythonFiles.length < 2) throw new Error('ChatGPT maakte minder dan twee Pythonbestanden.');
    if (!evidence.hasAnsi || !evidence.hasAnimation) throw new Error('ChatGPT-scripts missen ANSI of animatie.');
    if (evidence.executedPythonFiles.length < 2) throw new Error('ChatGPT voerde niet beide scripts succesvol uit.');
    if (evidence.failedResults.length) throw new Error('ChatGPT live tool-loop bevatte een mislukte toolactie.');
    if (!finalText.trim()) throw new Error('ChatGPT gaf na de tool-loop geen eindantwoord.');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

function withDiagnosticTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function mapTagCall(call: AgentToolCall) {
  if (call.type === 'file-read') return { name: 'read_file', input: { path: call.path } };
  if (call.type === 'file-create') {
    return { name: 'write_file', input: { path: call.path, content: call.content, overwrite: call.overwrite } };
  }
  if (call.type === 'file-edit') {
    return {
      name: 'edit_file',
      input: { path: call.path, old_text: call.oldText, new_text: call.newText, replace_all: call.replaceAll },
    };
  }
  return { name: 'run_command', input: { command: call.command, shell: call.shell || 'powershell' } };
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  });
