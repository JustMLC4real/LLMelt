// Native Gemini Developer API function calling via streamGenerateContent.
//
// Gemini kiest en structureert de tools. Uitvoering blijft volledig in de app,
// zodat projectgrenzen en de bestaande ask/auto-project/full-modi intact blijven.

import crypto from 'crypto';
import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import {
  nativeAppToolDeclarations,
  type NativeToolActivity,
  type NativeToolExecutionResult,
  type NativeToolExecutor,
} from './native-tools';
import {
  clipNativeToolDetail,
  isNativeMutationTool,
  joinNativeText,
  modelSafeToolOutput,
  nativeToolCallSignature,
  nativeToolFeedback,
} from './native-tool-loop-utils';

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface RunGeminiApiNativeOptions {
  apiKey: string;
  model: string;
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  signal: AbortSignal;
  executeTool: NativeToolExecutor;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  apiBaseUrl?: string;
  language?: UiLanguage;
}

export interface RunGeminiApiNativeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

type GeminiFunctionCall = NonNullable<GeminiPart['functionCall']>;

type GeminiRoundResult = {
  modelParts: GeminiPart[];
  functionCalls: Array<{ call: GeminiFunctionCall; part: GeminiPart }>;
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason?: string;
  finishMessage?: string;
  blockReason?: string;
};

type ExecutedCall = {
  epoch: number;
  ok: boolean;
};

const MAX_TOOL_ROUNDS = 8;
const MAX_STAGNANT_ROUNDS = 2;

const GEMINI_NATIVE_TOOL_GUIDANCE_NL = [
  'Je gebruikt door LLMelt beheerde PC-tools.',
  'Controleer na elke functionResponse expliciet response.ok. Bij ok=false is de actie mislukt.',
  'Herhaal een mislukte of identieke toolcall nooit ongewijzigd; onderzoek en wijzig eerst de oorzaak.',
  'Plan voor je eerste toolcall alle expliciet gevraagde artefacten en acties; woorden als twee, beide en alle zijn harde aantallen.',
  'Lees een bestaand bestand eerst met read_file voordat je het bewerkt, tenzij de actuele volledige inhoud al in de conversatie of tool-output staat.',
  'Vraag een afhankelijk run_command niet in dezelfde ronde als een nog niet bevestigde write_file of edit_file; wacht eerst op response.ok=true.',
  'Rond pas af nadat ieder gevraagd bestand bestaat en iedere gevraagde uitvoering een geslaagd toolresultaat heeft.',
  'Na een gefaald commando moet je het relevante bestand herstellen voordat je hetzelfde commando opnieuw uitvoert.',
  'Schrijf op Windows terminalcode die UTF-8-uitvoer veilig configureert of alleen tekens uitvoert die de actieve encoding ondersteunt.',
  'Sluit iedere beurt af met een eerlijk tekstantwoord: wat is gelukt, wat is mislukt en welke uitvoer is werkelijk waargenomen.',
].join(' ');

const GEMINI_NATIVE_TOOL_GUIDANCE_EN = [
  'You are using PC tools managed by LLMelt.',
  'After every functionResponse explicitly check response.ok. If ok=false, the action failed.',
  'Never repeat a failed or identical tool call unchanged; investigate and change the cause first.',
  'Before your first tool call, plan every explicitly requested artifact and action; words such as two, both, and all are hard counts.',
  'Read an existing file with read_file before editing it unless its current full contents already appear in the conversation or tool output.',
  'Do not request a dependent run_command in the same round as an unconfirmed write_file or edit_file; wait for response.ok=true first.',
  'Finish only after every requested file exists and every requested execution has a successful tool result.',
  'After a failed command, repair the relevant file before running the same command again.',
  'On Windows, write terminal code that safely configures UTF-8 output or emits only characters supported by the active encoding.',
  'End every turn with an honest text answer stating what succeeded, what failed, and what output was actually observed.',
].join(' ');

