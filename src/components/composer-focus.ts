export const COMPOSER_FOCUS_EVENT = 'ai-superapp:focus-composer';

export function requestComposerFocus() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
}
