import { useEffect, useState } from 'react';

export type PanelPresencePhase = 'entering' | 'entered' | 'leaving';

/** Houdt een paneel tijdens de bestaande CSS-uittransitie nog kort gemount. */
export function usePanelPresence(visible: boolean, durationMs = 250) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<PanelPresencePhase>(visible ? 'entered' : 'leaving');

  useEffect(() => {
    let timer = 0;
    if (visible) {
      setMounted(true);
      setPhase('entered');
    } else {
      setPhase('leaving');
      timer = window.setTimeout(() => setMounted(false), durationMs);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [durationMs, visible]);

  return { mounted, phase };
}
