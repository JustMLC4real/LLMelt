import type { AutoModeConfig, AutoModePhase, AutoModeState, UiLanguage } from '../providers/types';
import { localizedText } from '../i18n/language';

export type AutoModePrompterDecision =
  | { status: 'continue'; prompt: string }
  | { status: 'complete'; summary?: string };

const AUTO_MODE_NEXT_PATTERN = /<AUTO_MODE_NEXT>([\s\S]*?)<\/AUTO_MODE_NEXT>/i;
const AUTO_MODE_COMPLETE_PATTERN = /<AUTO_MODE_COMPLETE>([\s\S]*?)<\/AUTO_MODE_COMPLETE>/i;

/**
 * Bouwt één providerneutraal contract voor iedere prompter-adapter. De tags zijn
 * bewust eenvoudiger dan JSON: ook kleinere lokale modellen kunnen ze betrouwbaar
 * produceren en tekst in de volgende prompt hoeft niet JSON-geescaped te worden.
 */
export function buildAutoModePrompterSystemPrompt(goal: string, language: UiLanguage = 'nl') {
  const cleanGoal = goal.trim();
  if (!cleanGoal) {
    return localizedText(
      language,
      'Genereer de volgende nuttige gebruikersprompt voor dit gesprek. Geef alleen de prompttekst terug.',
      'Generate the next useful user prompt for this conversation. Return only the prompt text.',
    );
  }

  return localizedText(
    language,
    `Je stuurt dit gesprek naar het doel van de gebruiker hieronder. Beoordeel het volledige gesprek, inclusief het meest recente antwoord. Als alle gevraagde resultaten werkelijk zijn geleverd en het doel voltooid is, antwoord dan uitsluitend met <AUTO_MODE_COMPLETE>een korte reden</AUTO_MODE_COMPLETE>. Als er nog werk nodig is, antwoord dan uitsluitend met <AUTO_MODE_NEXT>precies het volgende concrete gebruikersbericht</AUTO_MODE_NEXT>. Markeer het doel niet als voltooid alleen omdat een antwoord beweert dat het klaar is; controleer of de gevraagde resultaten zichtbaar aanwezig zijn.\n\n<USER_GOAL>\n${cleanGoal}\n</USER_GOAL>`,
    `You are driving this conversation toward the user's goal below. Evaluate the entire conversation, including the most recent response. If every requested result has actually been delivered and the goal is complete, reply only with <AUTO_MODE_COMPLETE>a short reason</AUTO_MODE_COMPLETE>. If work remains, reply only with <AUTO_MODE_NEXT>the exact next concrete user message</AUTO_MODE_NEXT>. Do not mark the goal complete merely because a response claims it is done; verify that the requested results are visibly present.\n\n<USER_GOAL>\n${cleanGoal}\n</USER_GOAL>`,
  );
}

/**
 * Alleen een volledig gesloten contracttag mag de run stoppen. Vrije tekst met
 * woorden als "klaar" of "complete" blijft voor oudere/minder gehoorzame modellen
 * een gewone volgende prompt en kan dus nooit per ongeluk Auto Mode beëindigen.
 */
export function parseAutoModePrompterDecision(value: string): AutoModePrompterDecision {
  const text = value.trim();
  const nextMatch = AUTO_MODE_NEXT_PATTERN.exec(text);
  const completeMatch = AUTO_MODE_COMPLETE_PATTERN.exec(text);
  const firstMatch = [
    nextMatch && { kind: 'continue' as const, index: nextMatch.index, value: nextMatch[1].trim() },
    completeMatch && { kind: 'complete' as const, index: completeMatch.index, value: completeMatch[1].trim() },
  ]
    .filter((match): match is NonNullable<typeof match> => Boolean(match))
    .sort((left, right) => left.index - right.index)[0];

  if (firstMatch?.kind === 'complete') {
    return { status: 'complete', summary: firstMatch.value || undefined };
  }
  if (firstMatch?.kind === 'continue' && firstMatch.value) {
    return { status: 'continue', prompt: firstMatch.value };
  }
  return { status: 'continue', prompt: text };
}

