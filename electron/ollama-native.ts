// Native Ollama function calling via /api/chat.
//
// Ollama is geen zelfstandige coding-agent: het model retourneert tool_calls en de app
// voert die uit. Daardoor blijven padvalidatie, shellkeuze en approvals volledig in de
// bestaande Electron-laag, terwijl het model wel het officiële native toolprotocol gebruikt.

import crypto from 'crypto';
import {
  NATIVE_APP_TOOL_DECLARATIONS,
  nativeToolInputProtocolError,
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
import { ollamaChatRequestBody, parseOllamaNdjson } from './ollama-stream';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  function?: {
    index?: number;
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

type OllamaRoundResult = {
  text: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  inputTokens: number;
  outputTokens: number;
  doneReason?: string;
  done: boolean;
};

type ExecutedCall = {
  epoch: number;
  ok: boolean;
  output?: string;
};

export interface RunOllamaNativeOptions {
  baseUrl: string;
  model: string;
  messages: OllamaMessage[];
  signal: AbortSignal;
  executeTool: NativeToolExecutor;
  /** De originele gebruikersvraag verlangt aantoonbaar een PC-actie. */
  requireToolUse?: boolean;
  /** Live gemeld door Ollama /api/show; nooit uit de modelnaam afgeleid. */
  supportsThinking?: boolean;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
}

export interface RunOllamaNativeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export const OLLAMA_NATIVE_TOOLS = NATIVE_APP_TOOL_DECLARATIONS.map((declaration) => ({
  type: 'function' as const,
  function: declaration,
}));

const MAX_TOOL_ROUNDS = 12;
const MAX_STAGNANT_ROUNDS = 2;
const OLLAMA_NATIVE_TOOL_GUIDANCE = [
  'Je gebruikt door LLMelt beheerde PC-tools in een meerstaps-tool-loop.',
  'Toolresultaten zijn JSON: controleer altijd ok en errorCode.',
  'Herhaal een mislukte toolcall niet ongewijzigd; herstel eerst het relevante bestand of kies een andere stap.',
  'Plan voor je eerste toolcall alle expliciet gevraagde artefacten en acties; woorden als twee, beide en alle zijn harde aantallen.',
  'Respecteer een expliciet gevraagd bestandstype: Python-script betekent .py, JavaScript betekent .js en PowerShell-script betekent .ps1. Maak geen README of alternatief document tenzij de gebruiker dat vraagt.',
  'Lees een bestaand bestand eerst met read_file voordat je het bewerkt, tenzij de actuele volledige inhoud al in de conversatie of tool-output staat.',
  'Repareer met de kleinst mogelijke exacte wijziging; introduceer geen onnodige hulpvariabelen of herstructurering.',
  'Voer na een geslaagde reparatie de relevante verificatie uit; lees en herschrijf niet herhaaldelijk zonder nieuwe foutinformatie.',
  'Vraag een afhankelijk run_command niet in dezelfde ronde als een nog niet bevestigde write_file of edit_file; wacht eerst op ok=true.',
  'Rond pas af nadat ieder gevraagd bestand bestaat en iedere gevraagde uitvoering een geslaagd toolresultaat heeft.',
  'Na een gefaald commando moet je de oorzaak wijzigen voordat je hetzelfde commando opnieuw uitvoert.',
  'Als read_file meldt dat een bestand niet bestaat: herhaal read_file niet; maak het gevraagde nieuwe bestand met write_file.',
  'Als edit_file meldt dat old_text niet is gevonden: lees het actuele bestand en gebruik daarna letterlijk aanwezige old_text.',
  'Controleer vóór afronden ook iedere expliciete inhoudseis uit de gebruikersvraag, zoals aantallen, ANSI-kleuren, animatie/sleep en gevraagde uitvoer.',
  'Op Windows: laat shell bij voorkeur weg zodat de app de ingestelde shell gebruikt. Kies alleen pwsh als een eerder toolresultaat bewijst dat PowerShell 7 bestaat.',
  'Gebruik op Windows geen Unix-constructies zoals tee, /dev/null of bash-redirections. Voer onafhankelijke controles als aparte eenvoudige run_command-calls uit.',
  'PowerShell 5 ondersteunt && niet; gebruik een PowerShell if-blok, puntkomma of aparte run_command-calls.',
  'Schrijf op Windows terminalcode die UTF-8-uitvoer veilig configureert of alleen tekens uitvoert die de actieve encoding ondersteunt.',
  'Als de gebruiker vraagt het programma uit te voeren: maak het non-interactief en eindig; geen input(), oneindige lus of "druk Ctrl+C". Een korte animatie stopt vanzelf binnen tien seconden.',
  'Sluit iedere beurt af met gewone tekst die eerlijk meldt wat werkelijk gelukt en mislukt is.',
].join(' ');

export async function runOllamaNative(options: RunOllamaNativeOptions): Promise<RunOllamaNativeResult> {
  const messages: OllamaMessage[] = structuredClone(options.messages);
  const requestedArtifactCount = explicitRequestedArtifactCount(messages);
  const requiredArtifactExtension = requestedArtifactExtension(messages);
  const requiresArtifactExecution = requestRequiresArtifactExecution(messages);
  addOllamaToolGuidance(messages);
  const executedCalls = new Map<string, ExecutedCall>();
  const executedCallIds = new Set<string>();
  const createdFiles = new Set<string>();
  const successfullyExecutedFiles = new Set<string>();
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let mutationEpoch = 0;
  let stagnantRounds = 0;
  let terminationReason = '';
  let lastFailure = '';
  let lastFailedToolName = '';
  let auditedExecutionCount = -1;
  let retriedToolProtocol = false;
  let completionGatePasses = 0;
  const thinkDuringToolTurn = !!options.requireToolUse
    && (options.supportsThinking ?? await detectOllamaThinkingCapability(options));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    options.onStatus?.(round
      ? `Ollama verwerkt tool-output (${round + 1}/${MAX_TOOL_ROUNDS})`
      : 'Ollama denkt');
    let response: OllamaRoundResult;
    try {
      response = await requestOllamaRound(options, messages, true, thinkDuringToolTurn);
    } catch (error) {
      if (options.signal.aborted) throw abortError(options.signal);
      // Na een echte toolactie mag een hogere fallback-laag de hele beurt niet opnieuw
      // uitvoeren. Dat kan commando's/bestandsmutaties verdubbelen; rond lokaal veilig af.
      if (!executedCalls.size) throw error;
      terminationReason = `De Ollama-vervolgrequest mislukte (${error instanceof Error ? error.message : String(error)})`;
      break;
    }

    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    const completionBeforeResponse = ollamaArtifactCompletionEvidence(
      requestedArtifactCount,
      requiresArtifactExecution,
      createdFiles,
      successfullyExecutedFiles,
    );
    // Kleine lokale modellen blijven soms na een harde completion-gate beweren dat
    // een gemaakt script is uitgevoerd zonder run_command. Na één expliciete
    // herstelvraag mag de app de reeds door de gebruiker gevraagde, veilige
    // uitvoeractie deterministisch plannen. De gewone executor en dus dezelfde
    // approval-popup blijven volledig van kracht.
    if (
      !response.toolCalls.length
      && response.text.trim()
      && completionGatePasses > 0
      && !completionBeforeResponse.missingCreatedArtifacts
      && completionBeforeResponse.missingExecutedFiles.length
    ) {
      const nextFile = completionBeforeResponse.missingExecutedFiles[0];
      const command = ollamaArtifactExecutionCommand(nextFile);
      if (command) {
        response = {
          ...response,
          text: '',
          toolCalls: [{
            id: `ollama-completion-${crypto.randomUUID()}`,
            function: {
              name: 'run_command',
              arguments: { command },
            },
          }],
        };
        options.onStatus?.(`Ollama voert gevraagd bestand uit: ${nextFile}`);
      }
    }
    if (response.text || response.thinking || response.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: response.text,
        ...(response.thinking ? { thinking: response.thinking } : {}),
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
      });
    }

    if (isIncompleteDoneReason(response.doneReason)) {
      terminationReason = `Ollama gaf een onvolledig antwoord (${response.doneReason})`;
      break;
    }

    if (!response.toolCalls.length) {
      if (options.requireToolUse && executedCalls.size === 0) {
        if (!retriedToolProtocol) {
          retriedToolProtocol = true;
          messages.push({
            role: 'user',
            content: [
              '[LLMelt toolprotocol-herstel]',
              'De originele gebruikersvraag vereist echte bestands- of commandoacties, maar je vorige antwoord bevatte geen geregistreerde function call.',
              'Geef nu exact de eerstvolgende noodzakelijke geregistreerde function call. Geen prose, codeblok of instructie aan de gebruiker.',
            ].join('\n'),
          });
          continue;
        }
        terminationReason = 'Ollama gaf ook na de verplichte toolprotocol-herstelronde geen toolcall';
        break;
      }
      if (response.text.trim() && !isIncompleteDoneReason(response.doneReason)) {
        const completion = ollamaArtifactCompletionEvidence(
          requestedArtifactCount,
          requiresArtifactExecution,
          createdFiles,
          successfullyExecutedFiles,
        );
        const missingCreatedArtifacts = completion.missingCreatedArtifacts;
        const missingExecutedArtifacts = completion.missingExecutedFiles.length > 0;
        if (options.requireToolUse && (missingCreatedArtifacts || missingExecutedArtifacts)) {
          completionGatePasses += 1;
          messages.push({
            role: 'user',
            content: [
              '[LLMelt harde completion gate]',
              missingCreatedArtifacts
                ? `De gebruiker vroeg ${requestedArtifactCount} nieuwe artefacten, maar slechts ${createdFiles.size} write_file-resultaten zijn geslaagd.`
                : `De gebruiker vroeg de gemaakte artefacten echt uit te voeren, maar ${completion.missingExecutedFiles.length} bestand(en) missen een geslaagde run_command.`,
              completion.missingExecutedFiles.length
                ? `Nog niet succesvol uitgevoerd: ${completion.missingExecutedFiles.join(', ')}.`
                : '',
              completion.missingExecutedFiles[0] && ollamaArtifactExecutionCommand(completion.missingExecutedFiles[0])
                ? `Roep nu run_command aan met command=${JSON.stringify(ollamaArtifactExecutionCommand(completion.missingExecutedFiles[0]))}.`
                : 'Geef nu alleen de eerstvolgende geregistreerde function call die deze ontbrekende stap uitvoert of repareert.',
              'Geen gewone tekst en claim geen terminaluitvoer zonder een geslaagd toolresultaat.',
            ].filter(Boolean).join('\n'),
          });
          continue;
        }
        // Een lokaal model kan na enkele geslaagde tools eerlijk beschrijven dat er
        // nog stappen ontbreken. Dat is waardevolle diagnose, maar geen eindantwoord:
        // dwing de eerstvolgende concrete toolactie af zolang de rondegrens dat toelaat.
        if (options.requireToolUse && executedCalls.size > 0 && reportsIncompleteTask(response.text)) {
          messages.push({
            role: 'user',
            content: [
              '[LLMelt onvoltooide-taak-herstel]',
              'Je eigen laatste antwoord meldt dat de originele opdracht nog niet volledig is uitgevoerd, gevalideerd of gerepareerd.',
              'Rond daarom niet af. Geef nu exact de eerstvolgende noodzakelijke geregistreerde function call, zonder prose of codeblok.',
            ].join('\n'),
          });
          continue;
        }
        // Na echte tools is een eerste proza-afsluiting van kleine lokale modellen
        // vaak prematuur (bijv. "voer het nu uit" na alleen write_file). Laat het
        // model de originele opdracht tegen de echte toolhistorie auditen. Alleen
        // als dezelfde uitvoeringsstand daarna opnieuw tot tekst leidt, is het final.
        if (executedCalls.size > 0 && auditedExecutionCount !== executedCalls.size) {
          auditedExecutionCount = executedCalls.size;
          messages.push({
            role: 'user',
            content: [
              '[LLMelt completion audit]',
              'Controleer de originele gebruikersopdracht tegen ALLE echte toolresultaten hierboven.',
              'Zijn aantallen, bestanden, reparaties en gevraagde uitvoeringen werkelijk allemaal voltooid?',
              'Zo nee: geef nu alleen de eerstvolgende ontbrekende geregistreerde function call, zonder prose of codeblok.',
              'Zo ja: geef een kort eerlijk eindantwoord zonder nieuwe toolcall.',
            ].join('\n'),
          });
          continue;
        }
        finalText = joinNativeText(finalText, response.text);
        options.onDelta(response.text);
        return { text: finalText.trim(), inputTokens, outputTokens };
      }
      terminationReason = response.doneReason
        ? `Ollama stopte zonder bruikbaar eindantwoord (${response.doneReason})`
        : 'Ollama gaf een lege respons zonder eindantwoord';
      break;
    }

    let executedThisRound = 0;
    let deniedThisRound = false;
    let correctiveFeedbackThisRound = false;
    for (const call of response.toolCalls) {
      const toolName = String(call.function?.name || 'onbekende_tool');
      const input = normalizeArguments(call.function?.arguments);
      const toolUseId = call.id || `ollama-${crypto.randomUUID()}`;
      const signature = nativeToolCallSignature(toolName, input);
      const previous = executedCalls.get(signature);
      const repeatedCallId = !!call.id && executedCallIds.has(call.id);
      // Een identieke succesvolle run_command kan net zo goed een side-effect hebben.
      // Blokkeer daarom iedere identieke signature binnen dezelfde mutation-epoch.
      const repeatedSignatureWithoutMutation = !!previous && previous.epoch === mutationEpoch;
      const repeatedSuccessfulWrite = toolName === 'write_file' && previous?.ok === true;
      const cachedReadAfterEditFailure = toolName === 'read_file'
        && previous?.ok === true
        && typeof previous.output === 'string'
        && lastFailedToolName === 'edit_file';
      const replayWithoutProgress = !cachedReadAfterEditFailure
        && (repeatedCallId || repeatedSuccessfulWrite || repeatedSignatureWithoutMutation);

      const protocolError = nativeToolInputProtocolError(toolName, input);
      if (protocolError) {
        correctiveFeedbackThisRound = true;
        lastFailure = protocolError;
        executedCalls.set(signature, { epoch: mutationEpoch, ok: false, output: protocolError });
        if (call.id) executedCallIds.add(call.id);
        options.onStatus?.(`Ollama herstelt ongeldige ${toolName}-invoer`);
        messages.push({
          role: 'tool',
          tool_name: toolName,
          content: JSON.stringify({
            ok: false,
            protocol_error: protocolError,
            instruction: 'Corrigeer de function-call-invoer; deze actie is niet uitgevoerd.',
          }),
        });
        continue;
      }

      const requestedPath = typeof input.path === 'string'
        ? input.path.replace(/\\/g, '/').trim().toLocaleLowerCase()
        : '';
      if (
        toolName === 'write_file'
        && requiredArtifactExtension
        && requestedPath
        && !requestedPath.endsWith(requiredArtifactExtension)
      ) {
        correctiveFeedbackThisRound = true;
        messages.push({
          role: 'tool',
          tool_name: toolName,
          content: JSON.stringify({
            ok: false,
            errorCode: 'WRONG_ARTIFACT_TYPE',
            error: `De gebruiker vroeg ${requiredArtifactExtension}-bestanden; ${requestedPath} heeft een ander type.`,
            retryable: true,
            instruction: `Gebruik write_file met een pad dat eindigt op ${requiredArtifactExtension}. Maak geen README of alternatief document.`,
          }),
        });
        continue;
      }
      if (
        toolName === 'write_file'
        && requestedArtifactCount > 0
        && requestedPath
        && !createdFiles.has(requestedPath)
        && createdFiles.size >= requestedArtifactCount
      ) {
        correctiveFeedbackThisRound = true;
        const existing = [...createdFiles].join(', ');
        messages.push({
          role: 'tool',
          tool_name: toolName,
          content: JSON.stringify({
            ok: false,
            errorCode: 'EXTRA_ARTIFACT',
            error: `Het gevraagde aantal bestanden (${requestedArtifactCount}) bestaat al: ${existing}.`,
            retryable: true,
            instruction: 'Maak geen extra alternatief bestand. Valideer en voer de bestaande gevraagde bestanden uit.',
          }),
        });
        continue;
      }

      options.onToolActivity?.({
        provider: 'ollama',
        toolName,
        input,
        toolUseId,
        phase: 'requested',
      });
      options.onStatus?.(`Ollama gebruikt ${toolName}`);

      let result: NativeToolExecutionResult;
      if (cachedReadAfterEditFailure) {
        correctiveFeedbackThisRound = true;
        lastFailedToolName = '';
        result = {
          ok: true,
          output: `[gecachete herlezing; bestand is niet gewijzigd]\n${previous.output}`,
        };
      } else if (replayWithoutProgress) {
        result = {
          ok: false,
          output: [
            '[niet opnieuw uitgevoerd: geen voortgang]',
            `Ollama vroeg dezelfde ${toolName}-actie opnieuw zonder relevante wijziging.`,
            previous?.ok ? 'De eerdere actie was al geslaagd.' : 'De eerdere actie was mislukt.',
            'Herstel of wijzig eerst de oorzaak, of rond eerlijk af.',
          ].join(' '),
        };
      } else {
        executedThisRound += 1;
        // Iedere echte toolactie verandert het bewijsbeeld. Geef het model daarna
        // opnieuw één normale kans om de volgende ontbrekende stap zelf te plannen.
        completionGatePasses = 0;
        result = await executeToolSafely(options, toolName, input, toolUseId);
        if (result.ok && toolName === 'write_file' && requestedPath) createdFiles.add(requestedPath);
        if (result.ok && toolName === 'run_command') {
          recordSuccessfullyExecutedFiles(createdFiles, successfullyExecutedFiles, input);
        }
        if (result.ok && isNativeMutationTool(toolName)) mutationEpoch += 1;
        executedCalls.set(signature, {
          epoch: mutationEpoch,
          ok: result.ok,
          output: modelSafeToolOutput(result.output),
        });
        if (call.id) executedCallIds.add(call.id);
      }

      deniedThisRound ||= !!result.denied;
      if (!result.ok) {
        lastFailure = modelSafeToolOutput(result.output);
        lastFailedToolName = toolName;
      } else if (toolName !== 'read_file') {
        lastFailedToolName = '';
      }
      options.onToolActivity?.({
        provider: 'ollama',
        toolName,
        input,
        toolUseId,
        phase: result.denied ? 'denied' : 'result',
        ok: result.ok,
        output: result.output,
      });
      const feedback = nativeToolFeedback(result, replayWithoutProgress);
      const repairHint = ollamaToolRepairHint(toolName, result);
      messages.push({
        role: 'tool',
        tool_name: toolName,
        content: JSON.stringify({
          ...feedback,
          ...(repairHint ? { repairHint } : {}),
        }),
      });
    }

    stagnantRounds = executedThisRound === 0 && !correctiveFeedbackThisRound ? stagnantRounds + 1 : 0;
    if (deniedThisRound) {
      terminationReason = 'Een benodigde toolactie is door de gebruiker geweigerd';
      break;
    }
    if (stagnantRounds >= MAX_STAGNANT_ROUNDS) {
      terminationReason = 'Ollama bleef identieke mislukte toolacties aanvragen zonder voortgang';
      break;
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      terminationReason = `De veiligheidsgrens van ${MAX_TOOL_ROUNDS} toolrondes is bereikt`;
    }
  }

  if (options.signal.aborted) throw abortError(options.signal);
  const reason = terminationReason || 'Ollama leverde geen afsluitend tekstantwoord';
  const unresolvedCompletion = ollamaArtifactCompletionEvidence(
    requestedArtifactCount,
    requiresArtifactExecution,
    createdFiles,
    successfullyExecutedFiles,
  );
  options.onStatus?.('Ollama rondt af zonder extra tools');
  appendRecoveryInstruction(messages, reason, lastFailure);
  let recoveryError = '';
  try {
    const recovery = await requestOllamaRound(options, messages, false, false);
    inputTokens += recovery.inputTokens;
    outputTokens += recovery.outputTokens;
    finalText = joinNativeText(finalText, recovery.text);
    if (
      recovery.text.trim()
      && !recovery.toolCalls.length
      && !isIncompleteDoneReason(recovery.doneReason)
      && !unresolvedCompletion.missingCreatedArtifacts
      && !unresolvedCompletion.missingExecutedFiles.length
    ) {
      options.onDelta(recovery.text);
      return { text: finalText.trim(), inputTokens, outputTokens };
    }
    recoveryError = unresolvedCompletion.missingCreatedArtifacts || unresolvedCompletion.missingExecutedFiles.length
      ? [
        'De completion-gate is niet gehaald',
        unresolvedCompletion.missingCreatedArtifacts
          ? `${createdFiles.size}/${requestedArtifactCount} gevraagde artefacten gemaakt`
          : '',
        unresolvedCompletion.missingExecutedFiles.length
          ? `niet uitgevoerd: ${unresolvedCompletion.missingExecutedFiles.join(', ')}`
          : '',
      ].filter(Boolean).join('; ')
      : recovery.toolCalls.length
        ? 'Ollama vroeg ondanks uitgeschakelde tools opnieuw een toolcall'
        : recovery.doneReason
          ? `Ollama stopte opnieuw zonder bruikbaar eindantwoord (${recovery.doneReason})`
          : 'Ollama gaf opnieuw een lege respons';
  } catch (error) {
    if (options.signal.aborted) throw abortError(options.signal);
    recoveryError = error instanceof Error ? error.message : String(error);
  }

  const fallback = buildRecoveryFallback(reason, lastFailure, recoveryError);
  options.onDelta(joinNativeText(finalText ? '\n' : '', fallback));
  return {
    text: joinNativeText(finalText, fallback).trim(),
    inputTokens,
    outputTokens,
  };
}

