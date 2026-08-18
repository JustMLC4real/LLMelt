import type { AutoModeConfig, AutoModePhase, AutoModeState, UiLanguage } from '../providers/types';
import { localizedText } from '../i18n/language';

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
