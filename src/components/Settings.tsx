import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, Globe2, ImagePlus, KeyRound, Loader2, LockKeyhole, RefreshCw, Rocket, Save, Search, Settings as SettingsIcon, Server, Sparkles, Terminal, Trash2, UserRound } from 'lucide-react';
import { changeLanguage } from '../i18n';
import { useProviderStore } from '../stores/provider-store';
import { useProfileStore } from '../stores/profile-store';
import FallbackChain from './FallbackChain';
import OllamaModelManager from './OllamaModelManager';
import UpdatePanel from './UpdatePanel';
import { requestOnboarding } from './onboarding-launch';
import { formatUpdateBytes } from '../update-status';
import type { AgentShell, AuthMethod, ModelRunConfig, OllamaTitleSetupProgress, ProviderAccountId, ProviderType } from '../providers/types';
import { normalizeLegacyModelId } from '../providers/model-ref-normalization';
import { FlipText, SegmentedControl, SelectField } from './ui';

type TestState = 'idle' | 'testing' | 'success' | 'error';
type CliSetupProvider = 'codex' | 'claude' | 'antigravity';
type ChatGptEngineState = {
  active: boolean;
  plan?: string | null;
  stage?: string;
  transport?: 'web-session';
  lastError?: string | null;
  lastModel?: string | null;
  recoverable?: boolean;
  updatedAt?: string | null;
};
type OllamaTitleSetupStatus = {
  ready: boolean;
  runtimeAvailable: boolean;
  modelAvailable: boolean;
  model: string;
  installedModels: string[];
};
type GeminiQuotaStatus = {
  connected: boolean;
  projectId?: string;
  oauthClientId?: string;
  clientIdConfigured: boolean;
  keyProjectMatches?: boolean;
  error?: string;
};
const PROVIDER_CARDS: Array<{
  id: ProviderType;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  color: string;
  authOptions: Array<{ value: AuthMethod; label: string }>;
  apiKeyPlaceholder?: string;
}> = [
    {
      id: 'openai',
      label: 'ChatGPT Subscription / OpenAI API',
      icon: Sparkles,
      color: '#10a37f',
      authOptions: [
        { value: 'browser', label: 'ChatGPT Subscription' },
        { value: 'apikey', label: 'OpenAI API' },
      ],
      apiKeyPlaceholder: 'sk-...',
    },
    {
      id: 'google',
      label: 'Google Gemini',
      icon: Bot,
      color: '#4285f4',
      authOptions: [
        { value: 'apikey', label: 'Gemini API-key' },
      ],
      apiKeyPlaceholder: 'AI...',
    },
    {
      id: 'anthropic',
      label: 'Claude / Anthropic',
      icon: Terminal,
      color: '#d4a574',
      authOptions: [
        { value: 'cli', label: 'Claude Code CLI' },
        { value: 'apikey', label: 'API key' },
      ],
      apiKeyPlaceholder: 'sk-ant-...',
    },
  ];