export function explicitRequestedArtifactCount(messages: OllamaMessage[]) {
  const request = [...messages].reverse().find((message) => message.role === 'user')?.content.toLocaleLowerCase() || '';
  if (!/\b(?:maak|maken|schrijf|save|sla|bouw|genereer|create|write|build|generate)\b/i.test(request)) return 0;
  const subject = '(?:bestanden?|files?|scripts?|programma(?:\\x27s)?|artifacts?|artefacten?)';
  const digit = request.match(new RegExp(`\\b([2-9])\\s+${subject}\\b`));
  if (digit) return Number(digit[1]);
  const words: Array<[RegExp, number]> = [
    [new RegExp(`\\b(?:twee|two)\\s+${subject}\\b`), 2],
    [new RegExp(`\\b(?:drie|three)\\s+${subject}\\b`), 3],
    [new RegExp(`\\b(?:vier|four)\\s+${subject}\\b`), 4],
  ];
  for (const [pattern, count] of words) {
    if (pattern.test(request)) return count;
  }
  return /\b(?:allebei|beide|both)\b/.test(request) ? 2 : 0;
}

export function requestedArtifactExtension(messages: OllamaMessage[]) {
  const request = [...messages].reverse().find((message) => message.role === 'user')?.content.toLocaleLowerCase() || '';
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:python(?:-|\s*)scripts?|pythonbestanden?|python\s+programs?)\b/i, '.py'],
    [/\b(?:javascript|node(?:\.js)?)(?:-|\s*)scripts?\b/i, '.js'],
    [/\b(?:powershell|pwsh)(?:-|\s*)scripts?\b/i, '.ps1'],
    [/\b(?:batch|cmd)(?:-|\s*)scripts?\b/i, '.cmd'],
  ];
  return candidates.find(([pattern]) => pattern.test(request))?.[1] || '';
}

