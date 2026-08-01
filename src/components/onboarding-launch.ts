export const ONBOARDING_LAUNCH_EVENT = 'ai-superapp:launch-onboarding';

/** Zet de opstartgids opnieuw aan (knop in Instellingen). */
export function requestOnboarding() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ONBOARDING_LAUNCH_EVENT));
}

/** Sleutels in de settings-store. `completedAt` bepaalt of de gids bij het opstarten komt. */
export const ONBOARDING_DONE_KEY = 'onboarding.completedAt';
export const ONBOARDING_SERVICES_KEY = 'onboarding.services';

export type ServiceAnswer = 'yes' | 'no' | 'maybe';
