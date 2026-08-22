// Native Ollama function calling via /api/chat.
//
// Ollama is geen zelfstandige coding-agent: het model retourneert tool_calls en de app
// voert die uit. Daardoor blijven padvalidatie, shellkeuze en approvals volledig in de
// bestaande Electron-laag, terwijl het model wel het officiële native toolprotocol gebruikt.

import crypto from 'crypto';
import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';
import {
  NATIVE_APP_TOOL_DECLARATIONS,
  nativeAppToolDeclarations,
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
  /** Live capabilitymetadata; toolrondes houden verborgen thinking bewust uit. */
  supportsThinking?: boolean;
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onToolActivity?: (activity: NativeToolActivity) => void;
  language?: UiLanguage;
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

export function ollamaNativeTools(language: UiLanguage = 'nl') {
  return nativeAppToolDeclarations(language).map((declaration) => ({
    type: 'function' as const,
    function: declaration,
  }));
}

const MAX_TOOL_ROUNDS = 12;
const MAX_STAGNANT_ROUNDS = 2;
// Ollama stuurt native toolcalls pas terug wanneer de generatie klaar is. Zonder
// uitvoergrens kan een lokaal model daarom minutenlang blijven genereren voordat
// LLMelt ook maar één toolcall ziet. Een toolronde voert hier bewust maximaal één
// call uit. Een write_file-call kan zelf enkele duizenden tokens broncode bevatten;
// 4096 voorkomt dat Ollama zo'n geldige function call vlak voor de afsluitende JSON
// afkapt. De ronde- en stagnatiegrenzen houden ontspoorde generaties alsnog begrensd.
// Temperatuur 0 maakt dezelfde herstelronde stabiel.
const OLLAMA_NATIVE_MAX_PREDICT = 4_096;
const OLLAMA_NATIVE_TOOL_GUIDANCE_NL = [
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

const OLLAMA_NATIVE_TOOL_GUIDANCE_EN = [
  'You are using PC tools managed by LLMelt in a multi-step tool loop.',
  'Tool results are JSON: always check ok and errorCode.',
  'Do not repeat a failed tool call unchanged; first repair the relevant file or choose another step.',
  'Before your first tool call, plan every explicitly requested artifact and action; words such as two, both, and all are hard counts.',
  'Respect an explicitly requested file type: a Python script means .py, JavaScript means .js, and PowerShell means .ps1. Do not create a README or alternative document unless requested.',
  'Read an existing file with read_file before editing it unless its current full contents already appear in the conversation or tool output.',
  'Repair with the smallest possible exact change; do not introduce unnecessary helpers or restructuring.',
  'After a successful repair, run the relevant verification; do not repeatedly read and rewrite without new error information.',
  'Do not request a dependent run_command in the same round as an unconfirmed write_file or edit_file; wait for ok=true first.',
  'Finish only after every requested file exists and every requested execution has a successful tool result.',
  'After a failed command, change the cause before running the same command again.',
  'If read_file reports that a file does not exist, do not repeat read_file; create the requested new file with write_file.',
  'If edit_file reports that old_text was not found, read the current file and then use literally present old_text.',
  'Before finishing, verify every explicit content requirement such as counts, ANSI colors, animation/sleep, and requested output.',
  'On Windows, preferably omit shell so the app uses the configured shell. Select pwsh only if an earlier tool result proves PowerShell 7 exists.',
  'On Windows, do not use Unix constructs such as tee, /dev/null, or Bash redirection. Run independent checks as separate simple run_command calls.',
  'PowerShell 5 does not support &&; use a PowerShell if block, semicolon, or separate run_command calls.',
  'On Windows, write terminal code that safely configures UTF-8 output or emits only characters supported by the active encoding.',
  'If the user asks to run the program, make it non-interactive and terminating; no input(), infinite loop, or "press Ctrl+C". A short animation ends by itself within ten seconds.',
  'End every turn with ordinary text that honestly reports what actually succeeded and failed.',
].join(' ');

export async function runOllamaNative(options: RunOllamaNativeOptions): Promise<RunOllamaNativeResult> {
  const messages: OllamaMessage[] = structuredClone(options.messages);
  const language = options.language || 'nl';
  const requestedArtifactCount = explicitRequestedArtifactCount(messages);
  const requestedExtensions = requestedArtifactExtensions(messages);
  // Alleen een ondubbelzinnige enkelvoudige type-eis is een harde guard. Een
  // mixed-language opdracht moet juist meerdere gevraagde extensies toelaten.
  const requiredArtifactExtension = requestedExtensions.length === 1 ? requestedExtensions[0] : '';
  const requiresArtifactExecution = requestRequiresArtifactExecution(messages);
  addOllamaToolGuidance(messages, language);
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
  let incompleteRetriesAtCurrentEpoch = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    options.onStatus?.(round
      ? localizedText(language, `Ollama verwerkt tool-output (${round + 1}/${MAX_TOOL_ROUNDS})`, `Ollama is processing tool output (${round + 1}/${MAX_TOOL_ROUNDS})`)
      : localizedText(language, 'Ollama denkt', 'Ollama is thinking'));
    let response: OllamaRoundResult;
    try {
      // Native toolcalls moeten observeerbaar en begrensd blijven. Bij lokale
      // redeneermodellen kan verborgen thinking minutenlang doorgaan voordat Ollama
      // een function call publiceert. Ook protocolherstel gebeurt daarom met een
      // expliciete herstelprompt en nooit via een tweede verborgen denkfase.
      response = await requestOllamaRound(options, messages, true, false);
    } catch (error) {
      if (options.signal.aborted) throw abortError(options.signal, language);
      // Na een echte toolactie mag een hogere fallback-laag de hele beurt niet opnieuw
      // uitvoeren. Dat kan commando's/bestandsmutaties verdubbelen; rond lokaal veilig af.
      if (!executedCalls.size) throw error;
      terminationReason = localizedText(language, `De Ollama-vervolgrequest mislukte (${error instanceof Error ? error.message : String(error)})`, `The Ollama follow-up request failed (${error instanceof Error ? error.message : String(error)})`);
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
        options.onStatus?.(localizedText(language, `Ollama voert gevraagd bestand uit: ${nextFile}`, `Ollama is running requested file: ${nextFile}`));
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
      const completion = ollamaArtifactCompletionEvidence(
        requestedArtifactCount,
        requiresArtifactExecution,
        createdFiles,
        successfullyExecutedFiles,
      );
      const canResumeIncompleteToolPlan = options.requireToolUse
        && executedCalls.size > 0
        && incompleteRetriesAtCurrentEpoch < 2
        && (completion.missingCreatedArtifacts || completion.missingExecutedFiles.length > 0);
      if (canResumeIncompleteToolPlan) {
        incompleteRetriesAtCurrentEpoch += 1;
        messages.push({
          role: 'user',
          content: (language === 'nl' ? [
            '[LLMelt afgekapt toolplan-herstel]',
            `Je vorige generatie werd afgekapt (${response.doneReason}); die tekst of onvolledige call is niet uitgevoerd.`,
            completion.missingCreatedArtifacts
              ? `Er ontbreken nog ${Math.max(0, requestedArtifactCount - createdFiles.size)} van de ${requestedArtifactCount} gevraagde artefacten.`
              : `Nog niet succesvol uitgevoerd: ${completion.missingExecutedFiles.join(', ')}.`,
            'Geef nu uitsluitend de eerstvolgende volledige geregistreerde function call. Houd de inhoud doelgericht en compact; geen prose of codeblok.',
          ] : [
            '[LLMelt truncated tool-plan recovery]',
            `Your previous generation was truncated (${response.doneReason}); that text or incomplete call was not executed.`,
            completion.missingCreatedArtifacts
              ? `${Math.max(0, requestedArtifactCount - createdFiles.size)} of the ${requestedArtifactCount} requested artifacts are still missing.`
              : `Not successfully executed yet: ${completion.missingExecutedFiles.join(', ')}.`,
            'Return only the next complete registered function call. Keep its contents focused and compact; no prose or code block.',
          ]).join('\n'),
        });
        options.onStatus?.(localizedText(language, 'Ollama herstelt een afgekapt toolplan', 'Ollama is recovering a truncated tool plan'));
        continue;
      }
      terminationReason = localizedText(language, `Ollama gaf een onvolledig antwoord (${response.doneReason})`, `Ollama returned an incomplete response (${response.doneReason})`);
      break;
    }

    if (!response.toolCalls.length) {
      if (options.requireToolUse && executedCalls.size === 0) {
        if (!retriedToolProtocol) {
          retriedToolProtocol = true;
          messages.push({
            role: 'user',
            content: (language === 'nl' ? [
              '[LLMelt toolprotocol-herstel]',
              'De originele gebruikersvraag vereist echte bestands- of commandoacties, maar je vorige antwoord bevatte geen geregistreerde function call.',
              'Geef nu exact de eerstvolgende noodzakelijke geregistreerde function call. Geen prose, codeblok of instructie aan de gebruiker.',
            ] : [
              '[LLMelt tool protocol recovery]',
              'The original user request requires real file or command actions, but your previous response contained no registered function call.',
              'Now provide exactly the next required registered function call. No prose, code block, or instruction to the user.',
            ]).join('\n'),
          });
          continue;
        }
        terminationReason = localizedText(language, 'Ollama gaf ook na de verplichte toolprotocol-herstelronde geen toolcall', 'Ollama still returned no tool call after the required tool protocol recovery round');
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
            content: (language === 'nl' ? [
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
            ] : [
              '[LLMelt hard completion gate]',
              missingCreatedArtifacts
                ? `The user requested ${requestedArtifactCount} new artifacts, but only ${createdFiles.size} write_file results succeeded.`
                : `The user requested the created artifacts to be executed, but ${completion.missingExecutedFiles.length} file(s) lack a successful run_command.`,
              completion.missingExecutedFiles.length ? `Not successfully executed yet: ${completion.missingExecutedFiles.join(', ')}.` : '',
              completion.missingExecutedFiles[0] && ollamaArtifactExecutionCommand(completion.missingExecutedFiles[0])
                ? `Call run_command now with command=${JSON.stringify(ollamaArtifactExecutionCommand(completion.missingExecutedFiles[0]))}.`
                : 'Return only the next registered function call that executes or repairs this missing step.',
              'No ordinary text, and do not claim terminal output without a successful tool result.',
            ]).filter(Boolean).join('\n'),
          });
          continue;
        }
        // Een lokaal model kan na enkele geslaagde tools eerlijk beschrijven dat er
        // nog stappen ontbreken. Dat is waardevolle diagnose, maar geen eindantwoord:
        // dwing de eerstvolgende concrete toolactie af zolang de rondegrens dat toelaat.
        if (options.requireToolUse && executedCalls.size > 0 && reportsIncompleteTask(response.text)) {
          messages.push({
            role: 'user',
            content: (language === 'nl' ? [
              '[LLMelt onvoltooide-taak-herstel]',
              'Je eigen laatste antwoord meldt dat de originele opdracht nog niet volledig is uitgevoerd, gevalideerd of gerepareerd.',
              'Rond daarom niet af. Geef nu exact de eerstvolgende noodzakelijke geregistreerde function call, zonder prose of codeblok.',
            ] : [
              '[LLMelt incomplete-task recovery]',
              'Your own latest response says the original task has not been fully executed, validated, or repaired.',
              'Do not finish. Return exactly the next required registered function call, without prose or a code block.',
            ]).join('\n'),
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
            content: (language === 'nl' ? [
              '[LLMelt completion audit]',
              'Controleer de originele gebruikersopdracht tegen ALLE echte toolresultaten hierboven.',
              'Zijn aantallen, bestanden, reparaties en gevraagde uitvoeringen werkelijk allemaal voltooid?',
              'Zo nee: geef nu alleen de eerstvolgende ontbrekende geregistreerde function call, zonder prose of codeblok.',
              'Zo ja: geef een kort eerlijk eindantwoord zonder nieuwe toolcall.',
            ] : [
              '[LLMelt completion audit]',
              'Check the original user request against ALL real tool results above.',
              'Are counts, files, repairs, and requested executions truly all complete?',
              'If not: return only the next missing registered function call, without prose or a code block.',
              'If yes: give a short honest final answer without a new tool call.',
            ]).join('\n'),
          });
          continue;
        }
        finalText = joinNativeText(finalText, response.text);
        options.onDelta(response.text);
        return { text: finalText.trim(), inputTokens, outputTokens };
      }
      terminationReason = response.doneReason
        ? localizedText(language, `Ollama stopte zonder bruikbaar eindantwoord (${response.doneReason})`, `Ollama stopped without a usable final answer (${response.doneReason})`)
        : localizedText(language, 'Ollama gaf een lege respons zonder eindantwoord', 'Ollama returned an empty response without a final answer');
      break;
    }

    let executedThisRound = 0;
    let deniedThisRound = false;
    let correctiveFeedbackThisRound = false;
    for (const call of response.toolCalls) {
      const toolName = String(call.function?.name || localizedText(language, 'onbekende_tool', 'unknown_tool'));
      const input = normalizeArguments(call.function?.arguments);
      const toolUseId = call.id || `ollama-${crypto.randomUUID()}`;
      const signature = nativeToolCallSignature(toolName, input, language);
      const previous = executedCalls.get(signature);
      const repeatedCallId = !!call.id && executedCallIds.has(call.id);
      // Een identieke succesvolle run_command kan net zo goed een side-effect hebben.
      // Blokkeer daarom iedere identieke signature binnen dezelfde mutation-epoch.
      const repeatedSignatureWithoutMutation = !!previous && previous.epoch === mutationEpoch;
      const repeatedSuccessfulWrite = toolName === 'write_file' && previous?.ok === true;
      const missingRequestedArtifacts = Math.max(0, requestedArtifactCount - createdFiles.size);
      const cachedReadAfterEditFailure = toolName === 'read_file'
        && previous?.ok === true
        && typeof previous.output === 'string'
        && lastFailedToolName === 'edit_file';
      const replayWithoutProgress = !cachedReadAfterEditFailure
        && (repeatedCallId || repeatedSuccessfulWrite || repeatedSignatureWithoutMutation);
      const replayNeedsDifferentArtifact = replayWithoutProgress
        && missingRequestedArtifacts > 0
        && ['write_file', 'run_command'].includes(toolName);

      const protocolError = nativeToolInputProtocolError(toolName, input, language);
      if (protocolError) {
        correctiveFeedbackThisRound = true;
        lastFailure = protocolError;
        executedCalls.set(signature, { epoch: mutationEpoch, ok: false, output: protocolError });
        if (call.id) executedCallIds.add(call.id);
        options.onStatus?.(localizedText(language, `Ollama herstelt ongeldige ${toolName}-invoer`, `Ollama is repairing invalid ${toolName} input`));
        messages.push({
          role: 'tool',
          tool_name: toolName,
          content: JSON.stringify({
            ok: false,
            protocol_error: protocolError,
            instruction: localizedText(language, 'Corrigeer de function-call-invoer; deze actie is niet uitgevoerd.', 'Correct the function-call input; this action was not executed.'),
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
            error: localizedText(language, `De gebruiker vroeg ${requiredArtifactExtension}-bestanden; ${requestedPath} heeft een ander type.`, `The user requested ${requiredArtifactExtension} files; ${requestedPath} has a different type.`),
            retryable: true,
            instruction: localizedText(language, `Gebruik write_file met een pad dat eindigt op ${requiredArtifactExtension}. Maak geen README of alternatief document.`, `Use write_file with a path ending in ${requiredArtifactExtension}. Do not create a README or alternative document.`),
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
            error: localizedText(language, `Het gevraagde aantal bestanden (${requestedArtifactCount}) bestaat al: ${existing}.`, `The requested number of files (${requestedArtifactCount}) already exists: ${existing}.`),
            retryable: true,
            instruction: localizedText(language, 'Maak geen extra alternatief bestand. Valideer en voer de bestaande gevraagde bestanden uit.', 'Do not create an additional alternative file. Validate and run the existing requested files.'),
          }),
        });
        continue;
      }

      // Een gecachete read of een door de voortgangsgate geblokkeerde replay is
      // feedback aan het model, geen echte app-toolactie. Publiceer die daarom
      // niet als requested/result-event: anders toont de UI een rode mislukte
      // opdracht die in werkelijkheid nooit is uitgevoerd.
      const syntheticToolFeedback = cachedReadAfterEditFailure || replayWithoutProgress;
      if (!syntheticToolFeedback) {
        options.onToolActivity?.({
          provider: 'ollama',
          toolName,
          input,
          toolUseId,
          phase: 'requested',
        });
        options.onStatus?.(localizedText(language, `Ollama gebruikt ${toolName}`, `Ollama is using ${toolName}`));
      }

      let result: NativeToolExecutionResult;
      if (cachedReadAfterEditFailure) {
        correctiveFeedbackThisRound = true;
        lastFailedToolName = '';
        result = {
          ok: true,
          output: `${localizedText(language, '[gecachete herlezing; bestand is niet gewijzigd]', '[cached reread; file has not changed]')}\n${previous.output}`,
        };
      } else if (replayWithoutProgress) {
        correctiveFeedbackThisRound ||= replayNeedsDifferentArtifact;
        result = {
          ok: false,
          output: replayNeedsDifferentArtifact
            ? (language === 'nl' ? [
              '[niet opnieuw uitgevoerd: ander artefact vereist]',
              `De gebruiker vroeg ${requestedArtifactCount} artefacten; nog ${missingRequestedArtifacts} ontbreekt/ontbreken.`,
              `Herhaal ${toolName} niet voor een bestaand pad of commando.`,
              `Gebruik write_file met een ander${requiredArtifactExtension ? ` ${requiredArtifactExtension}` : ''}-pad voor het volgende artefact.`,
            ] : [
              '[not executed again: different artifact required]',
              `The user requested ${requestedArtifactCount} artifacts; ${missingRequestedArtifacts} are still missing.`,
              `Do not repeat ${toolName} for an existing path or command.`,
              `Use write_file with a different${requiredArtifactExtension ? ` ${requiredArtifactExtension}` : ''} path for the next artifact.`,
            ]).join(' ')
            : (language === 'nl' ? [
              '[niet opnieuw uitgevoerd: geen voortgang]',
              `Ollama vroeg dezelfde ${toolName}-actie opnieuw zonder relevante wijziging.`,
              previous?.ok ? 'De eerdere actie was al geslaagd.' : 'De eerdere actie was mislukt.',
              'Herstel of wijzig eerst de oorzaak, of rond eerlijk af.',
            ] : [
              '[not executed again: no progress]',
              `Ollama requested the same ${toolName} action again without a relevant change.`,
              previous?.ok ? 'The earlier action had already succeeded.' : 'The earlier action had failed.',
              'First repair or change the cause, or finish honestly.',
            ]).join(' '),
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
        if (result.ok) incompleteRetriesAtCurrentEpoch = 0;
        executedCalls.set(signature, {
          epoch: mutationEpoch,
          ok: result.ok,
          output: modelSafeToolOutput(result.output, language),
        });
        if (call.id) executedCallIds.add(call.id);
      }

      deniedThisRound ||= !!result.denied;
      if (!syntheticToolFeedback && !result.ok) {
        lastFailure = modelSafeToolOutput(result.output, language);
        lastFailedToolName = toolName;
      } else if (!syntheticToolFeedback && toolName !== 'read_file') {
        lastFailedToolName = '';
      }
      if (!syntheticToolFeedback) {
        options.onToolActivity?.({
          provider: 'ollama',
          toolName,
          input,
          toolUseId,
          phase: result.denied ? 'denied' : 'result',
          ok: result.ok,
          output: result.output,
        });
      }
      const feedback = nativeToolFeedback(result, replayWithoutProgress, language);
      if (replayNeedsDifferentArtifact) {
        feedback.retryable = true;
        feedback.instruction = localizedText(language,
          `Maak het volgende ontbrekende artefact met write_file op een ander${requiredArtifactExtension ? ` ${requiredArtifactExtension}` : ''}-pad.`,
          `Create the next missing artifact with write_file at a different${requiredArtifactExtension ? ` ${requiredArtifactExtension}` : ''} path.`);
      }
      const repairHint = ollamaToolRepairHint(toolName, result, language);
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
      terminationReason = localizedText(language, 'Een benodigde toolactie is door de gebruiker geweigerd', 'A required tool action was denied by the user');
      break;
    }
    if (stagnantRounds >= MAX_STAGNANT_ROUNDS) {
      terminationReason = localizedText(language, 'Ollama bleef identieke mislukte toolacties aanvragen zonder voortgang', 'Ollama kept requesting identical failed tool actions without progress');
      break;
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      terminationReason = localizedText(language, `De veiligheidsgrens van ${MAX_TOOL_ROUNDS} toolrondes is bereikt`, `The safety limit of ${MAX_TOOL_ROUNDS} tool rounds was reached`);
    }
  }

  if (options.signal.aborted) throw abortError(options.signal, language);
  let unresolvedCompletion = ollamaArtifactCompletionEvidence(
    requestedArtifactCount,
    requiresArtifactExecution,
    createdFiles,
    successfullyExecutedFiles,
  );
  // Een lokaal model kan precies in de laatste modelronde het laatste gevraagde
  // script schrijven. Laat dat expliciet gevraagde bestand dan niet onuitgevoerd
  // achter alleen omdat er geen dertiende model-toolronde meer beschikbaar is.
  // Dit is een deterministische vervolgstap voor reeds door write_file gemaakte,
  // bekende scripttypen en loopt nog steeds door dezelfde executor/approval-gate.
  if (
    options.requireToolUse
    && !unresolvedCompletion.missingCreatedArtifacts
    && unresolvedCompletion.missingExecutedFiles.length
  ) {
    for (const file of unresolvedCompletion.missingExecutedFiles) {
      const command = ollamaArtifactExecutionCommand(file);
      if (!command) continue;
      const toolUseId = `ollama-completion-${crypto.randomUUID()}`;
      const input = { command };
      options.onStatus?.(localizedText(language, `Ollama voert gevraagd bestand uit: ${file}`, `Ollama is running requested file: ${file}`));
      options.onToolActivity?.({ provider: 'ollama', toolName: 'run_command', input, toolUseId, phase: 'requested' });
      const result = await executeToolSafely(options, 'run_command', input, toolUseId);
      options.onToolActivity?.({
        provider: 'ollama',
        toolName: 'run_command',
        input,
        toolUseId,
        phase: result.denied ? 'denied' : 'result',
        ok: result.ok,
        output: result.output,
      });
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: toolUseId, function: { name: 'run_command', arguments: input } }],
      });
      messages.push({
        role: 'tool',
        tool_name: 'run_command',
        content: JSON.stringify(nativeToolFeedback(result, false, language)),
      });
      if (result.ok) recordSuccessfullyExecutedFiles(createdFiles, successfullyExecutedFiles, input);
      else {
        lastFailure = modelSafeToolOutput(result.output, language);
        if (result.denied) {
          terminationReason = localizedText(language, 'Een benodigde toolactie is door de gebruiker geweigerd', 'A required tool action was denied by the user');
          break;
        }
      }
    }
    unresolvedCompletion = ollamaArtifactCompletionEvidence(
      requestedArtifactCount,
      requiresArtifactExecution,
      createdFiles,
      successfullyExecutedFiles,
    );
  }
  const reason = terminationReason || localizedText(language, 'Ollama leverde geen afsluitend tekstantwoord', 'Ollama did not provide a final text answer');
  options.onStatus?.(localizedText(language, 'Ollama rondt af zonder extra tools', 'Ollama is finishing without additional tools'));
  appendRecoveryInstruction(messages, reason, lastFailure, language);
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
      ? (language === 'nl' ? [
        'De completion-gate is niet gehaald',
        unresolvedCompletion.missingCreatedArtifacts
          ? `${createdFiles.size}/${requestedArtifactCount} gevraagde artefacten gemaakt`
          : '',
        unresolvedCompletion.missingExecutedFiles.length
          ? `niet uitgevoerd: ${unresolvedCompletion.missingExecutedFiles.join(', ')}`
          : '',
      ] : [
        'The completion gate was not satisfied',
        unresolvedCompletion.missingCreatedArtifacts
          ? `${createdFiles.size}/${requestedArtifactCount} requested artifacts created`
          : '',
        unresolvedCompletion.missingExecutedFiles.length
          ? `not executed: ${unresolvedCompletion.missingExecutedFiles.join(', ')}`
          : '',
      ]).filter(Boolean).join('; ')
      : recovery.toolCalls.length
        ? localizedText(language, 'Ollama vroeg ondanks uitgeschakelde tools opnieuw een toolcall', 'Ollama requested another tool call even though tools were disabled')
        : recovery.doneReason
          ? localizedText(language, `Ollama stopte opnieuw zonder bruikbaar eindantwoord (${recovery.doneReason})`, `Ollama again stopped without a usable final answer (${recovery.doneReason})`)
          : localizedText(language, 'Ollama gaf opnieuw een lege respons', 'Ollama again returned an empty response');
  } catch (error) {
    if (options.signal.aborted) throw abortError(options.signal, language);
    recoveryError = error instanceof Error ? error.message : String(error);
  }

  const fallback = buildRecoveryFallback(reason, lastFailure, recoveryError, language);
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
  const extensions = requestedArtifactExtensions(messages);
  return extensions.length === 1 ? extensions[0] : '';
}