const Settings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const isEnglish = (i18n.resolvedLanguage || i18n.language).toLowerCase().startsWith('en');
  const localizedStatus = (raw: string | undefined, fallbackKey: string) => (
    isEnglish ? t(fallbackKey) : raw || t(fallbackKey)
  );
  const {
    authStatus, accountStatuses, setAuthStatus, setAccountStatuses,
    models, setModels, setProviderModels, setChatgptVersions,
    setChatgptSessionActive: setProviderChatgptSessionActive, setFallbackConfig,
    preferredAuthMethod, setPreferredAuthMethod,
  } = useProviderStore();
  const { userAvatarDataUrl, setUserAvatarDataUrl } = useProfileStore();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [codexExecutable, setCodexExecutable] = useState('');
  const [codexTimeoutSeconds, setCodexTimeoutSeconds] = useState(180);
  const [claudeExecutable, setClaudeExecutable] = useState('');
  const [antigravityExecutable, setAntigravityExecutable] = useState('');
  const [antigravityModelsText, setAntigravityModelsText] = useState('');
  const [antigravityStatusJsonPath, setAntigravityStatusJsonPath] = useState('');
  const [cliActionMessages, setCliActionMessages] = useState<Partial<Record<CliSetupProvider, string>>>({});
  const [sshConfig, setSshConfig] = useState({ host: '', port: '22', user: '', password: '', privateKey: '' });
  const [sshFingerprintStatus, setSshFingerprintStatus] = useState<string | null>(null);
  const [chatgptSessionActive, setChatgptSessionActive] = useState(false);
  const [chatgptPlan, setChatgptPlan] = useState<string | null>(null);
  const [chatgptEngine, setChatgptEngine] = useState<ChatGptEngineState | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState('');
  const providerQuery = providerSearch.trim().toLowerCase();
  const matchProvider = (name: string) => !providerQuery || name.toLowerCase().includes(providerQuery);
  // Globale settings-zoek: een sectie is zichtbaar als de zoekterm leeg is of
  // een van de trefwoorden bevat.
  const sectionMatches = (keywords: string[]) => !providerQuery || keywords.some((keyword) => keyword.toLowerCase().includes(providerQuery));
  const anyProviderMatches =
    sectionMatches(['providers', 'chatgpt', 'openai', 'gemini', 'google', 'claude', 'anthropic', 'codex', 'antigravity', 'ollama', 'ssh', 'remote', 'cli', 'api key'])
    || PROVIDER_CARDS.some((card) => matchProvider(card.label));
  const [agentMode, setAgentMode] = useState('ask');
  const [agentWorkingDir, setAgentWorkingDir] = useState('');
  const [agentDefaultShell, setAgentDefaultShell] = useState<AgentShell>('powershell');
  const [agentToolsEnabled, setAgentToolsEnabled] = useState(false);
  const [agentTestCmd, setAgentTestCmd] = useState('');
  const [agentTestOutput, setAgentTestOutput] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<string | null>(null);
  const [chatTitleMode, setChatTitleMode] = useState<string>('ollama');
  const [geminiProjectId, setGeminiProjectId] = useState('');
  const [geminiOauthClientId, setGeminiOauthClientId] = useState('');
  const [geminiQuotaStatus, setGeminiQuotaStatus] = useState<GeminiQuotaStatus | null>(null);
  const [geminiQuotaLoading, setGeminiQuotaLoading] = useState(false);
  const [ollamaTitleSetup, setOllamaTitleSetup] = useState<OllamaTitleSetupStatus | null>(null);
  const [ollamaTitleSetupProgress, setOllamaTitleSetupProgress] = useState<OllamaTitleSetupProgress | null>(null);
  const [ollamaTitleSetupLoading, setOllamaTitleSetupLoading] = useState(false);
  const settingsMountedRef = React.useRef(true);

  useEffect(() => {
    settingsMountedRef.current = true;
    return () => {
      settingsMountedRef.current = false;
    };
  }, []);

  const refreshChatGptStatus = React.useCallback(async () => {
    if (!window.electronAPI) return null;
    try {
      const session = await window.electronAPI.auth.chatgptEngineStatus();
      setChatgptEngine(session || null);
      setChatgptSessionActive(!!session?.active);
      setProviderChatgptSessionActive(!!session?.active);
      setChatgptPlan((session as any)?.plan || null);
      return session;
    } catch {
      setChatgptEngine({ active: false, stage: 'failed', lastError: t('settings.chatgpt.statusReadFailed'), recoverable: true });
      setChatgptSessionActive(false);
      setProviderChatgptSessionActive(false);
      setChatgptPlan(null);
      return null;
    }
  }, [setProviderChatgptSessionActive, t]);

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return;
      const settings = await window.electronAPI.settings.getAll();
      setUserAvatarDataUrl(typeof settings?.profile?.avatarDataUrl === 'string' ? settings.profile.avatarDataUrl : null);
      setOllamaUrl(settings?.ollama?.url || 'http://localhost:11434');
      const titleMode = normalizeChatTitleMode(settings?.chat?.autoTitleMode);
      setChatTitleMode(titleMode);
      if (settings?.chat?.autoTitleMode !== titleMode) {
        await window.electronAPI.settings.set('chat.autoTitleMode', titleMode);
      }
      void window.electronAPI.chat.getTitleOllamaStatus()
        .then((status) => {
          if (settingsMountedRef.current) setOllamaTitleSetup(status);
        })
        .catch(() => {
          if (settingsMountedRef.current) {
            setOllamaTitleSetup({
              ready: false,
              runtimeAvailable: false,
              modelAvailable: false,
              model: 'qwen3:1.7b',
              installedModels: [],
            });
          }
        });
      setCodexExecutable(settings?.codex?.executable || '');
      setCodexTimeoutSeconds(Number(settings?.codex?.timeoutSeconds || 180));
      setClaudeExecutable(settings?.claude?.executable || '');
      setAntigravityExecutable(settings?.antigravity?.executable || '');
      setAntigravityModelsText(Array.isArray(settings?.antigravity?.models) ? settings.antigravity.models.join('\n') : '');
      setAntigravityStatusJsonPath(settings?.antigravity?.statusJsonPath || '');
      const quotaStatus = await window.electronAPI.geminiQuota.getStatus(false).catch(() => null);
      if (quotaStatus) {
        setGeminiQuotaStatus(quotaStatus);
        setGeminiProjectId(quotaStatus.projectId || '');
        setGeminiOauthClientId(quotaStatus.oauthClientId || '');
      }
      setSshConfig({
        host: settings?.sshConfig?.host || '',
        port: settings?.sshConfig?.port || '22',
        user: settings?.sshConfig?.user || '',
        password: settings?.sshConfig?.password || settings?.sshConfig?.key || '',
        privateKey: settings?.sshConfig?.privateKey || '',
      });
      const config = await window.electronAPI.fallback.getConfig();
      setFallbackConfig(config);
      try {
        const agent = await window.electronAPI.agent.getConfig();
        setAgentMode(agent?.mode || 'ask');
        setAgentWorkingDir(agent?.workingDir || '');
        setAgentDefaultShell(agent?.defaultShell || 'powershell');
        setAgentToolsEnabled(!!agent?.toolsEnabled);
      } catch { /* agent config optional */ }
      const accountStatusList = await window.electronAPI.providers.getAccountStatuses();
      setAccountStatuses(accountStatusList);
      await refreshChatGptStatus();
    };
    load();
  }, [refreshChatGptStatus, setAccountStatuses, setFallbackConfig, setUserAvatarDataUrl]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;
    return api.chat.onTitleOllamaSetupProgress((progress) => {
      setOllamaTitleSetupProgress(progress);
    });
  }, []);

  useEffect(() => {
    if (ollamaTitleSetupProgress?.phase !== 'ready') return undefined;
    const timeout = window.setTimeout(() => {
      setOllamaTitleSetupProgress((current) => current?.phase === 'ready' ? null : current);
    }, 4_000);
    return () => window.clearTimeout(timeout);
  }, [ollamaTitleSetupProgress]);

  const refreshModels = async () => {
    if (!window.electronAPI) return;
    const refreshed = await window.electronAPI.providers.refreshModels();
    setModels(refreshed);
    const versions = await window.electronAPI.providers.chatgptVersions().catch(() => []);
    if (Array.isArray(versions)) setChatgptVersions(versions);
  };

  const installOllamaForTitles = async () => {
    if (!window.electronAPI || ollamaTitleSetupLoading) return;
    setOllamaTitleSetupLoading(true);
    setOllamaTitleSetupProgress({
      phase: 'checking',
       status: t('settings.titles.checkingOllama'),
      model: ollamaTitleSetup?.model || 'qwen3:1.7b',
    });
    try {
      const status = await window.electronAPI.chat.installTitleOllama();
      if (settingsMountedRef.current) setOllamaTitleSetup(status);
      await window.electronAPI.settings.set('ollama.url', ollamaUrl.trim() || 'http://localhost:11434');
      await refreshAuthStatus();
      await refreshModels();
    } catch (error) {
      if (settingsMountedRef.current) {
        setOllamaTitleSetupProgress({
          phase: 'error',
          status: error instanceof Error ? error.message : String(error),
          model: ollamaTitleSetup?.model || 'qwen3:1.7b',
        });
      }
    } finally {
      if (settingsMountedRef.current) setOllamaTitleSetupLoading(false);
    }
  };

  const chooseUserAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setAvatarStatus(t('settings.profile.chooseImageFile'));
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setAvatarStatus(t('settings.profile.imageTooLarge'));
      return;
    }

    try {
      setAvatarStatus(t('settings.profile.processingImage'));
      const dataUrl = await resizeAvatarImage(file);
      setUserAvatarDataUrl(dataUrl);
      await window.electronAPI?.settings.set('profile.avatarDataUrl', dataUrl);
      setAvatarStatus(t('settings.profile.avatarSaved'));
      setTimeout(() => setAvatarStatus(null), 1800);
    } catch (error) {
      console.error(error);
      setAvatarStatus(t('settings.profile.avatarSaveFailed'));
    }
  };

  const removeUserAvatar = async () => {
    setUserAvatarDataUrl(null);
    await window.electronAPI?.settings.set('profile.avatarDataUrl', null);
    setAvatarStatus(t('settings.profile.avatarRemoved'));
    setTimeout(() => setAvatarStatus(null), 1800);
  };

  const saveAgentConfig = async (mode: string, workingDir: string, defaultShell: AgentShell = agentDefaultShell) => {
    setAgentMode(mode);
    setAgentWorkingDir(workingDir);
    setAgentDefaultShell(defaultShell);
    await window.electronAPI?.agent.setConfig({ mode, workingDir, defaultShell });
  };

  const toggleAgentTools = async (enabled: boolean) => {
    setAgentToolsEnabled(enabled);
    await window.electronAPI?.agent.setConfig({ toolsEnabled: enabled });
  };

  const runAgentTest = async () => {
    if (!agentTestCmd.trim() || !window.electronAPI) return;
    setAgentRunning(true);
    setAgentTestOutput(null);
    await window.electronAPI.agent.setConfig({ mode: agentMode, workingDir: agentWorkingDir, defaultShell: agentDefaultShell });
    const res: any = await window.electronAPI.agent.runCommand(agentTestCmd, { shell: agentDefaultShell, source: 'test' });
    setAgentRunning(false);
    if (!res) { setAgentTestOutput(t('settings.agent.noResponse')); return; }
    setAgentTestOutput([
      res.denied ? t('settings.agent.deniedByUser') : `[exit ${res.code}]  (${res.cwd || ''})`,
      res.stdout,
      res.stderr,
      res.error,
    ].filter(Boolean).join('\n'));
  };

  const refreshAuthStatus = async () => {
    if (!window.electronAPI) return;
    const status = await window.electronAPI.auth.getStatus();
    Object.entries(status).forEach(([id, providerStatus]) => setAuthStatus(id as ProviderType, providerStatus as any));
    const accountStatusList = await window.electronAPI.providers.getAccountStatuses();
    setAccountStatuses(accountStatusList);
    await refreshChatGptStatus();
  };

  const saveKey = async (provider: ProviderType) => {
    const key = keys[provider]?.trim();
    if (!key || !window.electronAPI) return;
    setTestResults((prev) => ({ ...prev, [provider]: 'testing' }));
    const result = await window.electronAPI.auth.saveCredential(provider, key, 'apikey');
    setTestResults((prev) => ({ ...prev, [provider]: result.status === 'valid' ? 'success' : 'error' }));
    await refreshAuthStatus();
    await refreshModels();
  };

  const testProvider = async (provider: ProviderType) => {
    if (!window.electronAPI) return;
    setTestResults((prev) => ({ ...prev, [provider]: 'testing' }));
    const result = await window.electronAPI.auth.testCredential(provider, keys[provider]?.trim() || undefined);
    setTestResults((prev) => ({ ...prev, [provider]: result.status === 'valid' ? 'success' : 'error' }));
    await refreshAuthStatus();
    await refreshModels();
  };

  const connectGeminiQuota = async () => {
    if (!window.electronAPI || geminiQuotaLoading) return;
    setGeminiQuotaLoading(true);
    try {
      const apiKey = keys.google?.trim();
      if (apiKey) {
        const validation = await window.electronAPI.auth.saveCredential('google', apiKey, 'apikey');
        if (validation.status !== 'valid') throw new Error(validation.error || t('settings.gemini.invalidApiKey'));
      }
      await window.electronAPI.geminiQuota.configure(geminiProjectId, geminiOauthClientId);
      const status = await window.electronAPI.geminiQuota.connect();
      setGeminiQuotaStatus(status);
      await refreshAuthStatus();
      await refreshModels();
    } catch (error) {
      setGeminiQuotaStatus({
        connected: false,
        projectId: geminiProjectId,
        oauthClientId: geminiOauthClientId,
        clientIdConfigured: !!geminiOauthClientId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setGeminiQuotaLoading(false);
    }
  };

  const disconnectGeminiQuota = async () => {
    if (!window.electronAPI) return;
    setGeminiQuotaStatus(await window.electronAPI.geminiQuota.disconnect());
    await refreshAuthStatus();
  };

  const handleChatGptLogin = async () => {
    if (!window.electronAPI) return;
    setTestResults((prev) => ({ ...prev, openai: 'testing' }));
    const result = await window.electronAPI.auth.chatgptBrowserLogin();
    if (result.success) {
      setTestResults((prev) => ({ ...prev, openai: 'success' }));
      if (Array.isArray(result.models)) setProviderModels('openai', result.models);
      if (Array.isArray(result.versions)) setChatgptVersions(result.versions);
      if (result.sessionStatus) {
        setChatgptEngine(result.sessionStatus);
        setChatgptSessionActive(result.sessionStatus.active === true);
        setProviderChatgptSessionActive(result.sessionStatus.active === true);
        setChatgptPlan(result.sessionStatus.plan || null);
      }
    } else {
      setTestResults((prev) => ({ ...prev, openai: 'error' }));
    }
    await refreshChatGptStatus();
    await refreshAuthStatus();
    await refreshModels();
  };

  const handleChatGptLogout = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.auth.chatgptBrowserLogout();
    await refreshChatGptStatus();
    await refreshAuthStatus();
    await refreshModels();
  };

  const handleChatGptReset = async () => {
    if (!window.electronAPI) return;
    setTestResults((prev) => ({ ...prev, openai: 'testing' }));
    const status = await window.electronAPI.auth.chatgptEngineReset();
    setChatgptEngine(status || null);
    setChatgptSessionActive(!!status?.active);
    setProviderChatgptSessionActive(!!status?.active);
    setChatgptPlan((status as any)?.plan || null);
    setTestResults((prev) => ({ ...prev, openai: 'idle' }));
  };

  const handleChatGptOpenWindow = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.auth.chatgptOpenWindow();
    setTimeout(() => { refreshChatGptStatus(); refreshModels(); }, 1500);
  };

  const setCliActionMessage = (provider: CliSetupProvider, message?: string) => {
    setCliActionMessages((previous) => {
      if (!message) {
        const next = { ...previous };
        delete next[provider];
        return next;
      }
      return { ...previous, [provider]: message };
    });
  };

  const monitorCliConnection = async (
    accountId: ProviderAccountId,
    provider: ProviderType,
    messageProvider: CliSetupProvider,
    displayName: string,
  ) => {
    for (let attempt = 0; attempt < 40 && settingsMountedRef.current; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!settingsMountedRef.current || !window.electronAPI) return;
      const statuses = await window.electronAPI.providers.getAccountStatuses();
      if (!settingsMountedRef.current) return;
      setAccountStatuses(statuses);
      const cli = statuses.find((status: any) => status.provider === accountId);
      if (!cli?.authenticated) continue;

      // Na de interactieve login verversen we ook de samengevoegde providerstatus
      // en modelcatalogus; een verse installatie heeft zo geen apprestart nodig.
      await window.electronAPI.auth.testCredential(provider);
      await refreshAuthStatus();
      await refreshModels();
      if (!settingsMountedRef.current) return;
      setTestResults((previous) => ({ ...previous, [provider]: 'success' }));
      setCliActionMessage(messageProvider, t('settings.cli.foundAndConnected', { name: displayName }));
      return;
    }
  };

  const handleClaudeCliLogin = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.settings.set('claude.executable', claudeExecutable.trim());
    setCliActionMessage('claude');
    setTestResults((prev) => ({ ...prev, anthropic: 'testing' }));
    const result = await window.electronAPI.auth.claudeCliLogin();
    if (result.success) {
      setTestResults((prev) => ({ ...prev, anthropic: 'success' }));
      setCliActionMessage('claude', t(result.action === 'install' ? 'settings.cli.installedAndOpened' : 'settings.cli.opened', { name: 'Claude Code CLI' }));
    } else {
      setTestResults((prev) => ({ ...prev, anthropic: 'error' }));
      setCliActionMessage('claude', result.error
        ? t('settings.cli.openFailedDetail', { name: 'Claude Code CLI', detail: result.error })
        : t('settings.cli.openFailed', { name: 'Claude Code CLI' }));
    }
    if (result.success) void monitorCliConnection('claude-cli', 'anthropic', 'claude', 'Claude Code CLI');
  };

  const handleCodexCliLogin = async () => {
    if (!window.electronAPI) return;
    setCliActionMessage('codex');
    setTestResults((prev) => ({ ...prev, codex: 'testing' }));
    const result = await window.electronAPI.auth.codexCliLogin();
    if (result.success) {
      setTestResults((prev) => ({ ...prev, codex: 'success' }));
      setCliActionMessage('codex', t(result.action === 'install' ? 'settings.cli.installedAndOpened' : 'settings.cli.opened', { name: 'Codex CLI' }));
      void monitorCliConnection('codex', 'codex', 'codex', 'Codex CLI');
    } else {
      setTestResults((prev) => ({ ...prev, codex: 'error' }));
      setCliActionMessage('codex', result.error
        ? t('settings.cli.openFailedDetail', { name: 'Codex CLI', detail: result.error })
        : t('settings.cli.openFailed', { name: 'Codex CLI' }));
    }
  };

  const handleAntigravityCliLogin = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.settings.set('antigravity.executable', antigravityExecutable.trim());
    setCliActionMessage('antigravity');
    setTestResults((prev) => ({ ...prev, antigravity: 'testing' }));
    const result = await window.electronAPI.auth.antigravityCliLogin();
    if (result.success) {
      setTestResults((prev) => ({ ...prev, antigravity: 'success' }));
      setCliActionMessage('antigravity', t(result.action === 'install' ? 'settings.cli.installedAndOpened' : 'settings.cli.opened', { name: 'Antigravity CLI' }));
    } else {
      setTestResults((prev) => ({ ...prev, antigravity: 'error' }));
      setCliActionMessage('antigravity', result.error
        ? t('settings.cli.openFailedDetail', { name: 'Antigravity CLI', detail: result.error })
        : t('settings.cli.openFailed', { name: 'Antigravity CLI' }));
    }
    if (result.success) void monitorCliConnection('antigravity', 'antigravity', 'antigravity', 'Antigravity CLI');
  };

  const saveLocalSettings = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.settings.set('ollama.url', ollamaUrl.trim() || 'http://localhost:11434');
    await window.electronAPI.settings.set('codex.executable', codexExecutable.trim());
    await window.electronAPI.settings.set('codex.timeoutSeconds', Math.max(30, Number(codexTimeoutSeconds || 180)));
    await window.electronAPI.settings.set('claude.executable', claudeExecutable.trim());
    await window.electronAPI.settings.set('antigravity.executable', antigravityExecutable.trim());
    await window.electronAPI.settings.set('antigravity.models', antigravityModelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    await window.electronAPI.settings.set('antigravity.statusJsonPath', antigravityStatusJsonPath.trim());
    await window.electronAPI.settings.set('sshConfig', sshConfig);
    setSshConfig((current) => ({ ...current, password: '', privateKey: '' }));
    await refreshAuthStatus();
    await refreshModels();
  };

  const resetSshFingerprint = async () => {
    if (!window.electronAPI) return;
    const removed = await window.electronAPI.settings.resetSshFingerprint();
    setSshFingerprintStatus(t(removed ? 'auth.sshFingerprintReset' : 'auth.sshFingerprintMissing'));
  };

  const getProviderStatus = (providerId: ProviderType, selectedMethod: AuthMethod) => {
    const auth = authStatus[providerId];
    const cliLabel = providerId === 'anthropic' ? 'claude-cli' : '';
    const hasCliModel = models.some((model) => model.provider === providerId && (model.source === 'cli' || model.id.includes('-cli:')));

    if (selectedMethod === 'browser') {
      if (providerId === 'openai' && chatgptSessionActive) {
        return { online: !chatgptEngine?.lastError, label: chatgptStatusLabel(chatgptEngine, chatgptPlan, t) };
      }
      return { online: false, label: t('auth.notSignedIn') };
    }

    if (selectedMethod === 'cli') {
      const claudeCli = accountStatuses['claude-cli'];
      const cliReady = !!cliLabel && (claudeCli?.authenticated || auth?.label === cliLabel || hasCliModel);
      if (cliReady) return { online: true, label: localizedStatus(claudeCli?.statusLabel, 'auth.cliFoundSignedIn') };
      if (claudeCli?.installed) return { online: false, label: t('auth.cliFoundLoginRequired') };
      return { online: false, label: t('auth.claudeCliNotFound') };
    }

    if (selectedMethod === 'apikey') {
      const apiReady = !!auth?.authenticated && auth.method === 'apikey' && auth.label !== 'claude-cli';
      if (apiReady) return { online: true, label: t('auth.apiKeyConnected') };
      return { online: false, label: t('auth.apiKeyRequired') };
    }

    if (!auth) return { online: false, label: t('auth.notConfigured') };
    if (auth.authenticated) return { online: true, label: localizedStatus(auth.statusLabel, 'auth.connected') };
    return { online: false, label: localizedStatus(auth.statusLabel, 'auth.notConnected') };
  };

  const getSelectedMethod = (providerId: ProviderType): AuthMethod => {
    const preferred = preferredAuthMethod[providerId];
    const card = PROVIDER_CARDS.find((item) => item.id === providerId);
    if (preferred && card?.authOptions.some((option) => option.value === preferred)) return preferred;
    const auth = authStatus[providerId];
    if (providerId === 'openai' && chatgptSessionActive) return 'browser';
    if (auth?.label === 'claude-cli') return 'cli';
    if (auth?.authenticated && auth.method === 'apikey') return 'apikey';
    return card?.authOptions[0]?.value || 'apikey';
  };

  return (
    <div className="settings-page">
      <div className="settings-page-inner">
        <h2 className="settings-title settings-title-clean">
          <SettingsIcon size={22} />
          <FlipText text={t('settings.title')} />
        </h2>

        <div className="settings-search">
          <Search size={16} />
          <input
            type="text"
            placeholder={t('settings.search')}
            value={providerSearch}
            onChange={(e) => setProviderSearch(e.target.value)}
          />
        </div>

        {/* Language */}
        <div className="settings-section" style={{ display: sectionMatches(['taal', 'language', 'nederlands', 'english', 'engels']) ? undefined : 'none' }}>
          <div className="settings-section-title"><FlipText text={t('settings.language')} /></div>
          <div className="settings-row">
            <div className="tabs">
              <button className={`tab ${i18n.language === 'nl' ? 'active' : ''}`} onClick={() => changeLanguage('nl')}>
                <FlipText text="Nederlands" />
              </button>
              <button className={`tab ${i18n.language === 'en' ? 'active' : ''}`} onClick={() => changeLanguage('en')}>
                <FlipText text="English" />
              </button>
            </div>
          </div>
        </div>

        {/* Profile */}
        <div className="settings-section" style={{ display: sectionMatches(['profiel', 'profile', 'avatar', 'afbeelding', 'foto', 'chat-avatar']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.profile.title')}</div>
          <div className="glass-card profile-settings-card">
            <div className={`profile-avatar-preview ${userAvatarDataUrl ? 'has-image' : ''}`}>
              {userAvatarDataUrl
                ? <img src={userAvatarDataUrl} alt={t('settings.profile.yourAvatar')} draggable={false} />
                : <UserRound size={24} />}
            </div>
            <div className="profile-settings-copy">
              <div className="font-semibold">{t('settings.profile.chatAvatar')}</div>
              <div className="text-sm text-muted">
                {t('settings.profile.description')}
              </div>
              {avatarStatus && <div className="text-xs text-muted mt-1">{avatarStatus}</div>}
            </div>
            <div className="profile-settings-actions">
              <label className="btn btn-secondary profile-avatar-upload">
                <ImagePlus size={15} />
                {t('settings.profile.chooseImage')}
                <input type="file" accept="image/*" onChange={chooseUserAvatar} />
              </label>
              <button className="btn btn-secondary" onClick={removeUserAvatar} disabled={!userAvatarDataUrl}>
                <Trash2 size={15} />
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>

        {/* Updates */}
        <div className="settings-section" style={{ display: sectionMatches(['update', 'updates', 'versie', 'version', 'bijwerken', 'app-update']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.updates')}</div>
          <UpdatePanel />
        </div>

        {/* Opstartgids */}
        <div className="settings-section" style={{ display: sectionMatches(['opstartgids', 'gids', 'tutorial', 'onboarding', 'rondleiding', 'welkom']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.onboarding.title')}</div>
          <div className="glass-card">
            <div className="text-sm text-muted mb-3">
              {t('settings.onboarding.description')}
            </div>
            <button className="btn btn-secondary" onClick={requestOnboarding}>
              <Sparkles size={15} /> {t('settings.onboarding.restart')}
            </button>
          </div>
        </div>

        {/* Gesprekstitels */}
        <div className="settings-section" style={{ display: sectionMatches(['gesprekstitels', 'titel', 'title', 'naam', 'auto-naam', 'chat']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.titles.title')}</div>
          <div className="glass-card">
            <div className="text-sm text-muted mb-3">
              {t('settings.titles.description')}
            </div>
            <div style={{ maxWidth: 360 }}>
              <SelectField
                label={t('settings.titles.method')}
                value={chatTitleMode}
                onChange={(value) => { setChatTitleMode(value); window.electronAPI?.settings.set('chat.autoTitleMode', value); }}
                options={[
                  { value: 'ollama', label: 'Ollama', description: t('settings.titles.ollamaDescription') },
                  { value: 'simple', label: t('settings.titles.simple'), description: t('settings.titles.simpleDescription') },
                  { value: 'off', label: t('settings.titles.off'), description: t('settings.titles.offDescription') },
                ]}
              />
            </div>
            {chatTitleMode === 'ollama'
              && (ollamaTitleSetupLoading
                || !!ollamaTitleSetupProgress
                || (ollamaTitleSetup !== null && !ollamaTitleSetup.ready)) && (
                <div
                  className="mt-4"
                  style={{
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${ollamaTitleSetup?.ready ? 'rgba(16, 185, 129, 0.28)' : 'rgba(245, 158, 11, 0.28)'}`,
                    background: ollamaTitleSetup?.ready ? 'rgba(16, 185, 129, 0.06)' : 'rgba(245, 158, 11, 0.06)',
                  }}
                >
                  <div className={`flex items-center gap-2${ollamaTitleSetupProgress?.phase === 'ready' ? '' : ' mb-2'}`}>
                    {ollamaTitleSetup?.ready
                      ? <Check size={16} style={{ color: 'var(--color-success)' }} />
                      : ollamaTitleSetupLoading
                        ? <Loader2 size={16} className="spin" />
                        : <Server size={16} />}
                    <span className="text-sm font-semibold">
                      {ollamaTitleSetup?.ready
                        ? t('settings.titles.readyWith', { model: ollamaTitleSetup.model })
                        : !ollamaTitleSetup
                          ? t('settings.titles.checkingOllama')
                          : ollamaTitleSetup.runtimeAvailable
                            ? t('settings.titles.modelRequired', { model: ollamaTitleSetup.model })
                            : t('settings.titles.ollamaRequired')}
                    </span>
                  </div>
                  {!ollamaTitleSetup?.ready && ollamaTitleSetup && (
                    <p className="text-xs text-muted mb-3">
                      {ollamaTitleSetup.runtimeAvailable
                        ? t('settings.titles.downloadDescription', { model: ollamaTitleSetup.model })
                        : t('settings.titles.installDescription', { model: ollamaTitleSetup.model })}
                    </p>
                  )}
                  {ollamaTitleSetupProgress && ollamaTitleSetupProgress.phase !== 'ready' && (
                    <>
                      <p
                        className="text-xs mb-2"
                        style={{ color: ollamaTitleSetupProgress.phase === 'error' ? 'var(--color-error)' : 'var(--text-muted)' }}
                      >
                        {ollamaTitleProgressLabel(ollamaTitleSetupProgress, t)}
                      </p>
                      {ollamaTitleSetupProgress.percent !== undefined && (
                        <>
                          <div style={{ height: 5, borderRadius: 999, overflow: 'hidden', background: 'rgba(148, 163, 184, 0.14)', marginBottom: 'var(--space-2)' }}>
                            <div
                              style={{
                                width: `${ollamaTitleSetupProgress.percent}%`,
                                height: '100%',
                                background: 'var(--accent-gradient)',
                                transition: 'width var(--transition-fast)',
                              }}
                            />
                          </div>
                          <div className="text-xs text-muted mb-3">
                            {ollamaTitleSetupProgress.percent}%
                            {Number(ollamaTitleSetupProgress.total) > 0
                              ? ` · ${t('settings.titles.downloadedOf', { transferred: formatUpdateBytes(Number(ollamaTitleSetupProgress.transferred) || 0), total: formatUpdateBytes(Number(ollamaTitleSetupProgress.total)) })}`
                              : ''}
                            {Number(ollamaTitleSetupProgress.bytesPerSecond) > 0
                              ? ` · ${formatUpdateBytes(Number(ollamaTitleSetupProgress.bytesPerSecond))}/s`
                              : ''}
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {ollamaTitleSetup && !ollamaTitleSetup.ready && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={installOllamaForTitles}
                      disabled={ollamaTitleSetupLoading}
                    >
                      {ollamaTitleSetupLoading && <Loader2 size={15} className="spin" />}
                      {ollamaTitleSetup.runtimeAvailable
                        ? t('settings.titles.downloadModel', { model: ollamaTitleSetup.model })
                        : t('settings.titles.installWithModel', { model: ollamaTitleSetup.model })}
                    </button>
                  )}
                </div>
              )}
          </div>
        </div>

        {/* Provider Cards */}
        <div className="settings-section" style={{ display: anyProviderMatches ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.providers')}</div>

          {PROVIDER_CARDS.filter((card) => matchProvider(card.label)).map((card) => {
            const selectedMethod = getSelectedMethod(card.id);
            const status = getProviderStatus(card.id, selectedMethod);
            const isExpanded = expandedProvider === card.id;
            const isTesting = testResults[card.id] === 'testing';
            const CardIcon = providerIcon(card.id);

            return (
              <div
                key={card.id}
                className="glass-card mb-4"
                style={{ borderLeft: `3px solid ${card.color}`, transition: 'all var(--transition-normal)' }}
              >
                {/* Header */}
                <div
                  className="flex items-center gap-2"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpandedProvider(isExpanded ? null : card.id)}
                >
                  <span className="provider-card-icon" style={{ color: card.color }}>
                    <CardIcon size={18} />
                  </span>
                  <span className="font-semibold">{card.label}</span>
                  <div style={{ flex: 1 }} />
                  <span
                    className={`status-badge ${status.online ? 'online' : 'offline'}`}
                    style={{ transition: 'all var(--transition-fast)' }}
                  >
                    {isTesting ? t('auth.testing') : status.label}
                  </span>
                  <ChevronDown size={14} style={{ opacity: 0.55, transition: 'transform var(--transition-fast)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }} />
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div style={{ marginTop: 'var(--space-4)', animation: 'fadeIn var(--transition-fast) ease-out' }}>
                    {/* Auth method tabs */}
                    {card.authOptions.length > 1 && (
                      <div style={{ marginBottom: 'var(--space-4)' }}>
                        <div className="settings-row-label mb-2">{t('auth.signInMethod')}</div>
                        <SegmentedControl
                          value={selectedMethod}
                          onChange={(value) => setPreferredAuthMethod(card.id, value)}
                          options={card.authOptions.map((option) => ({
                            value: option.value,
                            label: methodLabel(option.value, card.id, t),
                            icon: option.value === 'browser' ? Globe2 : option.value === 'cli' ? Terminal : KeyRound,
                          }))}
                        />
                      </div>
                    )}

                    {/* ChatGPT Subscription */}
                    {card.id === 'openai' && selectedMethod === 'browser' && (
                      <div className="glass-card" style={{ background: 'rgba(16, 163, 127, 0.05)', border: '1px solid rgba(16, 163, 127, 0.15)' }}>
                        <div className="flex items-center gap-2 mb-3">
                          <Globe2 size={17} />
                          <span className="text-sm font-semibold">ChatGPT Subscription</span>
                          <div style={{ flex: 1 }} />
                          <span className={`status-badge ${chatgptSessionActive && !chatgptEngine?.lastError ? 'online' : 'offline'}`} style={{ fontSize: '0.65rem' }}>
                            {chatgptStatusLabel(chatgptEngine, chatgptPlan, t)}
                          </span>
                        </div>
                        <div className="settings-mini-grid mb-3">
                          <div>
                            <div className="settings-row-label">{t('auth.route')}</div>
                            <div className="text-xs">{t('auth.chatgptWebSession')}</div>
                          </div>
                          <div>
                            <div className="settings-row-label">{t('auth.subscription')}</div>
                            <div className="text-xs">{chatgptPlan || (chatgptSessionActive ? t('common.unknown') : '—')}</div>
                          </div>
                        </div>
                        {chatgptEngine?.lastError && (
                          <div className="text-xs mb-3" style={{ color: 'var(--color-error)' }}>
                            {chatgptEngine.lastError}
                          </div>
                        )}
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-primary"
                            onClick={handleChatGptLogin}
                            disabled={isTesting}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            <Globe2 size={15} />
                             {isTesting ? t('common.loading') : chatgptSessionActive ? t('auth.signInAgain') : t('auth.signIn')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={handleChatGptOpenWindow}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            <Globe2 size={15} />
                             {t('auth.openChatgpt')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={handleChatGptReset}
                            disabled={isTesting}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            <RefreshCw size={15} />
                             {t('auth.resetWebEngine')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => refreshChatGptStatus()}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            <RefreshCw size={15} />
                            {t('common.status')}
                          </button>
                          {chatgptSessionActive && (
                            <button
                              className="btn btn-secondary"
                              onClick={handleChatGptLogout}
                              style={{ fontSize: 'var(--font-size-xs)' }}
                            >
                               {t('auth.signOut')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Claude Code CLI Login */}
                    {card.id === 'anthropic' && selectedMethod === 'cli' && (
                      <div className="glass-card" style={{ background: 'rgba(212, 165, 116, 0.05)', border: '1px solid rgba(212, 165, 116, 0.15)' }}>
                        <div className="flex items-center gap-2 mb-3">
                          <Terminal size={17} />
                          <span className="text-sm font-semibold">Claude Code CLI</span>
                        </div>
                        <p className="text-xs text-muted mb-3">
                          {t('settings.cli.claudeDescription')}
                        </p>
                        <CliPathFields
                          detectedPath={accountStatuses['claude-cli']?.executablePath}
                          manualPath={claudeExecutable}
                          placeholder="%USERPROFILE%\.local\bin\claude.exe"
                          onManualPathChange={setClaudeExecutable}
                        />
                        <div className="flex gap-2">
                          <button
                            className="btn btn-primary"
                            onClick={handleClaudeCliLogin}
                            disabled={isTesting}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            {isTesting
                              ? t('common.pleaseWait')
                              : accountStatuses['claude-cli']?.installed
                                ? t('settings.cli.open', { name: 'Claude CLI' })
                                : t('settings.cli.install', { name: 'Claude CLI' })}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => { testProvider('anthropic'); }}
                            disabled={isTesting}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            <RefreshCw size={14} />
                            {t('common.refresh')}
                          </button>
                        </div>
                        {cliActionMessages.claude && <p className="text-xs text-muted mt-3">{cliActionMessages.claude}</p>}
                      </div>
                    )}

                    {/* API Key input */}
                    {selectedMethod === 'apikey' && card.apiKeyPlaceholder && (
                      <div style={{ marginTop: card.authOptions.length > 1 ? 'var(--space-3)' : 0 }}>
                        <div className="settings-row-label mb-2">{t('auth.apiKey')}</div>
                        <div className="flex gap-2">
                          <input
                            className="input flex-1"
                            type="password"
                            placeholder={card.apiKeyPlaceholder}
                            value={keys[card.id] || ''}
                            onChange={(e) => setKeys((prev) => ({ ...prev, [card.id]: e.target.value }))}
                          />
                          <button className="btn btn-secondary" onClick={() => saveKey(card.id)} disabled={!keys[card.id]}>
                            {t('auth.save')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => testProvider(card.id)}
                            disabled={isTesting}
                          >
                            {isTesting ? t('auth.testing') : t('auth.test')}
                          </button>
                        </div>
                        {card.id === 'google' && (
                          <div className="glass-card mt-3" style={{ background: 'rgba(66, 133, 244, 0.05)', border: '1px solid rgba(66, 133, 244, 0.18)' }}>
                            <div className="flex items-center gap-2 mb-2">
                              <LockKeyhole size={16} />
                              <span className="text-sm font-semibold">{t('settings.gemini.requiredCloudQuota')}</span>
                              <div style={{ flex: 1 }} />
                              <span className={`status-badge ${geminiQuotaStatus?.connected ? 'online' : 'offline'}`}>
                                {geminiQuotaStatus?.connected ? t('auth.connected') : t('auth.connectRequired')}
                              </span>
                            </div>
                            <p className="text-xs text-muted mb-3">
                              {t('settings.gemini.quotaDescription')}
                            </p>
                            <div className="settings-mini-grid mb-3">
                              <label>
                                <span className="settings-row-label">{t('settings.gemini.projectId')}</span>
                                <input className="input" value={geminiProjectId} onChange={(event) => setGeminiProjectId(event.target.value)} placeholder="mijn-gemini-project" />
                              </label>
                              <label>
                                <span className="settings-row-label">{t('settings.gemini.oauthClientId')}</span>
                                <input className="input" value={geminiOauthClientId} onChange={(event) => setGeminiOauthClientId(event.target.value)} placeholder="...apps.googleusercontent.com" />
                              </label>
                            </div>
                            {geminiQuotaStatus?.error && <p className="text-xs mb-3" style={{ color: 'var(--color-error)' }}>{geminiQuotaStatus.error}</p>}
                            <div className="flex gap-2">
                              <button className="btn btn-primary" onClick={connectGeminiQuota} disabled={geminiQuotaLoading || !geminiProjectId || !geminiOauthClientId}>
                                {geminiQuotaLoading && <Loader2 size={14} className="spin" />}
                                {geminiQuotaStatus?.connected ? t('settings.gemini.reconnect') : t('settings.gemini.connect')}
                              </button>
                              {geminiQuotaStatus?.connected && <button className="btn btn-secondary" onClick={disconnectGeminiQuota}>{t('settings.gemini.disconnect')}</button>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {matchProvider('Codex CLI') && (
            <div className="glass-card mb-4" style={{ borderLeft: '3px solid #00a67e' }}>
              <div className="flex items-center gap-2" style={{ cursor: 'pointer' }} onClick={() => setExpandedProvider(expandedProvider === 'codex' ? null : 'codex')}>
                <Terminal size={18} />
                <span className="font-semibold">Codex CLI</span>
                <div style={{ flex: 1 }} />
                <span className={`status-badge ${authStatus.codex?.authenticated ? 'online' : 'offline'}`}>
                  {localizedStatus(authStatus.codex?.statusLabel, authStatus.codex?.authenticated ? 'auth.cliFound' : 'auth.cliAuthRequired')}
                </span>
                <ChevronDown size={14} style={{ opacity: 0.55, transition: 'transform var(--transition-fast)', transform: expandedProvider === 'codex' ? 'rotate(180deg)' : 'rotate(0)' }} />
              </div>

              {expandedProvider === 'codex' && (
                <div style={{ marginTop: 'var(--space-4)', animation: 'fadeIn var(--transition-fast) ease-out' }}>
                  <p className="text-xs text-muted mb-3">
                    {t('settings.cli.codexDescription')}
                  </p>
                  <p className="text-xs text-muted mb-3">
                    {t('settings.cli.codexRunConfigHint')}
                  </p>
                  <CliPathFields
                    detectedPath={accountStatuses.codex?.executablePath}
                    manualPath={codexExecutable}
                    placeholder="%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe"
                    onManualPathChange={setCodexExecutable}
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
                    <div>
                      <div className="settings-row-label mb-2">{t('settings.cli.timeoutSeconds')}</div>
                      <input className="input" type="number" min={30} max={900} value={codexTimeoutSeconds} onChange={(e) => setCodexTimeoutSeconds(Number(e.target.value))} />
                    </div>
                  </div>

                  <div className="flex gap-2 mt-4">
                    <button
                      className="btn btn-primary"
                      onClick={async () => { await saveLocalSettings(); await handleCodexCliLogin(); }}
                      disabled={testResults.codex === 'testing'}
                    >
                      {testResults.codex === 'testing'
                        ? t('common.pleaseWait')
                        : accountStatuses.codex?.installed
                          ? t('settings.cli.openLogin', { name: 'Codex' })
                          : t('settings.cli.install', { name: 'Codex CLI' })}
                    </button>
                    <button className="btn btn-secondary" onClick={saveLocalSettings}><Save size={15} /> {t('common.save')}</button>
                    <button
                      className="btn btn-secondary"
                      onClick={async () => { await saveLocalSettings(); await testProvider('codex'); }}
                      disabled={testResults.codex === 'testing'}
                    >
                      {testResults.codex === 'testing' ? t('auth.testing') : t('auth.test')}
                    </button>
                  </div>
                  {cliActionMessages.codex && <p className="text-xs text-muted mt-3">{cliActionMessages.codex}</p>}
                </div>
              )}
            </div>
          )}

          {matchProvider('Antigravity CLI') && (
            <div className="glass-card mb-4">
              <div className="flex items-center gap-2" style={{ cursor: 'pointer' }} onClick={() => setExpandedProvider(expandedProvider === 'antigravity' ? null : 'antigravity')}>
                <Rocket size={18} />
                <span className="font-semibold">Antigravity CLI</span>
                <div style={{ flex: 1 }} />
                <span className={`status-badge ${accountStatuses.antigravity?.authenticated ? 'online' : 'offline'}`}>
                  {localizedStatus(accountStatuses.antigravity?.statusLabel, accountStatuses.antigravity?.installed ? 'auth.cliFoundLoginRequired' : 'auth.cliNotFound')}
                </span>
                <ChevronDown size={14} style={{ opacity: 0.55, transition: 'transform var(--transition-fast)', transform: expandedProvider === 'antigravity' ? 'rotate(180deg)' : 'rotate(0)' }} />
              </div>
              {expandedProvider === 'antigravity' && (
                <div style={{ marginTop: 'var(--space-4)', animation: 'fadeIn var(--transition-fast) ease-out' }}>
                  <p className="text-xs text-muted mb-3">
                    {t('settings.cli.antigravityDescription')}
                  </p>
                  <CliPathFields
                    detectedPath={accountStatuses.antigravity?.executablePath}
                    manualPath={antigravityExecutable}
                    placeholder="%LOCALAPPDATA%\agy\bin\agy.exe"
                    onManualPathChange={setAntigravityExecutable}
                  />
                  <div className="flex gap-2">
                    <button
                      className="btn btn-primary"
                      onClick={handleAntigravityCliLogin}
                      disabled={testResults.antigravity === 'testing'}
                    >
                      {testResults.antigravity === 'testing'
                        ? t('common.pleaseWait')
                        : accountStatuses.antigravity?.installed
                          ? t('settings.cli.open', { name: 'Antigravity CLI' })
                          : t('settings.cli.install', { name: 'Antigravity CLI' })}
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={async () => { await saveLocalSettings(); await testProvider('antigravity'); }}
                      disabled={testResults.antigravity === 'testing'}
                    >
                      <RefreshCw size={14} />
                      {t('common.refresh')}
                    </button>
                  </div>
                  {cliActionMessages.antigravity && <p className="text-xs text-muted mt-3">{cliActionMessages.antigravity}</p>}
                </div>
              )}
            </div>
          )}

          {matchProvider('Ollama') && (
            <div className="glass-card mb-4">
              <div className="flex items-center gap-2" style={{ cursor: 'pointer' }} onClick={() => setExpandedProvider(expandedProvider === 'ollama' ? null : 'ollama')}>
                <Server size={18} />
                <span className="font-semibold">Ollama</span>
                <div style={{ flex: 1 }} />
                <span className={`status-badge ${authStatus.ollama?.authenticated ? 'online' : 'offline'}`}>
                  {localizedStatus(authStatus.ollama?.statusLabel, authStatus.ollama?.authenticated ? 'models.online' : 'models.offline')}
                </span>
                <ChevronDown size={14} style={{ opacity: 0.55, transition: 'transform var(--transition-fast)', transform: expandedProvider === 'ollama' ? 'rotate(180deg)' : 'rotate(0)' }} />
              </div>
              {expandedProvider === 'ollama' && (
                <div style={{ marginTop: 'var(--space-4)', animation: 'fadeIn var(--transition-fast) ease-out' }}>
                  <div className="settings-row-label mb-2">{t('settings.ollama.localUrl')}</div>
                  <input className="input mb-4" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />

                  <OllamaModelManager
                    configuredUrl={ollamaUrl.trim() || 'http://localhost:11434'}
                    onProviderChanged={async () => {
                      await refreshAuthStatus();
                      setProviderModels('ollama', await window.electronAPI.providers.listModels('ollama'));
                      const titleStatus = await window.electronAPI.chat.getTitleOllamaStatus();
                      if (settingsMountedRef.current) setOllamaTitleSetup(titleStatus);
                    }}
                  />

                  <div className="settings-row-label mb-2" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <LockKeyhole size={15} /> {t('settings.ollama.remoteViaSsh')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-2)' }}>
                    <input className="input" placeholder={t('auth.sshHost')} value={sshConfig.host} onChange={(e) => setSshConfig((s) => ({ ...s, host: e.target.value }))} />
                    <input className="input" placeholder={t('auth.sshPort')} value={sshConfig.port} onChange={(e) => setSshConfig((s) => ({ ...s, port: e.target.value }))} />
                    <input className="input" placeholder={t('auth.sshUser')} value={sshConfig.user} onChange={(e) => setSshConfig((s) => ({ ...s, user: e.target.value }))} />
                    <input className="input" type="password" placeholder={t('auth.sshPassword')} value={sshConfig.password} onChange={(e) => setSshConfig((s) => ({ ...s, password: e.target.value }))} />
                    <textarea
                      className="input"
                      rows={3}
                      placeholder={t('auth.sshPrivateKey')}
                      value={sshConfig.privateKey}
                      onChange={(e) => setSshConfig((s) => ({ ...s, privateKey: e.target.value }))}
                      style={{ gridColumn: '1 / -1', resize: 'vertical' }}
                    />
                    <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <button type="button" className="btn btn-ghost" onClick={resetSshFingerprint} disabled={!sshConfig.host.trim()}>
                        {t('auth.sshResetFingerprint')}
                      </button>
                      {sshFingerprintStatus && <span className="text-xs text-muted">{sshFingerprintStatus}</span>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {(matchProvider('Antigravity CLI') || matchProvider('Ollama')) && (
            <button className="btn btn-primary" onClick={saveLocalSettings}><Save size={15} /> {t('settings.saveLocalProviders')}</button>
          )}
        </div>

        {/* Agent PC access */}
        <div className="settings-section" style={{ display: sectionMatches(['pc-toegang', 'pc', 'toegang', 'agent', 'shell', 'commando', 'command', 'goedkeuring', 'approval', 'werkmap', 'tools']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.agent.title')}</div>
          <div className="glass-card">
            <div className="text-sm text-muted mb-2">
              {t('settings.agent.description')}
            </div>
            <label className="settings-row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              <input type="checkbox" checked={agentToolsEnabled} onChange={(e) => toggleAgentTools(e.target.checked)} />
              <span className="text-sm">{t('settings.agent.enableToolsPrefix')} <code>&lt;file-read&gt;</code>, <code>&lt;file-create&gt;</code>, <code>&lt;file-edit&gt;</code> {t('settings.agent.enableToolsAnd')} <code>&lt;run-command&gt;</code>{t('settings.agent.enableToolsSuffix')}</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
              <SelectField
                label={t('settings.agent.approval')}
                value={agentMode}
                onChange={(value) => saveAgentConfig(value, agentWorkingDir)}
                options={[
                  { value: 'ask', label: t('settings.agent.askEachAction'), description: t('settings.agent.askEachActionDescription') },
                  { value: 'auto-project', label: t('settings.agent.autoProject'), description: t('settings.agent.autoProjectDescription') },
                  { value: 'full', label: t('settings.agent.fullAccess'), description: t('settings.agent.fullAccessDescription') },
                ]}
              />
              <SelectField
                label={t('settings.agent.defaultShell')}
                value={agentDefaultShell}
                onChange={(value) => saveAgentConfig(agentMode, agentWorkingDir, value as AgentShell)}
                options={[
                  { value: 'powershell', label: 'PowerShell', description: t('settings.agent.standardWindowsPowershell') },
                  { value: 'cmd', label: 'Cmd', description: 'Windows Command Prompt' },
                  { value: 'pwsh', label: 'PowerShell 7', description: t('settings.agent.pwshOnlyIfInstalled') },
                ]}
              />
              <div>
                <label className="text-xs text-muted">{t('settings.agent.fallbackWorkingDirectory')}</label>
                <input
                  className="input mt-2"
                  placeholder={t('settings.agent.workingDirectoryPlaceholder')}
                  value={agentWorkingDir}
                  onChange={(e) => setAgentWorkingDir(e.target.value)}
                  onBlur={() => saveAgentConfig(agentMode, agentWorkingDir, agentDefaultShell)}
                />
              </div>
            </div>
            <div style={{ marginTop: 'var(--space-3)' }}>
              <label className="text-xs text-muted">{t('settings.agent.testCommand')}</label>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <input
                  className="input"
                  placeholder={t('settings.agent.testCommandPlaceholder')}
                  value={agentTestCmd}
                  onChange={(e) => setAgentTestCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runAgentTest(); }}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-secondary" onClick={runAgentTest} disabled={agentRunning || !agentTestCmd.trim()}>
                  <Terminal size={15} /> {agentRunning ? t('common.running') : t('settings.agent.run')}
                </button>
              </div>
              {agentTestOutput != null && (
                <pre style={{ marginTop: 'var(--space-2)', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: 'var(--space-2)', borderRadius: 'var(--radius-md)' }}>
                  {agentTestOutput || t('settings.agent.noOutput')}
                </pre>
              )}
            </div>
          </div>
        </div>

        {/* Fallback chain */}
        <div className="settings-section" style={{ display: sectionMatches(['fallback', 'terugval', 'auto-switch', 'switch', 'keten']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.fallback')}</div>
          <FallbackChain />
        </div>

        {/* Discovered Models */}
        <div className="settings-section" style={{ display: sectionMatches(['ontdekte', 'modellen', 'models', 'discovered', 'refresh', 'model']) ? undefined : 'none' }}>
          <div className="settings-section-title">{t('settings.discoveredModels')}</div>
          <div className="glass-card">
            <div className="text-sm text-muted mb-2">{t('settings.modelsAvailable', { count: models.length })}</div>
            <button className="btn btn-secondary" onClick={refreshModels}><RefreshCw size={15} /> {t('settings.refreshModels')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

function resizeAvatarImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Kon afbeelding niet lezen.'));
    reader.onload = () => {
      const image = new window.Image();
      image.onerror = () => reject(new Error('Kon afbeelding niet laden.'));
      image.onload = () => {
        const size = Math.min(image.width, image.height);
        const sourceX = Math.max(0, (image.width - size) / 2);
        const sourceY = Math.max(0, (image.height - size) / 2);
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 160;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas niet beschikbaar.'));
          return;
        }
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, sourceX, sourceY, size, size, 0, 0, 160, 160);
        resolve(canvas.toDataURL('image/png'));
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

function normalizeLiveChoice(value: unknown): string {
  if (typeof value !== 'string') return '';
  const choice = value.trim();
  return /^[a-z][a-z0-9._-]*$/i.test(choice) ? choice : '';
}

function parseRunConfig(text: string): ModelRunConfig | undefined {
  if (!text) return undefined;
  const runConfig: ModelRunConfig = {};
  for (const part of text.split(/\s+/)) {
    const [key, value] = part.split('=');
    if ((key === 'effort' || key === 'reasoning') && normalizeLiveChoice(value)) {
      runConfig.reasoningEffort = normalizeLiveChoice(value);
    }
    if ((key === 'tier' || key === 'service') && normalizeLiveChoice(value)) {
      runConfig.serviceTier = normalizeLiveChoice(value);
    }
  }
  return Object.keys(runConfig).length ? runConfig : undefined;
}

function ollamaTitleProgressLabel(
  progress: OllamaTitleSetupProgress,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (progress.phase === 'checking') return t('settings.titles.progress.checking');
  if (progress.phase === 'downloading-runtime') return t('settings.titles.progress.downloadingRuntime');
  if (progress.phase === 'verifying-runtime') return t('settings.titles.progress.verifyingRuntime');
  if (progress.phase === 'installing-runtime') return t('settings.titles.progress.installingRuntime');
  if (progress.phase === 'starting-runtime') return t('settings.titles.progress.startingRuntime');
  if (progress.phase === 'downloading-model') {
    return t('settings.titles.progress.downloadingModel', { model: progress.model });
  }
  if (progress.phase === 'error') {
    return t('settings.titles.progress.errorDetail', { detail: progress.status });
  }
  return t('settings.titles.readyWith', { model: progress.model });
}

function normalizeChatTitleMode(value: unknown) {
  return value === 'simple' || value === 'off' ? value : 'ollama';
}

function CliPathFields({
  detectedPath,
  manualPath,
  placeholder,
  onManualPathChange,
}: {
  detectedPath?: string;
  manualPath: string;
  placeholder: string;
  onManualPathChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="settings-row-label mb-2">{t('settings.cli.detectedPath')}</div>
      <div className="cli-path-display mb-3" title={detectedPath || ''}>
        {detectedPath || t('settings.cli.notFoundYet')}
      </div>
      <div className="settings-row-label mb-2">{t('settings.cli.manualPathOptional')}</div>
      <input
        className="input mb-3"
        placeholder={placeholder}
        value={manualPath}
        onChange={(event) => onManualPathChange(event.target.value)}
      />
    </>
  );
}

function formatRunConfig(runConfig?: ModelRunConfig) {
  if (!runConfig) return '';
  const parts: string[] = [];
  if (runConfig.reasoningEffort) parts.push(`effort=${runConfig.reasoningEffort}`);
  if (runConfig.serviceTier) parts.push(`tier=${runConfig.serviceTier}`);
  return parts.join(' ');
}

function providerIcon(provider: ProviderType) {
  if (provider === 'openai') return Sparkles;
  if (provider === 'anthropic') return Bot;
  if (provider === 'google') return Sparkles;
  if (provider === 'codex') return Terminal;
  if (provider === 'ollama') return Server;
  if (provider === 'antigravity') return Rocket;
  return LockKeyhole;
}

function methodLabel(method: AuthMethod, provider: ProviderType | undefined, t: ReturnType<typeof useTranslation>['t']) {
  if (method === 'browser') return provider === 'openai' ? 'ChatGPT Subscription' : t('auth.browserSession');
  if (method === 'cli') return 'CLI';
  if (method === 'apikey') return provider === 'openai' ? 'OpenAI API' : 'API key';
  return method;
}

function chatgptStatusLabel(
  engine: ChatGptEngineState | null,
  plan: string | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (!engine?.active) return t('auth.notSignedIn');
  if (engine.lastError && /niet ingelogd|not signed in/i.test(engine.lastError)) return t('auth.notSignedIn');
  if (engine.lastError && engine.recoverable) return t('auth.recoveryRequired');
  if (engine.lastError) return t('auth.stalled');
  return plan ? t('auth.webSessionActivePlan', { plan }) : t('auth.webSessionActive');
}

export default Settings;