export function ollamaArtifactCompletionEvidence(
  requestedArtifactCount: number,
  requiresArtifactExecution: boolean,
  createdFiles: ReadonlySet<string>,
  successfullyExecutedFiles: ReadonlySet<string>,
) {
  const missingCreatedArtifacts = requestedArtifactCount > 0
    && createdFiles.size < requestedArtifactCount;
  const executionTargetCount = requestedArtifactCount > 0
    ? Math.min(requestedArtifactCount, createdFiles.size)
    : createdFiles.size;
  const missingExecutedFiles = requiresArtifactExecution && executionTargetCount > 0
    ? [...createdFiles]
      .filter((file) => !successfullyExecutedFiles.has(file))
      .slice(0, executionTargetCount)
    : [];
  return { missingCreatedArtifacts, missingExecutedFiles };
}

export function ollamaArtifactExecutionCommand(filePath: string) {
  const normalized = String(filePath || '').replace(/\\/g, '/').trim();
  if (!normalized || /[\r\n]/.test(normalized)) return '';
  const quoted = `"${normalized.replace(/"/g, '""')}"`;
  if (/\.pyw?$/i.test(normalized)) return `python ${quoted}`;
  if (/\.(?:c?js|mjs)$/i.test(normalized)) return `node ${quoted}`;
  if (/\.ps1$/i.test(normalized)) return `powershell -NoProfile -File ${quoted}`;
  if (/\.(?:cmd|bat)$/i.test(normalized)) return `cmd /d /c ${quoted}`;
  return '';
}

