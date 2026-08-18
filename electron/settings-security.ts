export function boundedString(value: unknown, maxLength: number, label: string) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} moet tekst zijn.`);
  if (value.length > maxLength) throw new Error(`${label} is te lang.`);
  return value;
}

export function sanitizeRendererSettingValue(key: string, value: unknown) {
  if (key === 'ui.language') return value === 'en' ? 'en' : 'nl';
  if (key === 'profile.avatarDataUrl') {
    if (value === null || value === '') return null;
    const avatar = boundedString(value, 5_000_000, 'Profielfoto');
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(avatar)) throw new Error('Profielfoto moet een ondersteunde data-URL zijn.');
    return avatar;
  }
  if (key === 'onboarding.completedAt') return boundedString(value, 100, 'Onboardingdatum');
  if (key === 'onboarding.services') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Onboardingservices zijn ongeldig.');
    if (JSON.stringify(value).length > 50_000) throw new Error('Onboardingservices zijn te groot.');
    return value;
  }
  if (key === 'ollama.url') {
    const raw = boundedString(value, 2_048, 'Ollama-URL').trim();
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('Ollama-URL is ongeldig.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Ollama-URL moet http of https gebruiken.');
    return url.toString().replace(/\/$/, '');
  }
  if (key === 'codex.timeoutSeconds') {
    const timeout = Number(value);
    if (!Number.isFinite(timeout)) throw new Error('Codex-timeout is ongeldig.');
    return Math.min(3_600, Math.max(30, Math.round(timeout)));
  }
  if (key === 'antigravity.models') {
    if (!Array.isArray(value) || value.length > 200) throw new Error('Antigravity-modellen zijn ongeldig.');
    return value.map((item) => boundedString(item, 500, 'Antigravity-model').trim()).filter(Boolean);
  }
  if (key === 'chat.autoTitleMode') {
    const mode = boundedString(value, 20, 'Automatische titelmodus');
    if (!['ollama', 'simple', 'off'].includes(mode)) throw new Error('Automatische titelmodus is ongeldig.');
    return mode;
  }
  const limits: Record<string, number> = {
    'codex.executable': 32_768,
    'claude.executable': 32_768,
    'antigravity.executable': 32_768,
    'antigravity.statusJsonPath': 32_768,
  };
  return boundedString(value, limits[key] || 2_048, 'Instelling');
}

export function buildRendererSettingsSnapshot(get: (key: string) => unknown) {
  const ssh = (get('sshConfig') || {}) as Record<string, unknown>;
  return {
    profile: { avatarDataUrl: get('profile.avatarDataUrl') ?? null },
    ollama: { url: get('ollama.url') },
    chat: {
      autoTitleMode: ['simple', 'off'].includes(String(get('chat.autoTitleMode')))
        ? get('chat.autoTitleMode')
        : 'ollama',
    },
    codex: {
      executable: get('codex.executable'),
      timeoutSeconds: get('codex.timeoutSeconds'),
    },
    claude: {
      executable: get('claude.executable'),
    },
    antigravity: {
      executable: get('antigravity.executable'),
      models: get('antigravity.models'),
      statusJsonPath: get('antigravity.statusJsonPath'),
    },
    sshConfig: {
      host: typeof ssh.host === 'string' ? ssh.host : '',
      port: typeof ssh.port === 'string' || typeof ssh.port === 'number' ? String(ssh.port) : '22',
      user: typeof ssh.user === 'string' ? ssh.user : '',
    },
  };
}
