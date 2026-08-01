import { safeStorage } from 'electron';
import type { CredentialMethod, CredentialStatus, ProviderType } from '../src/providers/types';
import { getStore } from './settings-store';

interface StoredCredential {
  method: CredentialMethod;
  encrypted: boolean;
  value: string;
  label?: string;
  updatedAt: string;
}

const PROVIDERS: ProviderType[] = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'codex',
  'antigravity',
  'remote',
];

function maskSecret(value: string) {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function encryptSecret(value: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows veilige opslag is niet beschikbaar; de API-key is niet opgeslagen.');
  }
  return {
    encrypted: true,
    value: safeStorage.encryptString(value).toString('base64'),
  };
}

function decryptSecret(credential?: StoredCredential | null) {
  if (!credential) return null;
  if (!credential.encrypted) return credential.value;

  try {
    return safeStorage.decryptString(Buffer.from(credential.value, 'base64'));
  } catch {
    return null;
  }
}

export async function saveCredential(
  provider: ProviderType,
  secret: string,
  method: CredentialMethod = 'apikey',
) {
  const store = await getStore();
  const encrypted = encryptSecret(secret);
  const credential: StoredCredential = {
    method,
    encrypted: encrypted.encrypted,
    value: encrypted.value,
    label: maskSecret(secret),
    updatedAt: new Date().toISOString(),
  };

  store.set(`credentials.${provider}`, credential);
  store.delete(`keys.${provider}`);
  return credential;
}

export async function getCredential(provider: ProviderType) {
  const store = await getStore();
  const credential = store.get(`credentials.${provider}`) as StoredCredential | undefined;
  const legacyKey = store.get(`keys.${provider}`) as string | undefined;

  if (credential) {
    if (!credential.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        store.delete(`credentials.${provider}`);
        return { method: 'none' as const, value: null };
      }
      await saveCredential(provider, credential.value, credential.method);
      return getCredential(provider);
    }
    return {
      method: credential.method,
      label: credential.label,
      value: decryptSecret(credential),
    };
  }

  if (legacyKey) {
    await saveCredential(
      provider,
      legacyKey.startsWith('session_') ? legacyKey.replace(/^session_/, '') : legacyKey,
      legacyKey.startsWith('session_') ? 'session' : 'apikey',
    );
    return getCredential(provider);
  }

  return {
    method: provider === 'ollama' || provider === 'codex' ? 'cli' : 'none',
    value: null,
  } as const;
}

export async function removeCredential(provider: ProviderType) {
  const store = await getStore();
  store.delete(`credentials.${provider}`);
  store.delete(`keys.${provider}`);
  return true;
}

export async function getCredentialStatuses(): Promise<Record<ProviderType, CredentialStatus>> {
  const store = await getStore();
  const credentials = (store.get('credentials') || {}) as Record<string, StoredCredential>;
  const legacyKeys = (store.get('keys') || {}) as Record<string, string>;

  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const stored = credentials[provider];
      const legacy = legacyKeys[provider];
      const isLocal = provider === 'ollama' || provider === 'codex' || provider === 'antigravity';
      const isDisabledSession = stored?.method === 'session' || legacy?.startsWith('session_');
      const method = stored?.method || (legacy ? 'apikey' : isLocal ? 'cli' : 'none');

      return [
        provider,
        {
          provider,
          authenticated: isLocal || (!!stored || !!legacy) && !isDisabledSession,
          method,
          label: stored?.label || (legacy ? maskSecret(legacy) : undefined),
          error: isDisabledSession ? 'Browser session login is disabled in stable v1. Use an API key.' : undefined,
        },
      ];
    }),
  ) as Record<ProviderType, CredentialStatus>;
}
