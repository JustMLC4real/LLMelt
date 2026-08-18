export const LANGUAGE_FADE_OUT_MS = 120;
export const LANGUAGE_FADE_IN_MS = 180;

type TransitionClassList = Pick<DOMTokenList, 'add' | 'remove'>;

export interface LanguageTransitionEnvironment {
  classList: TransitionClassList | null;
  reducedMotion: boolean;
  startViewTransition?: (update: () => Promise<void>) => { finished: Promise<unknown> };
  nextFrame: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}

const TRANSITION_CLASSES = [
  'language-transition-active',
  'language-transition-fallback-out',
  'language-transition-fallback-in',
];

function clearTransitionClasses(classList: TransitionClassList | null) {
  classList?.remove(...TRANSITION_CLASSES);
}

/** Wisselt de volledige renderer als één rustige fade om. */
export async function runLanguageTransition(
  updateLanguage: () => Promise<void>,
  environment: LanguageTransitionEnvironment = browserLanguageTransitionEnvironment(),
) {
  const { classList } = environment;
  if (!classList || environment.reducedMotion) {
    await updateLanguage();
    return;
  }

  clearTransitionClasses(classList);
  classList.add('language-transition-active');

  try {
    if (environment.startViewTransition) {
      let updateStarted = false;
      try {
        const transition = environment.startViewTransition(async () => {
          updateStarted = true;
          await updateLanguage();
        });
        await transition.finished;
        return;
      } catch (error) {
        // Chromium kan een view transition weigeren wanneer er exact tegelijk al
        // één loopt. Alleen als de update nog niet begon, gebruiken we de fallback.
        if (updateStarted) throw error;
      }
    }

    classList.add('language-transition-fallback-out');
    await environment.nextFrame();
    await environment.nextFrame();
    await environment.wait(LANGUAGE_FADE_OUT_MS);
    await updateLanguage();
    classList.remove('language-transition-fallback-out');
    classList.add('language-transition-fallback-in');
    await environment.nextFrame();
    await environment.wait(LANGUAGE_FADE_IN_MS);
  } finally {
    clearTransitionClasses(classList);
  }
}

function browserLanguageTransitionEnvironment(): LanguageTransitionEnvironment {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return {
      classList: null,
      reducedMotion: true,
      nextFrame: async () => {},
      wait: async () => {},
    };
  }

  return {
    classList: document.documentElement.classList,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    startViewTransition: typeof document.startViewTransition === 'function'
      ? (update) => document.startViewTransition(update)
      : undefined,
    nextFrame: () => new Promise((resolve) => window.requestAnimationFrame(() => resolve())),
    wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  };
}
