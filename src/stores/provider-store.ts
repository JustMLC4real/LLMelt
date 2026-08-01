import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AIModel, AutoModePhase, AutoModeState, ChatgptVersion, ProviderAccountId, ProviderAccountStatus, ProviderQuotaSnapshot, ProviderType, TokenUsage, FallbackConfig, AutoModeStatus, CredentialStatus } from '../providers/types';

interface ProviderState {
  // Models
  models: AIModel[];
  modelsByProvider: Record<ProviderType, AIModel[]>;
  isRefreshingModels: boolean;
  // ChatGPT's eigen modelkiezer (Model + Intelligentie), rechtstreeks van de website.
  chatgptVersions: ChatgptVersion[];
  // Is de ChatGPT-websessie echt actief? `undefined` = nog niet gecontroleerd.
  // De modellenlijst mag hier niet voor dienen: die wordt bewaard als laatst-bekend-goed
  // en blijft dus gevuld nadat je uitlogt.
  chatgptSessionActive?: boolean;

  // Provider health
  providerHealth: Record<ProviderType, 'online' | 'offline' | 'limited'>;
  
  // Auth status
  authStatus: Record<ProviderType, CredentialStatus>;
  accountStatuses: Partial<Record<ProviderAccountId, ProviderAccountStatus>>;
  
  // Token usage per model
  tokenUsage: Record<string, TokenUsage>;
  quotaSnapshots: ProviderQuotaSnapshot[];

  // Fallback
  fallbackConfig: FallbackConfig;

  // Auto mode
  autoModeStatus: AutoModeStatus;
  autoModeChatId: string | null;
  autoModeIteration: number;
  autoModeTotalTokens: number;
  autoModeMaxIterations: number;
  autoModeDetail: string;
  autoModePhase: AutoModePhase;
  autoModeLastPromptPreview: string;
  autoModeError: string;
  
  // Rate limit cooldowns
  cooldowns: Record<string, {
    resetAt: string;
    remaining: number;
    total: number;
  }>;
  
  // Preferred auth method per provider
  preferredAuthMethod: Partial<Record<ProviderType, import('../providers/types').AuthMethod>>;
  
  // Actions
  setModels: (models: AIModel[]) => void;
  setProviderModels: (provider: ProviderType, models: AIModel[], preserveExistingOnEmpty?: boolean) => void;
  setChatgptVersions: (versions: ChatgptVersion[]) => void;
  setChatgptSessionActive: (active: boolean) => void;
  setRefreshingModels: (value: boolean) => void;
  setProviderHealth: (provider: ProviderType, health: 'online' | 'offline' | 'limited') => void;
  setAuthStatus: (provider: ProviderType, status: CredentialStatus) => void;
  setAccountStatuses: (statuses: ProviderAccountStatus[]) => void;
  setTokenUsage: (modelId: string, usage: TokenUsage) => void;
  setQuotaSnapshots: (snapshots: ProviderQuotaSnapshot[]) => void;
  setFallbackConfig: (config: FallbackConfig) => void;
  setAutoModeStatus: (status: AutoModeStatus) => void;
  setAutoModeChatId: (chatId: string | null) => void;
  setAutoModeIteration: (iteration: number) => void;
  setAutoModeTotalTokens: (tokens: number) => void;
  setAutoModeDetail: (detail: string) => void;
  setAutoModeState: (state: AutoModeState) => void;
  setCooldown: (modelId: string, cooldown: { resetAt: string; remaining: number; total: number }) => void;
  removeCooldown: (modelId: string) => void;
  setPreferredAuthMethod: (provider: ProviderType, method: import('../providers/types').AuthMethod) => void;
}

const PROVIDER_ORDER: ProviderType[] = ['codex', 'openai', 'anthropic', 'google', 'antigravity', 'ollama', 'remote'];