export async function runGeminiApiNative(
  options: RunGeminiApiNativeOptions,
): Promise<RunGeminiApiNativeResult> {
  const contents: GeminiContent[] = structuredClone(options.contents);
  const apiBaseUrl = (options.apiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const language = options.language || 'nl';
  const systemInstruction = withNativeToolGuidance(options.systemInstruction, language);
  const executedCalls = new Map<string, ExecutedCall>();
  const executedCallIds = new Set<string>();
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let mutationEpoch = 0;
  let stagnantRounds = 0;
  let terminationReason = '';
  let lastFailure = '';
  let skipRecoveryRequest = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    options.onStatus?.(round
      ? localizedText(language, `Gemini verwerkt tool-output (${round + 1}/${MAX_TOOL_ROUNDS})`, `Gemini is processing tool output (${round + 1}/${MAX_TOOL_ROUNDS})`)
      : localizedText(language, 'Gemini denkt', 'Gemini is thinking'));
    let response: GeminiRoundResult;
    try {
      response = await requestGeminiRound(options, {
        apiBaseUrl,
        contents,
        systemInstruction,
        allowTools: true,
      });
    } catch (error) {
      if (options.signal.aborted) throw abortError(options.signal, language);
      // Zodra een tool werkelijk is uitgevoerd, mag de provider-fallback de hele beurt niet
      // opnieuw starten: dat zou bestanden/commando's dubbel kunnen uitvoeren. Bewaar in dat
      // geval de toolresultaten en probeer nog precies één toolvrije afsluitronde.
      if (!executedCalls.size) throw error;
      terminationReason = localizedText(language, `De Gemini-vervolgrequest mislukte (${error instanceof Error ? error.message : String(error)})`, `The Gemini follow-up request failed (${error instanceof Error ? error.message : String(error)})`);
      break;
    }
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    finalText = joinNativeText(finalText, response.text);

    if (response.modelParts.length) contents.push({ role: 'model', parts: response.modelParts });
    if (response.blockReason || isUnusableFinish(response.finishReason)) {
      // Google adviseert finishReason altijd te controleren. Een ogenschijnlijk parsebare
      // functionCall uit een afgekapt/geblokkeerd antwoord is niet veilig om uit te voeren.
      terminationReason = describeEmptyRound(response, language);
      skipRecoveryRequest = !!response.blockReason || isSafetyFinish(response.finishReason);
      break;
    }
    if (!response.functionCalls.length) {
      if (response.text.trim()) {
        return { text: finalText.trim(), inputTokens, outputTokens };
      }
      terminationReason = describeEmptyRound(response, language);
      skipRecoveryRequest = !!response.blockReason || isSafetyFinish(response.finishReason);
      break;
    }

    const responseParts: GeminiPart[] = [];
    let executedThisRound = 0;
    let deniedThisRound = false;

    for (const { call } of response.functionCalls) {
      const toolName = String(call.name || localizedText(language, 'onbekende_tool', 'unknown_tool'));
      const input = normalizeArguments(call.args);
      const toolUseId = call.id || `gemini-${crypto.randomUUID()}`;
      const signature = nativeToolCallSignature(call.name, normalizeArguments(call.args), language);
      const previous = executedCalls.get(signature);
      const repeatedCallId = !!call.id && executedCallIds.has(call.id);
      // Ook een eerder geslaagde identieke call kan side-effects hebben (met name
      // run_command). Een nieuwe provider-id maakt die herhaling niet veilig. Pas na
      // een echte bestandsmutatie begint een nieuwe epoch waarin opnieuw testen mag.
      const repeatedSignatureWithoutMutation = !!previous && previous.epoch === mutationEpoch;
      const replayWithoutProgress = repeatedCallId || repeatedSignatureWithoutMutation;
      options.onToolActivity?.({
        provider: 'google',
        toolName,
        input,
        toolUseId,
        phase: 'requested',
      });
      options.onStatus?.(localizedText(language, `Gemini gebruikt ${toolName}`, `Gemini is using ${toolName}`));

      let result: NativeToolExecutionResult;
      if (replayWithoutProgress) {
        result = {
          ok: false,
          output: (language === 'nl' ? [
            '[niet opnieuw uitgevoerd: geen voortgang]',
            `Gemini vroeg dezelfde ${toolName}-actie opnieuw zonder relevante wijziging.`,
            previous?.ok ? 'De eerdere identieke actie was al geslaagd.' : 'De eerdere identieke actie was mislukt.',
            'Herstel of wijzig eerst de oorzaak met een andere toolcall, of geef een eerlijk eindantwoord.',
          ] : [
            '[not executed again: no progress]',
            `Gemini requested the same ${toolName} action again without a relevant change.`,
            previous?.ok ? 'The earlier identical action had already succeeded.' : 'The earlier identical action had failed.',
            'First repair or change the cause with a different tool call, or provide an honest final answer.',
          ]).join(' '),
        };
      } else {
        executedThisRound += 1;
        result = await executeToolSafely(options, toolName, input, toolUseId);
        if (result.ok && isNativeMutationTool(toolName)) mutationEpoch += 1;
        executedCalls.set(signature, { epoch: mutationEpoch, ok: result.ok });
        if (call.id) executedCallIds.add(call.id);
      }

      deniedThisRound ||= !!result.denied;
      if (!result.ok) lastFailure = modelSafeToolOutput(result.output, language);
      options.onToolActivity?.({
        provider: 'google',
        toolName,
        input,
        toolUseId,
        phase: result.denied ? 'denied' : 'result',
        ok: result.ok,
        output: result.output,
      });
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: toolName,
          response: nativeToolFeedback(result, replayWithoutProgress, language),
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });

    stagnantRounds = executedThisRound === 0 ? stagnantRounds + 1 : 0;
    if (deniedThisRound) {
      terminationReason = localizedText(language, 'Een benodigde toolactie is door de gebruiker geweigerd', 'A required tool action was denied by the user');
      break;
    }
    if (stagnantRounds >= MAX_STAGNANT_ROUNDS) {
      terminationReason = localizedText(language, 'Gemini bleef identieke toolacties aanvragen zonder voortgang', 'Gemini kept requesting identical tool actions without progress');
      break;
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      terminationReason = localizedText(language, `De veiligheidsgrens van ${MAX_TOOL_ROUNDS} toolrondes is bereikt`, `The safety limit of ${MAX_TOOL_ROUNDS} tool rounds was reached`);
    }
  }

  if (options.signal.aborted) throw abortError(options.signal, language);
  const reason = terminationReason || localizedText(language, 'Gemini leverde geen afsluitend tekstantwoord', 'Gemini did not provide a final text answer');
  let recoveryError = '';

  if (!skipRecoveryRequest) {
    options.onStatus?.(localizedText(language, 'Gemini rondt af zonder extra tools', 'Gemini is finishing without additional tools'));
    appendRecoveryInstruction(contents, reason, lastFailure, language);
    try {
      const recovery = await requestGeminiRound(options, {
        apiBaseUrl,
        contents,
        systemInstruction,
        allowTools: false,
      });
      inputTokens += recovery.inputTokens;
      outputTokens += recovery.outputTokens;
      finalText = joinNativeText(finalText, recovery.text);
      if (recovery.text.trim() && !recovery.blockReason && !isUnusableFinish(recovery.finishReason)) {
        return { text: finalText.trim(), inputTokens, outputTokens };
      }
      recoveryError = describeEmptyRound(recovery, language);
    } catch (error) {
      if (options.signal.aborted) throw abortError(options.signal, language);
      recoveryError = error instanceof Error ? error.message : String(error);
    }
  }

  const fallback = buildRecoveryFallback(reason, lastFailure, recoveryError, language);
  options.onDelta(joinNativeText(finalText ? '\n' : '', fallback));
  return {
    text: joinNativeText(finalText, fallback).trim(),
    inputTokens,
    outputTokens,
  };
}