function requestRequiresArtifactExecution(messages: OllamaMessage[]) {
  const request = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  return /\b(?:voer(?:en|t)?|run|execute)\b[\s\S]{0,100}\b(?:uit|them|it|scripts?|bestanden?|files?)\b/i.test(request)
    || /\b(?:run|execute)\s+(?:both|all|them|it)\b/i.test(request);
}

function recordSuccessfullyExecutedFiles(
  createdFiles: Set<string>,
  successfullyExecutedFiles: Set<string>,
  input: Record<string, unknown>,
) {
  const command = String(input.command || '').replace(/\\/g, '/').toLocaleLowerCase();
  for (const file of createdFiles) {
    const basename = file.split('/').at(-1) || file;
    if (command.includes(file) || command.includes(basename)) successfullyExecutedFiles.add(file);
  }
}

function ollamaToolRepairHint(toolName: string, result: NativeToolExecutionResult) {
  if (result.ok || result.denied) return '';
  const output = String(result.output || '');
  if (toolName === 'read_file' && /ENOENT|niet gevonden|does not exist/i.test(output)) {
    return 'Dit bestand bestaat niet. Als de gebruiker een nieuw bestand vroeg, gebruik write_file; herhaal read_file niet.';
  }
  if (toolName === 'edit_file' && /old_text niet gevonden|geen wijziging/i.test(output)) {
    return 'Lees het actuele bestand met read_file en maak daarna een nieuwe edit_file-call met exact aanwezige old_text.';
  }
  if (toolName === 'run_command') {
    if (/ENOENT|not recognized|wordt niet herkend|cannot find|kan het opgegeven bestand niet vinden/i.test(output)) {
      return 'De gekozen executable of shell bestaat niet. Laat shell weg voor de ingestelde standaardshell en gebruik op Windows eenvoudige PowerShell- of cmd-commando’s zonder Unix-hulpprogramma’s.';
    }
    if (/Unexpected token.*&&|The token ['"]&&['"] is not a valid statement separator/i.test(output)) {
      return 'PowerShell 5 ondersteunt && niet. Gebruik aparte run_command-calls of een PowerShell if-blok.';
    }
    return 'Lees de fout, wijzig eerst het relevante bestand en voer pas daarna het commando opnieuw uit.';
  }
  return '';
}

async function requestOllamaRound(
  options: RunOllamaNativeOptions,
  messages: OllamaMessage[],
  allowTools: boolean,
  think: boolean,
): Promise<OllamaRoundResult> {
  const response = await fetch(`${options.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      ...ollamaChatRequestBody(options.model, messages, {
        // De normale app-tool-loop plant na iedere echte toolrespons opnieuw. Alleen
        // een aantoonbaar gemiste eerste toolcall krijgt eenmaal een thinking-herstel.
        think,
        ...(allowTools ? { tools: OLLAMA_NATIVE_TOOLS } : {}),
      }),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Ollama native tools faalden met HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('Ollama gaf geen native tool-stream terug.');

  let text = '';
  let thinking = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let doneReason: string | undefined;
  let done = false;
  const calls = new Map<string, OllamaToolCall>();

  for await (const data of parseOllamaNdjson(response)) {
    if (typeof data.error === 'string' && data.error) throw new Error(data.error);
    const delta = typeof data.message?.content === 'string' ? data.message.content : '';
    if (delta) {
      text += delta;
    }
    if (typeof data.message?.thinking === 'string') thinking += data.message.thinking;
    if (Array.isArray(data.message?.tool_calls)) {
      for (const call of data.message.tool_calls as OllamaToolCall[]) {
        calls.set(streamedCallIdentity(call), structuredClone(call));
      }
    }
    if (typeof data.prompt_eval_count === 'number') inputTokens = data.prompt_eval_count;
    if (typeof data.eval_count === 'number') outputTokens = data.eval_count;
    if (typeof data.done_reason === 'string') doneReason = data.done_reason;
    if (data.done === true) done = true;
  }

  if (!done) throw new Error('Ollama-stream eindigde zonder een volledige done-respons.');

  // Sommige officieel als tools-capabel gemarkeerde lokale modellen serialiseren
  // function calls in message.content terwijl Ollama message.tool_calls leeg laat.
  // Accepteer alleen een antwoord dat VOLLEDIG uit bekende tool-JSON bestaat; losse
  // JSON in normale uitleg blijft gewone tekst en kan dus nooit onbedoeld uitvoeren.
  const textCalls = calls.size ? [] : parseStrictTextToolCalls(text);
  const parsedCalls = calls.size ? [...calls.values()] : textCalls;
  const hasTextCalls = textCalls.length > 0;

  return {
    text: hasTextCalls ? '' : text,
    thinking,
    // Lokale modellen plannen geregeld read+edit+run tegelijk zonder het read- of
    // editresultaat te kennen. Eén call per feedbackronde voorkomt speculatieve
    // afhankelijke acties; de grens van acht rondes laat normale agenttaken toe.
    toolCalls: parsedCalls.slice(0, 1),
    inputTokens,
    outputTokens,
    doneReason,
    done,
  };
}

const KNOWN_OLLAMA_TEXT_TOOLS = new Set<string>(NATIVE_APP_TOOL_DECLARATIONS.map((tool) => tool.name));

export function parseStrictTextToolCalls(text: string): OllamaToolCall[] {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate) return [];

  const values: unknown[] = [];
  for (const line of candidate.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if ((line.startsWith('//') || line.startsWith('#'))
      && line.length <= 300
      && !line.includes('{')
      && !line.includes('[')) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch {
      return [];
    }
  }
  if (!values.length) return [];

  const calls: OllamaToolCall[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const args = record.arguments;
    if (!KNOWN_OLLAMA_TEXT_TOOLS.has(name)) return [];
    if (!args || (typeof args !== 'object' && typeof args !== 'string')) return [];
    calls.push({ function: { name, arguments: args as Record<string, unknown> | string } });
  }
  return calls;
}

async function executeToolSafely(
  options: RunOllamaNativeOptions,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): Promise<NativeToolExecutionResult> {
  try {
    return await options.executeTool(toolName, input, toolUseId);
  } catch (error) {
    return {
      ok: false,
      output: `[tool-uitvoering mislukt] ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function addOllamaToolGuidance(messages: OllamaMessage[]) {
  const system = messages.find((message) => message.role === 'system');
  if (system) system.content = joinNativeText(system.content, OLLAMA_NATIVE_TOOL_GUIDANCE);
  else messages.unshift({ role: 'system', content: OLLAMA_NATIVE_TOOL_GUIDANCE });
}

async function detectOllamaThinkingCapability(options: RunOllamaNativeOptions) {
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]),
      body: JSON.stringify({ model: options.model }),
    });
    if (!response.ok) return false;
    const data = await response.json() as { capabilities?: unknown[] };
    return Array.isArray(data.capabilities)
      && data.capabilities.some((capability) => String(capability).toLowerCase() === 'thinking');
  } catch {
    return false;
  }
}

