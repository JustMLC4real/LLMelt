import { contextBridge, ipcRenderer } from 'electron';
import type {
  AutoModeConfig,
  ChatRequest,
  ChatStreamEvent,
  FallbackConfig,
  ModelRef,
  OllamaInstalledModel,
  OllamaLibraryModel,
  OllamaLibraryTag,
  OllamaModelManagerStatus,
  OllamaModelPullProgress,
  OllamaTitleSetupProgress,
  ProviderAccountId,
  ProviderType,
  RuntimeSetupId,
  RuntimeSetupProgress,
  ValidationResult,
} from '../src/providers/types';

const on = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const electronAPI = {
  chat: {
    sendMessage: (request: ChatRequest) => ipcRenderer.invoke('chat:sendMessage', request),
    cancel: (requestId?: string) => ipcRenderer.invoke('chat:cancel', requestId),
    stopGeneration: () => ipcRenderer.invoke('chat:stopGeneration'),
    onStreamEvent: (callback: (event: ChatStreamEvent) => void) => on<ChatStreamEvent>('chat:streamEvent', callback),
    onStreamChunk: (callback: (chunk: { delta: string; done: boolean; usage?: any }) => void) =>
      on<{ delta: string; done: boolean; usage?: any }>('chat:streamChunk', callback),
    onRefresh: (callback: (data: { chatId: string }) => void) => on<{ chatId: string }>('chat:refresh', callback),
    onTitleUpdated: (callback: (data: { chatId: string; title: string }) => void) => on<{ chatId: string; title: string }>('chat:titleUpdated', callback),
    onTitleGenerating: (callback: (data: { chatId: string }) => void) => on<{ chatId: string }>('chat:titleGenerating', callback),
    getTitleOllamaStatus: () => ipcRenderer.invoke('chat:getTitleOllamaStatus'),
    installTitleOllama: () => ipcRenderer.invoke('chat:installTitleOllama'),
    onTitleOllamaSetupProgress: (callback: (data: OllamaTitleSetupProgress) => void) =>
      on<OllamaTitleSetupProgress>('chat:titleOllamaSetupProgress', callback),
  },

  providers: {
    listAll: () => ipcRenderer.invoke('providers:listAll'),
    refreshModels: (providerId?: ProviderType) => ipcRenderer.invoke('providers:refreshModels', providerId),
    listModels: (providerId?: ProviderType) => ipcRenderer.invoke('providers:listModels', providerId),
    getHealth: () => ipcRenderer.invoke('providers:getHealth'),
    getAccountStatuses: () => ipcRenderer.invoke('providers:getAccountStatuses'),
    chatgptVersions: () => ipcRenderer.invoke('providers:chatgptVersions'),
    openAccountSurface: (provider: ProviderAccountId) => ipcRenderer.invoke('providers:openAccountSurface', provider),
  },

  runtime: {
    getStatus: (runtime: RuntimeSetupId) => ipcRenderer.invoke('runtime:getStatus', runtime),
    install: (runtime: RuntimeSetupId) => ipcRenderer.invoke('runtime:install', runtime),
    onSetupProgress: (callback: (data: RuntimeSetupProgress) => void) =>
      on<RuntimeSetupProgress>('runtime:setupProgress', callback),
  },

  ollama: {
    listInstalled: (): Promise<OllamaModelManagerStatus> =>
      ipcRenderer.invoke('ollama:listInstalled'),
    searchLibrary: (query: string): Promise<OllamaLibraryModel[]> =>
      ipcRenderer.invoke('ollama:searchLibrary', query),
    listLibraryTags: (libraryPath: string): Promise<OllamaLibraryTag[]> =>
      ipcRenderer.invoke('ollama:listLibraryTags', libraryPath),
    pullModel: (model: string): Promise<OllamaInstalledModel[]> =>
      ipcRenderer.invoke('ollama:pullModel', model),
    cancelPull: (model: string): Promise<boolean> =>
      ipcRenderer.invoke('ollama:cancelPull', model),
    deleteModel: (model: string): Promise<OllamaInstalledModel[]> =>
      ipcRenderer.invoke('ollama:deleteModel', model),
    openLibrary: (query?: string): Promise<boolean> =>
      ipcRenderer.invoke('ollama:openLibrary', query),
    onPullProgress: (callback: (data: OllamaModelPullProgress) => void) =>
      on<OllamaModelPullProgress>('ollama:modelPullProgress', callback),
  },

  auth: {
    saveCredential: (provider: ProviderType, secret: string, method = 'apikey') =>
      ipcRenderer.invoke('auth:saveCredential', provider, secret, method),
    setApiKey: (provider: ProviderType, key: string) => ipcRenderer.invoke('auth:setApiKey', provider, key),
    getApiKey: (provider: ProviderType) => ipcRenderer.invoke('auth:getApiKey', provider),
    removeApiKey: (provider: ProviderType) => ipcRenderer.invoke('auth:removeApiKey', provider),
    testCredential: (provider: ProviderType, secret?: string) => ipcRenderer.invoke('auth:testCredential', provider, secret),
    testConnection: (provider: ProviderType) => ipcRenderer.invoke('auth:testConnection', provider),
    browserLogin: (provider: ProviderType) => ipcRenderer.invoke('auth:browserLogin', provider),
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    getAuthStatus: () => ipcRenderer.invoke('auth:getAuthStatus'),
    // ChatGPT browser session
    chatgptBrowserLogin: () => ipcRenderer.invoke('auth:chatgptBrowserLogin'),
    chatgptBrowserLogout: () => ipcRenderer.invoke('auth:chatgptBrowserLogout'),
    chatgptSessionStatus: () => ipcRenderer.invoke('auth:chatgptSessionStatus'),
    chatgptEngineStatus: () => ipcRenderer.invoke('auth:chatgptEngineStatus'),
    chatgptEngineReset: () => ipcRenderer.invoke('auth:chatgptEngineReset'),
    chatgptOpenWindow: () => ipcRenderer.invoke('auth:chatgptOpenWindow'),
    // Claude CLI
    claudeCliLogin: () => ipcRenderer.invoke('auth:claudeCliLogin'),
    // Codex CLI
    codexCliLogin: () => ipcRenderer.invoke('auth:codexCliLogin'),
    // Antigravity CLI
    antigravityCliLogin: () => ipcRenderer.invoke('auth:antigravityCliLogin'),
  },

  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (callback: (maximized: boolean) => void) => on<boolean>('window:maximizeChanged', callback),
  },

  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  },

  db: {
    getChats: () => ipcRenderer.invoke('db:getChats'),
    getChat: (id: string) => ipcRenderer.invoke('db:getChat', id),
    createChat: (title: string, folderId?: string, id?: string) => ipcRenderer.invoke('db:createChat', title, folderId, id),
    updateChat: (id: string, data: any) => ipcRenderer.invoke('db:updateChat', id, data),
    deleteChat: (id: string) => ipcRenderer.invoke('db:deleteChat', id),

    getMessages: (chatId: string) => ipcRenderer.invoke('db:getMessages', chatId),
    addMessage: (msg: any) => ipcRenderer.invoke('db:addMessage', msg),
    deleteMessage: (id: string) => ipcRenderer.invoke('db:deleteMessage', id),

    getFolders: () => ipcRenderer.invoke('db:getFolders'),
    createFolder: (name: string, parentId?: string) => ipcRenderer.invoke('db:createFolder', name, parentId),
    updateFolder: (id: string, data: any) => ipcRenderer.invoke('db:updateFolder', id, data),
    deleteFolder: (id: string) => ipcRenderer.invoke('db:deleteFolder', id),

    getMemory: (type?: string, scopeId?: string) => ipcRenderer.invoke('db:getMemory', type, scopeId),
    addMemory: (mem: any) => ipcRenderer.invoke('db:addMemory', mem),
    updateMemory: (id: string, data: any) => ipcRenderer.invoke('db:updateMemory', id, data),
    deleteMemory: (id: string) => ipcRenderer.invoke('db:deleteMemory', id),

    getPresets: () => ipcRenderer.invoke('db:getPresets'),
    savePreset: (preset: any) => ipcRenderer.invoke('db:savePreset', preset),
    deletePreset: (id: string) => ipcRenderer.invoke('db:deletePreset', id),
  },

  tokens: {
    getDashboard: (chatId?: string) => ipcRenderer.invoke('tokens:getDashboard', chatId),
    getUsage: (modelId?: string) => ipcRenderer.invoke('tokens:getUsage', modelId),
    getContextUsage: (chatId: string, modelRef?: ModelRef) => ipcRenderer.invoke('tokens:getContextUsage', chatId, modelRef),
    getRateLimits: () => ipcRenderer.invoke('tokens:getRateLimits'),
    getQuotas: () => ipcRenderer.invoke('tokens:getQuotas'),
    refreshQuotas: () => ipcRenderer.invoke('tokens:refreshQuotas'),
    onUsageUpdate: (callback: (usage: any) => void) => on<any>('tokens:usageUpdate', callback),
  },

  geminiQuota: {
    getStatus: (validate = false) => ipcRenderer.invoke('geminiQuota:getStatus', validate),
    configure: (projectId: string, oauthClientId: string) => ipcRenderer.invoke('geminiQuota:configure', projectId, oauthClientId),
    connect: () => ipcRenderer.invoke('geminiQuota:connect'),
    disconnect: () => ipcRenderer.invoke('geminiQuota:disconnect'),
  },

  quotaBridge: {
    ensure: (provider: 'claude' | 'antigravity') => ipcRenderer.invoke('quotaBridge:ensure', provider),
    restore: (provider: 'claude' | 'antigravity') => ipcRenderer.invoke('quotaBridge:restore', provider),
  },

  fallback: {
    getConfig: () => ipcRenderer.invoke('fallback:getConfig'),
    setConfig: (config: FallbackConfig) => ipcRenderer.invoke('fallback:setConfig', config),
    setOrder: (order: any[]) => ipcRenderer.invoke('fallback:setOrder', order),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('fallback:setEnabled', enabled),
    onSwitch: (callback: (data: any) => void) => on<any>('fallback:switch', callback),
  },

  autoMode: {
    start: (config: AutoModeConfig) => ipcRenderer.invoke('auto:start', config),
    pause: () => ipcRenderer.invoke('auto:pause'),
    resume: () => ipcRenderer.invoke('auto:resume'),
    stop: () => ipcRenderer.invoke('auto:stop'),
    getStatus: () => ipcRenderer.invoke('auto:getStatus'),
    onIteration: (callback: (data: any) => void) => on<any>('auto:iteration', callback),
  },

  agent: {
    getConfig: () => ipcRenderer.invoke('agent:getConfig'),
    getPendingApprovals: () => ipcRenderer.invoke('agent:getPendingApprovals'),
    setConfig: (config: { mode?: string; workingDir?: string; toolsEnabled?: boolean; defaultShell?: string }) => ipcRenderer.invoke('agent:setConfig', config),
    runCommand: (command: string, options?: { shell?: string; cwd?: string; source?: string }) => ipcRenderer.invoke('agent:runCommand', command, options),
    respondApproval: (id: string, approved: boolean) => ipcRenderer.invoke('agent:approvalResponse', id, approved),
    onApprovalRequest: (callback: (data: {
      id: string;
      command: string;
      cwd: string;
      shell?: string;
      kind?: 'file-read' | 'file-create' | 'file-edit' | 'command';
      label?: string;
      path?: string;
      chatId?: string;
      requestId?: string;
    }) => void) => on<any>('agent:approvalRequest', callback),
    onApprovalResolved: (callback: (data: {
      id: string;
      approved: boolean;
      reason: 'answered' | 'cancelled' | 'window_closed';
    }) => void) => on<any>('agent:approvalResolved', callback),
    onTerminal: (callback: (data: { type: 'cmd' | 'out' | 'err' | 'exit'; command?: string; cwd?: string; text?: string; code?: number | null }) => void) => on<any>('agent:term', callback),
  },

  terminal: {
    listShells: () => ipcRenderer.invoke('terminal:listShells'),
    create: (options?: { shell?: string; cwd?: string; cols?: number; rows?: number }) => ipcRenderer.invoke('terminal:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
    onData: (callback: (data: { id: string; data: string }) => void) => on<any>('terminal:data', callback),
    onExit: (callback: (data: { id: string; exitCode: number }) => void) => on<any>('terminal:exit', callback),
  },

  mcp: {
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    setConfig: (config: any) => ipcRenderer.invoke('mcp:setConfig', config),
    start: () => ipcRenderer.invoke('mcp:start'),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    getCalls: () => ipcRenderer.invoke('mcp:getCalls'),
    onCall: (callback: (data: any) => void) => on<any>('mcp:call', callback),
  },

  keys: {
    validateBatch: (keys: Array<{ key: string; provider?: ProviderType }>) =>
      ipcRenderer.invoke('keys:validateBatch', keys),
    validateKeys: (keys: Array<{ key: string; provider?: ProviderType }>) =>
      ipcRenderer.invoke('keys:validateKeys', keys),
    onValidationResult: (callback: (result: ValidationResult) => void) =>
      on<ValidationResult>('keys:validationResult', callback),
  },

  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    resetSshFingerprint: () => ipcRenderer.invoke('settings:resetSshFingerprint'),
  },

  files: {
    selectAndImport: (chatId?: string) => ipcRenderer.invoke('files:selectAndImport', chatId),
    selectFiles: (chatId?: string) => ipcRenderer.invoke('files:selectFiles', chatId),
    selectDirectory: () => ipcRenderer.invoke('files:selectDirectory'),
    getDefaultWorkspace: () => ipcRenderer.invoke('files:getDefaultWorkspace'),
    readFile: (attachmentId: string) => ipcRenderer.invoke('files:readFile', attachmentId),
    deletePending: (attachmentId: string) => ipcRenderer.invoke('files:deletePending', attachmentId),
  },

  updater: {
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback: (status: any) => void) => on<any>('updater:status', callback),
  },

  tray: {
    onOpenChat: (callback: (chatId: string) => void) => on<string>('tray:openChat', callback),
    setChats: (chats: Array<{ id: string; title: string; folder?: string }>) => ipcRenderer.send('tray:setChats', chats),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