async function requestGeminiRound(
  options: RunGeminiApiNativeOptions,
  request: {
    apiBaseUrl: string;
    contents: GeminiContent[];
    systemInstruction: { parts: Array<{ text: string }> };
    allowTools: boolean;
  },
): Promise<GeminiRoundResult> {
  const response = await fetch(
    `${request.apiBaseUrl}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        contents: request.contents,
        systemInstruction: request.systemInstruction,
        tools: [{ functionDeclarations: nativeAppToolDeclarations(options.language || 'nl') }],
        toolConfig: {
          functionCallingConfig: { mode: request.allowTools ? 'AUTO' : 'NONE' },
        },
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || localizedText(options.language || 'nl', `Gemini native tools faalden met HTTP ${response.status}.`, `Gemini native tools failed with HTTP ${response.status}.`));
  }
  if (!response.body) throw new Error(localizedText(options.language || 'nl', 'Gemini gaf geen native tool-stream terug.', 'Gemini did not return a native tool stream.'));

  const modelParts: GeminiPart[] = [];
  const functionCalls: Array<{ call: GeminiFunctionCall; part: GeminiPart }> = [];
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;
  let finishMessage: string | undefined;
  let blockReason: string | undefined;

  for await (const event of parseGeminiSse(response)) {
    const candidate = event?.candidates?.[0];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts as GeminiPart[] : [];
    for (const rawPart of parts) {
      const part = structuredClone(rawPart);
      modelParts.push(part);
      if (typeof part.text === 'string' && part.text) {
        text += part.text;
        options.onDelta(part.text);
      }
      if (part.functionCall) functionCalls.push({ call: part.functionCall, part });
    }
    if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
    if (typeof candidate?.finishMessage === 'string') finishMessage = candidate.finishMessage;
    if (typeof event?.promptFeedback?.blockReason === 'string') blockReason = event.promptFeedback.blockReason;
    if (event?.usageMetadata) {
      inputTokens = Number(event.usageMetadata.promptTokenCount) || 0;
      outputTokens = Number(event.usageMetadata.candidatesTokenCount) || 0;
    }
  }

  return {
    modelParts,
    functionCalls,
    text,
    inputTokens,
    outputTokens,
    finishReason,
    finishMessage,
    blockReason,
  };
}

async function executeToolSafely(
  options: RunGeminiApiNativeOptions,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): Promise<NativeToolExecutionResult> {
  try {
    return await options.executeTool(toolName, input, toolUseId);
  } catch (error) {
    return {
      ok: false,
      output: localizedText(options.language || 'nl', `[tool-uitvoering mislukt] ${error instanceof Error ? error.message : String(error)}`, `[tool execution failed] ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

function withNativeToolGuidance(systemInstruction: { parts: Array<{ text: string }> } | undefined, language: UiLanguage) {
  return {
    parts: [
      ...(systemInstruction?.parts || []).map((part) => ({ text: String(part.text || '') })),
      { text: localizedText(language, GEMINI_NATIVE_TOOL_GUIDANCE_NL, GEMINI_NATIVE_TOOL_GUIDANCE_EN) },
    ],
  };
}

function appendRecoveryInstruction(contents: GeminiContent[], reason: string, lastFailure: string, language: UiLanguage) {
  const failure = clipNativeToolDetail(lastFailure, 12_000, language);
  const text = (language === 'nl' ? [
    '[LLMelt heeft verdere toolcalls uitgeschakeld.]',
    `${reason}.`,
    failure ? `Laatste toolfout:\n${failure}` : '',
    'Geef nu zonder function calls een beknopt maar volledig eindantwoord.',
    'Noem alleen daadwerkelijk voltooide acties als voltooid en rapporteer resterende fouten eerlijk.',
  ] : [
    '[LLMelt has disabled further tool calls.]',
    `${reason}.`,
    failure ? `Last tool error:\n${failure}` : '',
    'Now provide a concise but complete final answer without function calls.',
    'Only describe actions as completed when they actually completed, and report remaining errors honestly.',
  ]).filter(Boolean).join('\n\n');
  const last = contents.at(-1);
  if (last?.role === 'user') last.parts.push({ text });
  else contents.push({ role: 'user', parts: [{ text }] });
}

function buildRecoveryFallback(reason: string, lastFailure: string, recoveryError: string, language: UiLanguage) {
  return (language === 'nl' ? [
    `Gemini kon de tooltaak niet volledig afronden: ${reason}.`,
    lastFailure ? `Laatste toolfout:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
    recoveryError ? `Ook het verplichte eindantwoord mislukte: ${clipNativeToolDetail(recoveryError, 12_000, language)}.` : '',
    'Reeds getoonde toolkaarten blijven de gezaghebbende uitvoer; niet-uitgevoerde stappen zijn niet als voltooid gemarkeerd.',
  ] : [
    `Gemini could not fully complete the tool task: ${reason}.`,
    lastFailure ? `Last tool error:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
    recoveryError ? `The required final answer also failed: ${clipNativeToolDetail(recoveryError, 12_000, language)}.` : '',
    'The tool cards already shown remain the authoritative output; unexecuted steps are not marked as completed.',
  ]).filter(Boolean).join('\n\n');
}

function describeEmptyRound(response: GeminiRoundResult, language: UiLanguage) {
  if (response.blockReason) return localizedText(language, `Gemini blokkeerde de prompt (${response.blockReason})`, `Gemini blocked the prompt (${response.blockReason})`);
  if (response.finishReason) {
    return localizedText(language, `Gemini stopte zonder bruikbaar eindantwoord (${response.finishReason}${response.finishMessage ? `: ${response.finishMessage}` : ''})`, `Gemini stopped without a usable final answer (${response.finishReason}${response.finishMessage ? `: ${response.finishMessage}` : ''})`);
  }
  return localizedText(language, 'Gemini gaf een lege respons zonder eindantwoord', 'Gemini returned an empty response without a final answer');
}

function isSafetyFinish(reason?: string) {
  return ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'].includes(String(reason || '').toUpperCase());
}

function isUnusableFinish(reason?: string) {
  const normalized = String(reason || '').toUpperCase();
  return !!normalized && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(normalized);
}

function abortError(signal: AbortSignal, language: UiLanguage = 'nl') {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(localizedText(language, 'Gemini-beurt afgebroken.', 'Gemini turn aborted.'), 'AbortError');
}

async function* parseGeminiSse(response: Response): AsyncGenerator<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const block of events) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (done) break;
  }

  const data = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data && data !== '[DONE]') yield JSON.parse(data);
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