export const useProviderStore = create<ProviderState>()(persist((set) => ({
  models: [],
  modelsByProvider: {
    openai: [],
    anthropic: [],
    google: [],
    ollama: [],
    codex: [],
    antigravity: [],
    remote: [],
  },
  isRefreshingModels: false,

  providerHealth: {
    openai: 'offline',
    anthropic: 'offline',
    google: 'offline',
    ollama: 'offline',
    codex: 'offline',
    antigravity: 'offline',
    remote: 'offline',
  },
  
  authStatus: {
    openai: { provider: 'openai', authenticated: false, method: 'none', statusLabel: 'API key of browser login nodig', category: 'api', canChat: false },
    anthropic: { provider: 'anthropic', authenticated: false, method: 'none', statusLabel: 'API key of Claude CLI nodig', category: 'api', canChat: false },
    google: { provider: 'google', authenticated: false, method: 'none', statusLabel: 'Gemini API-key nodig', category: 'api', canChat: false },
    ollama: { provider: 'ollama', authenticated: false, method: 'none', statusLabel: 'Ollama offline', category: 'local', canChat: false },
    codex: { provider: 'codex', authenticated: false, method: 'cli', statusLabel: 'CLI auth nodig', category: 'agent', canChat: false },
    antigravity: { provider: 'antigravity', authenticated: false, method: 'cli', statusLabel: 'CLI niet gevonden', category: 'agent', canChat: false },
    remote: { provider: 'remote', authenticated: false, method: 'manual', statusLabel: 'SSH niet ingesteld', category: 'local', canChat: false },
  },

  accountStatuses: {},
  
  tokenUsage: {},
  quotaSnapshots: [],
  
  fallbackConfig: {
    order: [],
    autoSwitchEnabled: false,
    autoSwitchConfirmed: false,
  },

  autoModeStatus: 'idle',
  autoModeChatId: null,
  autoModeIteration: 0,
  autoModeTotalTokens: 0,
  autoModeMaxIterations: 0,
  autoModeDetail: '',
  autoModePhase: 'idle',
  autoModeLastPromptPreview: '',
  autoModeError: '',
  
  cooldowns: {},

  preferredAuthMethod: {},
  chatgptVersions: [],
  
  // Actions
  setChatgptVersions: (versions) => set({ chatgptVersions: versions }),
  setChatgptSessionActive: (active) => set({ chatgptSessionActive: active }),
  setModels: (models) => {
    const byProvider: Record<ProviderType, AIModel[]> = {
      openai: [], anthropic: [], google: [], ollama: [],
      codex: [], antigravity: [], remote: [],
    };
    models.forEach(m => {
      if (byProvider[m.provider]) {
        byProvider[m.provider].push(m);
      }
    });
    set({ models, modelsByProvider: byProvider });
  },
  setProviderModels: (provider, models, preserveExistingOnEmpty = true) => set((state) => {
    if (preserveExistingOnEmpty && models.length === 0 && state.modelsByProvider[provider].length > 0) {
      return state;
    }
    const modelsByProvider = { ...state.modelsByProvider, [provider]: models };
    return {
      modelsByProvider,
      models: PROVIDER_ORDER.flatMap((id) => modelsByProvider[id] || []),
    };
  }),
  setRefreshingModels: (value) => set({ isRefreshingModels: value }),

  setProviderHealth: (provider, health) => set((state) => ({
    providerHealth: { ...state.providerHealth, [provider]: health },
  })),
  
  setAuthStatus: (provider, status) => set((state) => ({
    authStatus: { ...state.authStatus, [provider]: status },
  })),

  setAccountStatuses: (statuses) => set({
    accountStatuses: Object.fromEntries(statuses.map((status) => [status.provider, status])),
  }),
  
  setTokenUsage: (modelId, usage) => set((state) => ({
    tokenUsage: { ...state.tokenUsage, [modelId]: usage },
  })),
  setQuotaSnapshots: (snapshots) => set({ quotaSnapshots: snapshots }),

  setFallbackConfig: (config) => set({ fallbackConfig: config }),

  setAutoModeStatus: (status) => set({ autoModeStatus: status }),
  setAutoModeChatId: (chatId) => set({ autoModeChatId: chatId }),
  setAutoModeIteration: (iteration) => set({ autoModeIteration: iteration }),
  setAutoModeTotalTokens: (tokens) => set({ autoModeTotalTokens: tokens }),
  setAutoModeDetail: (detail) => set({ autoModeDetail: detail }),
  setAutoModeState: (state) => set({
    autoModeStatus: state.status,
    autoModeChatId: state.chatId || null,
    autoModeIteration: state.iteration || 0,
    autoModeTotalTokens: state.totalTokens || 0,
    autoModeMaxIterations: state.maxIterations || 0,
    autoModeDetail: state.detail || '',
    autoModePhase: state.phase || (state.status === 'running' ? 'starting' : state.status === 'paused' ? 'paused' : 'idle'),
    autoModeLastPromptPreview: state.lastPromptPreview || '',
    autoModeError: state.error || '',
  }),
  
  setCooldown: (modelId, cooldown) => set((state) => ({
    cooldowns: { ...state.cooldowns, [modelId]: cooldown },
  })),
  removeCooldown: (modelId) => set((state) => {
    const { [modelId]: _, ...rest } = state.cooldowns;
    return { cooldowns: rest };
  }),
  setPreferredAuthMethod: (provider, method) => set((state) => ({
    preferredAuthMethod: { ...state.preferredAuthMethod, [provider]: method },
  })),
}), {
  name: 'superapp-providers',
  version: 3,
  migrate: (persistedState, version) => {
    const persisted = (persistedState || {}) as Partial<ProviderState>;
    if (version >= 3) return persisted as ProviderState;
    // Modellen en verbindingsstatus zijn live gegevens. Oude ontdekkingen uit
    // localStorage zorgden ervoor dat uitgelogde providers toch zichtbaar bleven.
    const cleaned = { ...persisted } as Record<string, unknown>;
    delete cleaned.models;
    delete cleaned.modelsByProvider;
    delete cleaned.chatgptVersions;
    delete cleaned.chatgptSessionActive;
    delete cleaned.accountStatuses;
    delete cleaned.authStatus;
    delete cleaned.quotaSnapshots;
    return cleaned as unknown as ProviderState;
  },
  storage: createJSONStorage(() => localStorage),
  // Modelcatalogi, sessies en auth-status zijn bewust niet persistent: bij iedere
  // start toont de selector uitsluitend opnieuw live bevestigde verbindingen.
  partialize: () => ({}),
}));
