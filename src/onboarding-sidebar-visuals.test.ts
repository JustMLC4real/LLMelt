import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const onboarding = readFileSync(new URL('./components/OnboardingGuide.tsx', import.meta.url), 'utf8');

function cssRule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`CSS-regel ontbreekt: ${selector}`);
  return match[1];
}

describe('visuele onboarding- en projectcontracten', () => {
  it('animeert ieder nieuw onboardingstadium en respecteert reduced motion', () => {
    const stepRule = cssRule('.onboarding-step');
    expect(stepRule).toContain('animation: onboarding-step-enter');
    expect(css).toContain('@keyframes onboarding-step-enter');
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]+\.onboarding-step[\s\S]+animation:\s*none/);

    for (const step of ['welcome', 'what', 'scanning', 'confirm', 'missing', 'runtime', 'ready', 'done']) {
      expect(onboarding).toContain(`key="${step}"`);
    }
    expect(onboarding).toContain('key={`setup-${currentSetup.provider}-${setupIndex}`}');
  });

  it('houdt de actieve dichtgeklapte projectkop neutraal', () => {
    const activeFolderRule = cssRule('.folder-item.active');
    expect(activeFolderRule).toContain('background: var(--glass-bg)');
    expect(activeFolderRule).toContain('border: 1px solid var(--glass-border)');
    expect(activeFolderRule).not.toContain('accent-cyan');
    expect(activeFolderRule).not.toContain('box-shadow');
  });
});