function appendRecoveryInstruction(messages: OllamaMessage[], reason: string, lastFailure: string) {
  messages.push({
    role: 'user',
    content: [
      '[LLMelt heeft verdere toolcalls uitgeschakeld.]',
      `${reason}.`,
      lastFailure ? `Laatste toolfout:\n${clipNativeToolDetail(lastFailure)}` : '',
      'Geef nu zonder tools een beknopt, eerlijk eindantwoord. Noem alleen werkelijk voltooide acties als voltooid.',
    ].filter(Boolean).join('\n\n'),
  });
}

function buildRecoveryFallback(reason: string, lastFailure: string, recoveryError: string) {
  return [
    `Ollama kon de tooltaak niet volledig afronden: ${reason}.`,
    lastFailure ? `Laatste toolfout:\n${clipNativeToolDetail(lastFailure)}` : '',
    recoveryError ? `Ook het verplichte eindantwoord mislukte: ${clipNativeToolDetail(recoveryError)}.` : '',
    'Reeds getoonde toolkaarten blijven de gezaghebbende uitvoer; niet-uitgevoerde stappen zijn niet als voltooid gemarkeerd.',
  ].filter(Boolean).join('\n\n');
}

function streamedCallIdentity(call: OllamaToolCall) {
  if (call.id) return `id:${call.id}`;
  if (typeof call.function?.index === 'number') return `index:${call.function.index}`;
  return `signature:${nativeToolCallSignature(call.function?.name, normalizeArguments(call.function?.arguments))}`;
}