export function validateAutoModeConfig(config: AutoModeConfig) {
  const text = (nl: string, en: string) => localizedText(config?.language || 'nl', nl, en);
  if (!config || typeof config.chatId !== 'string' || !config.chatId.trim()) throw new Error(text('Auto Mode vereist een chatId.', 'Auto Mode requires a chatId.'));
  if (!config.prompterModelRef || !config.responderModelRef) throw new Error(text('Auto Mode vereist twee modellen.', 'Auto Mode requires two models.'));
  if (!Number.isFinite(config.maxIterations) || config.maxIterations < 0 || config.maxIterations > 1_000) {
    throw new Error(text('Auto Mode-iteraties moeten 0 (oneindig) of 1 t/m 1000 zijn.', 'Auto Mode iterations must be 0 (unlimited) or between 1 and 1000.'));
  }
  if (!Number.isFinite(config.delayMs) || config.delayMs < 1_000 || config.delayMs > 60_000) {
    throw new Error(text('Auto Mode-vertraging moet tussen 1 en 60 seconden liggen.', 'The Auto Mode delay must be between 1 and 60 seconds.'));
  }
  if (config.tokenBudget != null && (!Number.isFinite(config.tokenBudget) || config.tokenBudget <= 0)) {
    throw new Error(text('Auto Mode-tokenbudget moet groter dan 0 zijn.', 'The Auto Mode token budget must be greater than 0.'));
  }
  if ((config.goal || '').length > 20_000) throw new Error(text('Het Auto Mode-doel is langer dan 20.000 tekens.', 'The Auto Mode goal is longer than 20,000 characters.'));
}

export function mergeAutoModeState(
  current: AutoModeState,
  patch: Partial<AutoModeState>,
  now = () => new Date().toISOString(),
): AutoModeState {
  const phaseChanged = patch.phase !== undefined && patch.phase !== current.phase;
  return {
    ...current,
    ...patch,
    ...(phaseChanged ? { phaseStartedAt: now() } : {}),
  };
}

export function autoModePromptPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 600);
}

export function autoModePhaseInfo(phase: AutoModePhase, language: UiLanguage = 'nl') {
  const text = (nl: string, en: string) => localizedText(language, nl, en);
  const info: Record<AutoModePhase, { label: string; title: string; description: string; busy: boolean }> = {
    idle: { label: text('Gereed', 'Ready'), title: text('Auto Mode is gereed', 'Auto Mode is ready'), description: text('Kies twee modellen en start een run.', 'Choose two models and start a run.'), busy: false },
    starting: { label: text('Starten', 'Starting'), title: text('Auto Mode wordt gestart', 'Auto Mode is starting'), description: text('De eerste ronde wordt voorbereid.', 'The first round is being prepared.'), busy: true },
    prompter: { label: text('Prompt maken', 'Creating prompt'), title: text('De prompter maakt nu een prompt', 'The prompter is creating a prompt'), description: text('De volgende gebruikersprompt wordt opgebouwd.', 'The next user prompt is being created.'), busy: true },
    responder: { label: text('Antwoord maken', 'Creating answer'), title: text('Het antwoordmodel reageert nu', 'The response model is answering'), description: text('De gemaakte prompt wordt door het antwoordmodel verwerkt.', 'The response model is processing the generated prompt.'), busy: true },
    waiting: { label: text('Wachten', 'Waiting'), title: text('Ronde afgerond', 'Round completed'), description: text('Auto Mode wacht op de volgende ronde.', 'Auto Mode is waiting for the next round.'), busy: true },
    paused: { label: text('Gepauzeerd', 'Paused'), title: text('Auto Mode is gepauzeerd', 'Auto Mode is paused'), description: text('Hervat om verder te gaan.', 'Resume to continue.'), busy: false },
    completed: { label: text('Klaar', 'Done'), title: text('Auto Mode is klaar', 'Auto Mode is complete'), description: text('Alle ingestelde rondes zijn afgerond.', 'All configured rounds are complete.'), busy: false },
    stopped: { label: text('Gestopt', 'Stopped'), title: text('Auto Mode is gestopt', 'Auto Mode has stopped'), description: text('Start opnieuw wanneer je verder wilt.', 'Start again when you want to continue.'), busy: false },
    error: { label: text('Fout', 'Error'), title: text('Auto Mode is gestopt door een fout', 'Auto Mode stopped because of an error'), description: text('Bekijk de fout hieronder.', 'Review the error below.'), busy: false },
  };
  return info[phase];
}

export function autoModeStepState(phase: AutoModePhase, index: number) {
  if (phase === 'error') return 'error';
  const activeIndex = phase === 'prompter' ? 0 : phase === 'responder' ? 1 : phase === 'waiting' ? 2 : -1;
  if (phase === 'completed') return 'done';
  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'pending';
}