export function requestedArtifactExtensions(messages: OllamaMessage[]) {
  const request = [...messages].reverse().find((message) => message.role === 'user')?.content.toLocaleLowerCase() || '';
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:python(?:-|\s*)scripts?|pythonbestanden?|python\s+programs?)\b/i, '.py'],
    [/\b(?:javascript|node(?:\.js)?)(?:-|\s*)scripts?\b/i, '.js'],
    [/\b(?:powershell|pwsh)(?:-|\s*)scripts?\b/i, '.ps1'],
    [/\b(?:batch|cmd)(?:-|\s*)scripts?\b/i, '.cmd'],
  ];
  return candidates.filter(([pattern]) => pattern.test(request)).map(([, extension]) => extension);
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

function ollamaToolRepairHint(toolName: string, result: NativeToolExecutionResult, language: UiLanguage = 'nl') {
  if (result.ok || result.denied) return '';
  const output = String(result.output || '');
  if (toolName === 'read_file' && /ENOENT|niet gevonden|does not exist/i.test(output)) {
    return localizedText(language, 'Dit bestand bestaat niet. Als de gebruiker een nieuw bestand vroeg, gebruik write_file; herhaal read_file niet.', 'This file does not exist. If the user requested a new file, use write_file; do not repeat read_file.');
  }
  if (toolName === 'edit_file' && /old_text niet gevonden|geen wijziging/i.test(output)) {
    return localizedText(language, 'Lees het actuele bestand met read_file en maak daarna een nieuwe edit_file-call met exact aanwezige old_text.', 'Read the current file with read_file, then make a new edit_file call with old_text that is present exactly.');
  }
  if (toolName === 'run_command') {
    if (/ENOENT|not recognized|wordt niet herkend|cannot find|kan het opgegeven bestand niet vinden/i.test(output)) {
      return localizedText(language, 'De gekozen executable of shell bestaat niet. Laat shell weg voor de ingestelde standaardshell en gebruik op Windows eenvoudige PowerShell- of cmd-commando’s zonder Unix-hulpprogramma’s.', 'The selected executable or shell does not exist. Omit shell to use the configured default shell, and on Windows use simple PowerShell or cmd commands without Unix utilities.');
    }
    if (/Unexpected token.*&&|The token ['"]&&['"] is not a valid statement separator/i.test(output)) {
      return localizedText(language, 'PowerShell 5 ondersteunt && niet. Gebruik aparte run_command-calls of een PowerShell if-blok.', 'PowerShell 5 does not support &&. Use separate run_command calls or a PowerShell if block.');
    }
    return localizedText(language, 'Lees de fout, wijzig eerst het relevante bestand en voer pas daarna het commando opnieuw uit.', 'Read the error, modify the relevant file first, and only then run the command again.');
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
        ...(allowTools ? { tools: ollamaNativeTools(options.language || 'nl') } : {}),
        options: {
          temperature: 0,
          num_predict: OLLAMA_NATIVE_MAX_PREDICT,
        },
      }),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || localizedText(options.language || 'nl', `Ollama native tools faalden met HTTP ${response.status}.`, `Ollama native tools failed with HTTP ${response.status}.`));
  }
  if (!response.body) throw new Error(localizedText(options.language || 'nl', 'Ollama gaf geen native tool-stream terug.', 'Ollama did not return a native tool stream.'));

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

  if (!done) throw new Error(localizedText(options.language || 'nl', 'Ollama-stream eindigde zonder een volledige done-respons.', 'The Ollama stream ended without a complete done response.'));

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
      output: localizedText(options.language || 'nl', `[tool-uitvoering mislukt] ${error instanceof Error ? error.message : String(error)}`, `[tool execution failed] ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

function addOllamaToolGuidance(messages: OllamaMessage[], language: UiLanguage) {
  const guidance = localizedText(language, OLLAMA_NATIVE_TOOL_GUIDANCE_NL, OLLAMA_NATIVE_TOOL_GUIDANCE_EN);
  const system = messages.find((message) => message.role === 'system');
  if (system) system.content = joinNativeText(system.content, guidance);
  else messages.unshift({ role: 'system', content: guidance });
}

function appendRecoveryInstruction(messages: OllamaMessage[], reason: string, lastFailure: string, language: UiLanguage) {
  messages.push({
    role: 'user',
    content: (language === 'nl' ? [
      '[LLMelt heeft verdere toolcalls uitgeschakeld.]',
      `${reason}.`,
      lastFailure ? `Laatste toolfout:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
      'Geef nu zonder tools een beknopt, eerlijk eindantwoord. Noem alleen werkelijk voltooide acties als voltooid.',
    ] : [
      '[LLMelt has disabled further tool calls.]',
      `${reason}.`,
      lastFailure ? `Last tool error:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
      'Now provide a concise, honest final answer without tools. Only describe actions as completed when they actually completed.',
    ]).filter(Boolean).join('\n\n'),
  });
}

function buildRecoveryFallback(reason: string, lastFailure: string, recoveryError: string, language: UiLanguage) {
  return (language === 'nl' ? [
    `Ollama kon de tooltaak niet volledig afronden: ${reason}.`,
    lastFailure ? `Laatste toolfout:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
    recoveryError ? `Ook het verplichte eindantwoord mislukte: ${clipNativeToolDetail(recoveryError, 12_000, language)}.` : '',
    'Reeds getoonde toolkaarten blijven de gezaghebbende uitvoer; niet-uitgevoerde stappen zijn niet als voltooid gemarkeerd.',
  ] : [
    `Ollama could not fully complete the tool task: ${reason}.`,
    lastFailure ? `Last tool error:\n${clipNativeToolDetail(lastFailure, 12_000, language)}` : '',
    recoveryError ? `The required final answer also failed: ${clipNativeToolDetail(recoveryError, 12_000, language)}.` : '',
    'The tool cards already shown remain the authoritative output; unexecuted steps are not marked as completed.',
  ]).filter(Boolean).join('\n\n');
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

function abortError(signal: AbortSignal, language: UiLanguage = 'nl') {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(localizedText(language, 'Ollama-beurt afgebroken.', 'Ollama turn aborted.'), 'AbortError');
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