function isIncompleteDoneReason(reason?: string) {
  return ['length', 'error', 'unload'].includes(String(reason || '').toLowerCase());
}

function reportsIncompleteTask(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return [
    /\b(?:taak|opdracht|uitvoering)\s+(?:is\s+)?(?:nog\s+)?(?:mislukt|onvoltooid|onvolledig)\b/i,
    /\b(?:niet|geen)\s+(?:volledig\s+)?(?:uitgevoerd|afgerond|voltooid|geverifieerd|gevalideerd)\b/i,
    /\bgeen\s+(?:uitvoering|validatie|verificatie|terminal-?uitvoer|command\s+execution)\b/i,
    /\b(?:niet|geen)\s+volledig\s+(?:valid|geldig|bruikbaar|klaar)\b/i,
    /\b(?:onvolledige?|extra\s+correcties?|handmatige\s+aanpassingen?)\b/i,
    /\b(?:onbruikbaar|moet(?:en)?\s+(?:nog|eerst)|tools?\s+stopte|uitvoering\s+stopte)\b/i,
    /\b(?:bevat(?:ten)?|heeft|hebben)\b.{0,80}\bsyntaxfout(?:en)?\b/i,
    /\b(?:task|request|execution)\s+(?:is\s+)?(?:still\s+)?(?:failed|incomplete|unfinished)\b/i,
    /\b(?:not|never)\s+(?:fully\s+)?(?:executed|completed|finished|verified|validated)\b/i,
    /\bno\s+(?:execution|validation|verification|terminal\s+output)\b/i,
    /\bnot\s+fully\s+(?:valid|usable|ready)\b/i,
    /\b(?:unusable|must\s+(?:still|first)|needs?\s+to\s+(?:still|first))\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Ollama-beurt afgebroken.', 'AbortError');
}

function normalizeArguments(value: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
