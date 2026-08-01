import type { AutoModeConfig, AutoModePhase, AutoModeState } from '../providers/types';

export function validateAutoModeConfig(config: AutoModeConfig) {
  if (!config || typeof config.chatId !== 'string' || !config.chatId.trim()) throw new Error('Auto Mode vereist een chatId.');
  if (!config.prompterModelRef || !config.responderModelRef) throw new Error('Auto Mode vereist twee modellen.');
  if (!Number.isFinite(config.maxIterations) || config.maxIterations < 0 || config.maxIterations > 1_000) {
    throw new Error('Auto Mode-iteraties moeten 0 (oneindig) of 1 t/m 1000 zijn.');
  }
  if (!Number.isFinite(config.delayMs) || config.delayMs < 1_000 || config.delayMs > 60_000) {
    throw new Error('Auto Mode-vertraging moet tussen 1 en 60 seconden liggen.');
  }
  if (config.tokenBudget != null && (!Number.isFinite(config.tokenBudget) || config.tokenBudget <= 0)) {
    throw new Error('Auto Mode-tokenbudget moet groter dan 0 zijn.');
  }
  if ((config.goal || '').length > 20_000) throw new Error('Het Auto Mode-doel is langer dan 20.000 tekens.');
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

export function autoModePhaseInfo(phase: AutoModePhase) {
  const info: Record<AutoModePhase, { label: string; title: string; description: string; busy: boolean }> = {
    idle: { label: 'Gereed', title: 'Auto Mode is gereed', description: 'Kies twee modellen en start een run.', busy: false },
    starting: { label: 'Starten', title: 'Auto Mode wordt gestart', description: 'De eerste ronde wordt voorbereid.', busy: true },
    prompter: { label: 'Prompt maken', title: 'De prompter maakt nu een prompt', description: 'De volgende gebruikersprompt wordt opgebouwd.', busy: true },
    responder: { label: 'Antwoord maken', title: 'Het antwoordmodel reageert nu', description: 'De gemaakte prompt wordt door het antwoordmodel verwerkt.', busy: true },
    waiting: { label: 'Wachten', title: 'Ronde afgerond', description: 'Auto Mode wacht op de volgende ronde.', busy: true },
    paused: { label: 'Gepauzeerd', title: 'Auto Mode is gepauzeerd', description: 'Hervat om verder te gaan.', busy: false },
    completed: { label: 'Klaar', title: 'Auto Mode is klaar', description: 'Alle ingestelde rondes zijn afgerond.', busy: false },
    stopped: { label: 'Gestopt', title: 'Auto Mode is gestopt', description: 'Start opnieuw wanneer je verder wilt.', busy: false },
    error: { label: 'Fout', title: 'Auto Mode is gestopt door een fout', description: 'Bekijk de fout hieronder.', busy: false },
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
