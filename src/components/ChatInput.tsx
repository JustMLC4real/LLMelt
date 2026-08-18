import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, FileText, Loader2, Paperclip, Pause, Play, Send, Settings2, Shield, ShieldAlert, ShieldCheck, Sparkles, Square, Terminal, X } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import ModelSelector from './ModelSelector';
import type { AgentApprovalMode, AttachmentRef, Message, NativeProviderCommand, ReasoningEffort, TokenDashboard } from '../providers/types';
import { mergeUsageSources } from '../providers/token-usage';
import { codexEffortForModel, codexRunConfig, modelDisplayName, providerLabel } from './model-utils';
import { IconButton, ProviderBadge, QuotaBadge, SelectField } from './ui';
import {
  applyCommandPreset,
  clearCommandConfig,
  commandMessageText,
  composerCommandPreset,
  commandLabel,
  commandLanguage,
  commandPresetMatchesQuery,
  commandPresetsForModel,
  hasSelectableNativeRunControls,
  nativeRunControls,
  nativeCommandPresets,
  parseCommandInput,
  type CommandPreset,
  type CommandPresetId,
} from './command-presets';
import { COMPOSER_FOCUS_EVENT } from './composer-focus';
import { deferredAgentApprovalsForChat, type QueuedAgentApproval } from './approval-queue';
import { chatScopedList } from './chat-scope';
import { shouldAcceptOwnedRequestEvent } from './command-run-utils';
import { shouldApplyChatRunResult } from './chat-run-state';
import { chatFromVisibleOrDraft } from './draft-chat';
import { ensureChatMaterialized, isDraftChatId } from './new-chat';
import { usePanelPresence } from './use-panel-presence';
import { requestUtilityPanelToggle } from './utility-panels';
import { normalizeUiLanguage } from '../i18n/language';

const AGENT_MODE_OPTIONS: Array<{ value: AgentApprovalMode; descriptionKey: string }> = [
  { value: 'ask', descriptionKey: 'chat.access.askDescription' },
  { value: 'auto-project', descriptionKey: 'chat.access.autoProjectDescription' },
  { value: 'full', descriptionKey: 'chat.access.fullDescription' },
];

function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return value === 'ask' || value === 'auto-project' || value === 'full';
}

function approvalModeMeta(mode: AgentApprovalMode, t: ReturnType<typeof useTranslation>['t']) {
  if (mode === 'full') {
    return { label: t('chat.access.full'), shortLabel: t('chat.access.full'), tone: 'danger', Icon: ShieldAlert };
  }
  if (mode === 'auto-project') {
    return { label: t('chat.access.autoProject'), shortLabel: t('chat.access.autoProject'), tone: 'warn', Icon: ShieldCheck };
  }
  return { label: t('chat.access.ask'), shortLabel: t('chat.access.askShort'), tone: 'safe', Icon: Shield };
}

interface ChatInputProps {
  approvals: QueuedAgentApproval[];
  onRespondApproval: (approval: QueuedAgentApproval, approved: boolean) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({ approvals, onRespondApproval }) => {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState(() => {
    const id = useChatStore.getState().currentChatId;
    return id ? (useChatStore.getState().messageDrafts[id] ?? '') : '';
  });
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showRunSettings, setShowRunSettings] = useState(false);
  const [showAccessMenu, setShowAccessMenu] = useState(false);
  const [defaultAgentMode, setDefaultAgentMode] = useState<AgentApprovalMode>('ask');
  const [agentToolsEnabled, setAgentToolsEnabled] = useState(false);
  const [contextUsage, setContextUsage] = useState<TokenDashboard['context'] | null>(null);
  const [composerError, setComposerError] = useState('');
  const [nativeCommands, setNativeCommands] = useState<NativeProviderCommand[]>([]);
  const [nativeCommandsLoading, setNativeCommandsLoading] = useState(false);
  const [pendingCommandId, setPendingCommandId] = useState<CommandPresetId | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const runSettingsRef = useRef<HTMLDivElement>(null);
  const pendingCommandByChatRef = useRef(new Map<string, CommandPresetId>());
  const accessMenuPresence = usePanelPresence(showAccessMenu);
  const runSettingsPresence = usePanelPresence(showRunSettings);
  // De store-update volgt pas bij de volgende render. Deze map voorkomt een dubbele
  // Enter in dezelfde chat, maar laat een andere chat wel onafhankelijk starten.
  const requestInFlightByChatRef = useRef(new Map<string, string>());
  const {
    chatRuns,
    chats,
    draftChats,
    currentChatId,
    messages,
    activeModelId,
    activeProvider,
    activeRunConfig,
    setActiveRunConfig,
    setMessageDraft,
    pendingAttachmentsByChat,
    setPendingAttachmentsForChat,
    updateChat,
    addMessage,
    confirmPersistedUserMessage,
    setMessagesForChat,
    startChatRun,
    setChatRunStatus,
    appendChatRunContent,
    setChatRunModel,
    finishChatRun,
    clearLiveToolStateForChat,
  } = useChatStore();
  const {
    models,
    isRefreshingModels,
    autoModeStatus,
    autoModeChatId,
    autoModeIteration,
    autoModeMaxIterations,
    autoModeDetail,
    autoModePhase,
    autoModeLastPromptPreview,
    setAutoModeState,
  } = useProviderStore();
  const currentChat = chatFromVisibleOrDraft(chats, draftChats, currentChatId);
  const attachments = useMemo(
    () => chatScopedList(pendingAttachmentsByChat, currentChatId),
    [pendingAttachmentsByChat, currentChatId],
  );
  const setChatAttachments = useCallback((chatId: string, update: React.SetStateAction<AttachmentRef[]>) => {
    setPendingAttachmentsForChat(chatId, update);
  }, [setPendingAttachmentsForChat]);
  const currentRun = currentChatId ? chatRuns[currentChatId] : undefined;
  const isStreaming = !!currentRun;
  const activeRequestId = currentRun?.requestId || null;
  const deferredApprovals = useMemo(
    () => deferredAgentApprovalsForChat(approvals, currentChatId),
    [approvals, currentChatId],
  );
  const deferredApproval = deferredApprovals[0];
  const autoModeForCurrentChat = !!currentChatId
    && autoModeChatId === currentChatId
    && (autoModeStatus === 'running' || autoModeStatus === 'paused');

  const updateAutoMode = useCallback(async (action: 'pause' | 'resume' | 'stop') => {
    const api = window.electronAPI?.autoMode;
    if (!api) return;
    const state = action === 'pause'
      ? await api.pause()
      : action === 'resume'
        ? await api.resume()
        : await api.stop();
    if (state) setAutoModeState(state);
  }, [setAutoModeState]);

  // Zet de invoer én bewaar 'm als concept voor deze chat, zodat je tekst
  // niet verdwijnt als je naar instellingen of een andere chat gaat.
  const setInputValue = useCallback((value: string) => {
    setInput(value);
    if (currentChatId) setMessageDraft(currentChatId, value);
  }, [currentChatId, setMessageDraft]);

  // Wissel je van chat, laad dan het bewaarde concept van die chat.
  const draftChatIdRef = useRef(currentChatId);
  useLayoutEffect(() => {
    if (draftChatIdRef.current === currentChatId) return;
    draftChatIdRef.current = currentChatId;
    setInput(currentChatId ? (useChatStore.getState().messageDrafts[currentChatId] ?? '') : '');
  }, [currentChatId]);

  // Groei/krimp de textarea mee met de inhoud. Draait op élke wijziging van `input`
  // — dus ook als 'ie leeggemaakt wordt na versturen, of als je tekst weghaalt — zodat
  // 'ie altijd netjes terugkrimpt i.p.v. groot te blijven staan. useLayoutEffect meet
  // en zet de hoogte vóór de paint, dus geen zichtbare sprong tijdens typen.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);
  const chatAgentMode = currentChat?.agentMode || null;
  const effectiveAgentMode = chatAgentMode || defaultAgentMode;
  const accessMeta = approvalModeMeta(effectiveAgentMode, t);
  const activeModel = models.find((model) => model.provider === activeProvider && model.id === activeModelId);
  const activeCommandLanguage = commandLanguage(i18n.resolvedLanguage || i18n.language);
  const llmeltCommandPresets = useMemo(
    () => commandPresetsForModel(activeCommandLanguage, activeProvider, activeModel),
    [activeCommandLanguage, activeModel, activeProvider],
  );
  const providerCommandPresets = useMemo(() => nativeCommandPresets(nativeCommands), [nativeCommands]);
  const providerRunActions = useMemo(
    () => providerCommandPresets.filter((preset) => preset.nativeCommand?.kind !== 'skill'),
    [providerCommandPresets],
  );
  const commandPresets = useMemo(
    () => [...providerCommandPresets, ...llmeltCommandPresets],
    [llmeltCommandPresets, providerCommandPresets],
  );
  const runControls = useMemo(() => nativeRunControls(activeModel), [activeModel]);
  const hasNativeRunSettings = useMemo(
    () => hasSelectableNativeRunControls(activeModel) || nativeCommands.length > 0,
    [activeModel, nativeCommands.length],
  );
  const baseModelLabel = modelDisplayName(activeModel, normalizeUiLanguage(i18n.resolvedLanguage || i18n.language)) || activeModelId || t('models.noModel');
  // For ChatGPT, also show the chosen Inspanning (e.g. "Langer") in the label.
  const chatgptEffortValue = activeProvider === 'openai' && activeModelId.startsWith('chatgpt:') ? activeRunConfig?.chatgptThinkingEffort : undefined;
  const chatgptEffortLabel = chatgptEffortValue
    ? (activeModel?.chatgptThinkingEfforts?.find((e) => e.value === chatgptEffortValue)?.label || chatgptEffortValue)
    : '';
  const activeModelLabel = chatgptEffortLabel ? `${baseModelLabel} · ${chatgptEffortLabel}` : baseModelLabel;
  const activeEffort = activeProvider === 'codex'
    ? codexEffortForModel(activeModel, activeRunConfig?.reasoningEffort) || ''
    : activeRunConfig?.reasoningEffort
      || '';
  const slashInput = input.trimStart();
  const commandMatches = useMemo(() => {
    if (!slashInput.startsWith('/')) return [];
    const query = slashInput.slice(1).toLowerCase();
    if (query.includes(' ')) return [];
    return commandPresets.filter((preset) => commandPresetMatchesQuery(preset, query));
  }, [commandPresets, slashInput]);

  const selectedCommandPreset = composerCommandPreset(
    commandPresets,
    activeRunConfig?.commandPresetId,
    pendingCommandId,
  );
  const activeCommandLabel = selectedCommandPreset?.label
    || commandLabel(activeRunConfig?.commandPresetId, activeCommandLanguage);
  const ActiveCommandIcon = selectedCommandPreset?.icon;

  const setPendingCommandForCurrentChat = useCallback((id: CommandPresetId | null) => {
    if (currentChatId) {
      if (id) pendingCommandByChatRef.current.set(currentChatId, id);
      else pendingCommandByChatRef.current.delete(currentChatId);
    }
    setPendingCommandId(id);
  }, [currentChatId]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadAgentConfig = async () => {
      const config = await window.electronAPI?.agent.getConfig();
      if (cancelled || !config) return;
      setDefaultAgentMode(isAgentApprovalMode(config.mode) ? config.mode : 'ask');
      setAgentToolsEnabled(!!config.toolsEnabled);
    };
    loadAgentConfig().catch(() => {});
    window.addEventListener('focus', loadAgentConfig);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', loadAgentConfig);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadNativeCommands = async () => {
      if (!activeModelId || !window.electronAPI?.providers?.listNativeCommands) {
        setNativeCommands([]);
        return;
      }
      setNativeCommandsLoading(true);
      try {
        const commands = await window.electronAPI.providers.listNativeCommands({
          chatId: currentChatId || undefined,
          modelRef: { provider: activeProvider, modelId: activeModelId },
          language: normalizeUiLanguage(i18n.resolvedLanguage || i18n.language),
        });
        if (!cancelled) setNativeCommands(Array.isArray(commands) ? commands : []);
      } catch {
        if (!cancelled) setNativeCommands([]);
      } finally {
        if (!cancelled) setNativeCommandsLoading(false);
      }
    };
    void loadNativeCommands();
    return () => { cancelled = true; };
  }, [activeModelId, activeProvider, currentChatId, i18n.language, i18n.resolvedLanguage]);

  useEffect(() => {
    focusComposer();
  }, [currentChatId, focusComposer]);

  useEffect(() => {
    if (!currentChatId) return;
    focusComposer();
  }, [currentChatId, focusComposer, isStreaming]);

  useEffect(() => {
    const handleFocusComposer = () => focusComposer();
    window.addEventListener(COMPOSER_FOCUS_EVENT, handleFocusComposer);
    return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, handleFocusComposer);
  }, [focusComposer]);

  useEffect(() => {
    setShowAccessMenu(false);
    setShowRunSettings(false);
    setPendingCommandId(currentChatId ? pendingCommandByChatRef.current.get(currentChatId) || null : null);
  }, [currentChatId]);

  useEffect(() => {
    if (!hasNativeRunSettings && showRunSettings) setShowRunSettings(false);
  }, [hasNativeRunSettings, showRunSettings]);

  useEffect(() => {
    if (!showAccessMenu && !showRunSettings) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || accessMenuRef.current?.contains(target) || runSettingsRef.current?.contains(target)) return;
      setShowAccessMenu(false);
      setShowRunSettings(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowAccessMenu(false);
      setShowRunSettings(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showAccessMenu, showRunSettings]);

  const saveChatAgentMode = useCallback(async (mode: AgentApprovalMode | null) => {
    if (!currentChatId) return;
    updateChat(currentChatId, { agentMode: mode });
    if (isDraftChatId(currentChatId)) {
      setShowAccessMenu(false);
      return;
    }
    try {
      const saved = await window.electronAPI?.db.updateChat(currentChatId, { agentMode: mode });
      if (saved) updateChat(currentChatId, { agentMode: saved.agentMode || null });
    } catch {
      updateChat(currentChatId, { agentMode: currentChat?.agentMode || null });
    } finally {
      setShowAccessMenu(false);
    }
  }, [currentChat?.agentMode, currentChatId, updateChat]);

  useEffect(() => {
    let cancelled = false;
    const loadContext = async () => {
      if (!window.electronAPI || !currentChatId || !activeModelId || isDraftChatId(currentChatId)) {
        setContextUsage(null);
        return;
      }
      const context = await window.electronAPI.tokens.getContextUsage(currentChatId, {
        provider: activeProvider,
        modelId: activeModelId,
        runConfig: activeRunConfig,
      });
      if (!cancelled) setContextUsage(context);
    };
    loadContext().catch(() => {
      if (!cancelled) setContextUsage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentChatId, activeModelId, activeProvider, activeRunConfig, messages.length, isStreaming]);

  const reloadMessages = useCallback(async (chatId: string, requestId: string) => {
    if (!window.electronAPI) return;
    const nextMessages = await window.electronAPI.db.getMessages(chatId);
    // Naast chat-eigendom moet ook de beurt nog actueel zijn. Na Stop kan al een
    // nieuwe beurt lopen; een late reload van de oude mag diens optimistische
    // gebruikersbericht dan niet uit de zichtbare lijst wissen.
    if (!shouldApplyChatRunResult(useChatStore.getState().chatRuns, chatId, requestId)) return;
    setMessagesForChat(chatId, nextMessages);
  }, [setMessagesForChat]);

  const applyPreset = useCallback((preset: CommandPreset, args = '') => {
    const next = applyCommandPreset(preset, activeProvider, activeModel, activeRunConfig, args);
    setActiveRunConfig(next);
    return next;
  }, [activeModel, activeProvider, activeRunConfig, setActiveRunConfig]);

  const setNativeRunControl = useCallback((patch: Partial<NonNullable<typeof activeRunConfig>>) => {
    if (!activeModel) return;
    const next = {
      ...(activeProvider === 'codex' ? {} : activeModel.runConfig || {}),
      ...(activeRunConfig || {}),
      ...patch,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === '') delete next[key as keyof typeof next];
    }
    setActiveRunConfig(activeProvider === 'codex' ? codexRunConfig(activeModel, next) : next);
  }, [activeModel, activeProvider, activeRunConfig, setActiveRunConfig]);

  const handleCommandPick = useCallback((preset: CommandPreset) => {
    if (preset.nativeCommand?.kind === 'goal') {
      setActiveRunConfig(clearCommandConfig(activeRunConfig, activeModel));
      setPendingCommandForCurrentChat(preset.id);
      setInputValue('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setPendingCommandForCurrentChat(null);
    applyPreset(preset);
    // De slash kiest de actie en hoort daarna niet meer in het berichtveld.
    // De chip maakt zichtbaar wat voor de volgende beurt actief is.
    setInputValue('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [activeModel, activeRunConfig, applyPreset, setActiveRunConfig, setInputValue, setPendingCommandForCurrentChat]);

  const resetCommand = useCallback(() => {
    setPendingCommandForCurrentChat(null);
    setActiveRunConfig(clearCommandConfig(activeRunConfig, activeModel));
  }, [activeModel, activeRunConfig, setActiveRunConfig, setPendingCommandForCurrentChat]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !currentChatId || isStreaming || isRefreshingModels || requestInFlightByChatRef.current.has(currentChatId) || !activeModelId || !activeModel) return;

    if (pendingCommandId) {
      const pendingPreset = commandPresets.find((preset) => preset.id === pendingCommandId);
      if (pendingPreset) {
        if (pendingPreset.nativeCommand?.kind === 'goal') {
          try {
            await ensureChatMaterialized(currentChatId);
            await window.electronAPI?.providers.setNativeGoal({
              chatId: currentChatId,
              modelRef: { provider: activeProvider, modelId: activeModelId, runConfig: activeRunConfig },
              objective: input.trim(),
              language: normalizeUiLanguage(i18n.resolvedLanguage || i18n.language),
            });
            setActiveRunConfig({
              ...(clearCommandConfig(activeRunConfig, activeModel) || {}),
              commandPresetId: pendingPreset.id,
              commandGoal: input.trim(),
            });
            setPendingCommandForCurrentChat(null);
            setInputValue('');
          } catch (error: any) {
            setComposerError(error?.message || String(error));
          }
          return;
        }
        const applied = applyCommandPreset(
          pendingPreset,
          activeProvider,
          activeModel,
          activeRunConfig,
          input.trim(),
        );
        setActiveRunConfig(applied);
        setPendingCommandForCurrentChat(null);
        setInputValue('');
        return;
      }
    }

    const runChatId = currentChatId;
    const requestId = crypto.randomUUID();
    let streamCleanup: (() => void) | undefined;
    let usageModel = { provider: activeProvider, modelId: activeModelId };
    let promptText = input.trim();
    let requestRunConfig = activeRunConfig;
    const command = parseCommandInput(promptText, commandPresets);
    setComposerError('');

    if (command) {
      if (command.preset.id === 'reset') {
        setActiveRunConfig(clearCommandConfig(activeRunConfig, activeModel));
        setInputValue('');
        return;
      }

      const commandArgs = command.args.trim();
      if (command.preset.nativeCommand?.kind === 'goal') {
        if (!commandArgs) {
          setPendingCommandForCurrentChat(command.preset.id);
          setInputValue('');
          return;
        }
        try {
          await ensureChatMaterialized(runChatId);
          await window.electronAPI?.providers.setNativeGoal({
            chatId: runChatId,
            modelRef: { provider: activeProvider, modelId: activeModelId, runConfig: activeRunConfig },
            objective: commandArgs,
            language: normalizeUiLanguage(i18n.resolvedLanguage || i18n.language),
          });
          setActiveRunConfig({
            ...(clearCommandConfig(activeRunConfig, activeModel) || {}),
            commandPresetId: command.preset.id,
            commandGoal: commandArgs,
          });
          setInputValue('');
        } catch (error: any) {
          setComposerError(error?.message || String(error));
        }
        return;
      }
      const applied = applyCommandPreset(command.preset, activeProvider, activeModel, activeRunConfig, commandArgs);
      setActiveRunConfig(applied);
      setPendingCommandForCurrentChat(null);

      if (command.preset.id === 'goal') {
        setInputValue('');
        return;
      }

      requestRunConfig = applied;
      promptText = commandMessageText(command);
      if (!promptText) {
        setInputValue('');
        return;
      }
    }

    // Native provideracties zijn beurtgebonden. De request houdt zijn snapshot,
    // maar de volgende gewone beurt mag niet opnieuw Review/Skill/Mode starten.
    if (requestRunConfig?.nativeProviderCommand) {
      setActiveRunConfig(clearCommandConfig(requestRunConfig, activeModel));
      setPendingCommandForCurrentChat(null);
    }

    try {
      await ensureChatMaterialized(runChatId);
    } catch (error: any) {
      setComposerError(t('chat.startFailed', { error: error?.message || String(error) }));
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
      return;
    }

    requestInFlightByChatRef.current.set(runChatId, requestId);

    const optimisticMessage: Message = {
      id: `optimistic-${requestId}`,
      chatId: runChatId,
      role: 'user',
      content: promptText,
      modelId: activeModelId,
      provider: activeProvider,
      inputTokens: 0,
      outputTokens: 0,
      attachments: attachments.length ? JSON.stringify(attachments) : null,
      runConfig: requestRunConfig ? JSON.stringify(requestRunConfig) : null,
      createdAt: new Date().toISOString(),
    };

    addMessage(optimisticMessage);
    setInputValue('');
    setChatAttachments(runChatId, []);
    startChatRun({
      chatId: runChatId,
      requestId,
      modelId: activeModelId,
      provider: activeProvider,
      runConfig: requestRunConfig,
      status: attachments.length ? `${attachments.length} bijlage${attachments.length === 1 ? '' : 'n'} verwerken...` : 'Bericht verstuurd...',
    });
    clearLiveToolStateForChat(runChatId);

    try {
      if (window.electronAPI) {
        streamCleanup = window.electronAPI.chat.onStreamEvent(async (event) => {
          if (!shouldAcceptOwnedRequestEvent(runChatId, requestId, event)) return;

          if (event.type === 'message_saved' && event.message?.role === 'user') {
            confirmPersistedUserMessage(runChatId, requestId, event.message);
          }

          if (event.type === 'delta') {
            appendChatRunContent(runChatId, requestId, event.delta || '');
          }

          if (event.type === 'model_switch') {
          setChatRunStatus(runChatId, requestId, t('chat.switchingModel', {
            model: event.to?.modelId || t('chat.nextModel'),
          }));
            if (event.to) {
              usageModel = { provider: event.to.provider, modelId: event.to.modelId };
              setChatRunModel(runChatId, requestId, {
                modelId: event.to.modelId,
                provider: event.to.provider,
                runConfig: event.to.runConfig,
              });
              const store = useChatStore.getState();
              store.updateChat(runChatId, {
                activeModelId: event.to.modelId,
                activeProvider: event.to.provider,
                activeRunConfig: event.to.runConfig,
              });
              if (store.currentChatId === runChatId) {
                store.setActiveModel(event.to.modelId, event.to.provider, event.to.runConfig);
              }
            }
          }

          if (event.type === 'status') {
            setChatRunStatus(runChatId, requestId, event.status || '');
          }

          if (event.type === 'tool_activity') {
            setChatRunStatus(runChatId, requestId, event.label || event.detail || '');
          }

          if (event.type === 'usage' && event.usage) {
            const key = `${usageModel.provider}:${usageModel.modelId}`;
            const currentUsage = useProviderStore.getState().tokenUsage[key] || {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextWindowSize: event.usage.contextWindowSize,
              contextUsedPercent: 0,
            };
            const totalTokens = currentUsage.totalTokens + event.usage.totalTokens;
            useProviderStore.getState().setTokenUsage(key, {
              inputTokens: currentUsage.inputTokens + event.usage.inputTokens,
              outputTokens: currentUsage.outputTokens + event.usage.outputTokens,
              totalTokens,
              cachedTokens: (currentUsage.cachedTokens || 0) + (event.usage.cachedTokens || 0),
              reasoningTokens: (currentUsage.reasoningTokens || 0) + (event.usage.reasoningTokens || 0),
              source: mergeUsageSources(currentUsage.source, event.usage.source),
              contextWindowSize: event.usage.contextWindowSize,
              contextUsedPercent: event.usage.contextWindowSize ? Math.round((totalTokens / event.usage.contextWindowSize) * 100) : 0,
            });
          }

          if (event.type === 'done') {
            await reloadMessages(runChatId, requestId);
            clearLiveToolStateForChat(runChatId, requestId);
            finishChatRun(runChatId, requestId);
            if (useChatStore.getState().currentChatId === runChatId) {
              requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
            }
            streamCleanup?.();
          }

          if (event.type === 'error') {
          appendChatRunContent(runChatId, requestId, `\n\n${t('common.error')}: ${event.error || t('chat.providerRequestFailed')}`);
            setChatRunStatus(runChatId, requestId, '');
            await reloadMessages(runChatId, requestId);
            clearLiveToolStateForChat(runChatId, requestId);
            finishChatRun(runChatId, requestId);
            if (useChatStore.getState().currentChatId === runChatId) {
              requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
            }
            streamCleanup?.();
          }
        });

        await window.electronAPI.chat.sendMessage({
          requestId,
          chatId: runChatId,
          modelRef: {
            provider: activeProvider,
            modelId: activeModelId,
            runConfig: requestRunConfig,
          },
          input: promptText,
          attachmentIds: attachments.map((attachment) => attachment.id),
          systemPrompt: useChatStore.getState().systemPrompt || undefined,
          language: normalizeUiLanguage(i18n.resolvedLanguage || i18n.language),
        });
      } else {
        const demoResponse = t('chat.demoResponse', { model: activeModelId, provider: activeProvider });
        for (let i = 0; i < demoResponse.length; i += 4) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          appendChatRunContent(runChatId, requestId, demoResponse.slice(i, i + 4));
        }
        addMessage({
          id: crypto.randomUUID(),
          chatId: runChatId,
          role: 'assistant',
          content: demoResponse,
          modelId: activeModelId,
          provider: activeProvider,
          inputTokens: Math.floor(promptText.length / 4),
          outputTokens: Math.floor(demoResponse.length / 4),
          runConfig: requestRunConfig ? JSON.stringify(requestRunConfig) : null,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      appendChatRunContent(runChatId, requestId, `\n\n${t('common.error')}: ${error.message || String(error)}`);
    } finally {
      if (requestInFlightByChatRef.current.get(runChatId) === requestId) {
        requestInFlightByChatRef.current.delete(runChatId);
      }
      streamCleanup?.();
      await reloadMessages(runChatId, requestId);
      clearLiveToolStateForChat(runChatId, requestId);
      finishChatRun(runChatId, requestId);
      if (useChatStore.getState().currentChatId === runChatId) {
        requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
      }
    }
  }, [
    input,
    currentChatId,
    isStreaming,
    isRefreshingModels,
    activeModelId,
    activeProvider,
    activeRunConfig,
    commandPresets,
    pendingCommandId,
    activeModel,
    i18n.language,
    i18n.resolvedLanguage,
    t,
    attachments,
    addMessage,
    confirmPersistedUserMessage,
    appendChatRunContent,
    clearLiveToolStateForChat,
    finishChatRun,
    reloadMessages,
    setActiveRunConfig,
    setPendingCommandForCurrentChat,
    setChatRunModel,
    setChatRunStatus,
    setInputValue,
    setChatAttachments,
    startChatRun,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSelectFiles = async () => {
    if (!window.electronAPI || !currentChatId) return;
    const attachmentChatId = currentChatId;
    const imported = await window.electronAPI.files.selectAndImport(
      isDraftChatId(attachmentChatId) ? undefined : attachmentChatId,
    );
    setChatAttachments(attachmentChatId, (prev) => [...prev, ...imported]);
  };

  const removeAttachment = (index: number) => {
    if (!currentChatId) return;
    const attachmentChatId = currentChatId;
    const removed = attachments[index];
    if (removed?.id) void window.electronAPI?.files.deletePending(removed.id);
    setChatAttachments(attachmentChatId, (prev) => prev.filter((_, i) => i !== index));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Alleen de waarde bijwerken; de useLayoutEffect op `input` regelt de hoogte.
    setInputValue(e.target.value);
  };

  const handleStop = () => {
    if (!currentChatId || !activeRequestId) return;
    const stoppedChatId = currentChatId;
    const stoppedRequestId = activeRequestId;
    if (requestInFlightByChatRef.current.get(stoppedChatId) === stoppedRequestId) {
      requestInFlightByChatRef.current.delete(stoppedChatId);
    }
    finishChatRun(stoppedChatId, stoppedRequestId);
    clearLiveToolStateForChat(stoppedChatId, stoppedRequestId);
    if (window.electronAPI) {
      window.electronAPI.chat.cancel(stoppedRequestId);
    }
  };

  return (
    <div className="chat-input-container">
      {composerError && (
        <div className="composer-error" role="alert">
          {composerError}
        </div>
      )}
      {deferredApproval && (
        <div className="approval-dock motion-panel" role="status">
          <div className="approval-dock-icon"><Terminal size={16} /></div>
          <div className="approval-dock-content">
            <div className="approval-dock-title">
              <span>{t('chat.approval.waiting', { action: localizedApprovalTitle(deferredApproval, t) })}</span>
              <span className="approval-dock-count">
                {deferredApprovals.length > 1 ? t('chat.approval.position', { current: 1, total: deferredApprovals.length }) : t('chat.approval.deferred')}
              </span>
            </div>
            <code className="approval-dock-command" title={deferredApproval.command}>{deferredApproval.command}</code>
          </div>
          <div className="approval-dock-actions">
            <button className="btn btn-primary" onClick={() => onRespondApproval(deferredApproval, true)}>
               <Check size={14} /> {t('chat.approval.allow')}
            </button>
            <button className="btn btn-secondary" onClick={() => onRespondApproval(deferredApproval, false)}>
               <X size={14} /> {t('chat.approval.deny')}
            </button>
          </div>
        </div>
      )}
      {autoModeForCurrentChat && (
        <div className="auto-mode-composer-dock motion-panel" role="status" aria-live="polite">
          <div className={`auto-mode-composer-icon ${autoModeStatus === 'running' ? 'busy' : ''}`}>
            {autoModeStatus === 'running' ? <Loader2 size={16} /> : <Sparkles size={16} />}
          </div>
          <div className="auto-mode-composer-copy">
            <div className="auto-mode-composer-title">
              <strong>{t('autoMode.title')}</strong>
              <span>{autoModeStatus === 'paused' ? t('autoMode.paused') : autoModeDetail || t('autoMode.running')}</span>
              <small>
                {autoModeMaxIterations === 0
                  ? t('autoMode.roundInfinite', { current: autoModeIteration + (autoModePhase === 'waiting' ? 0 : 1) })
                  : t('autoMode.round', { current: Math.min(autoModeIteration + (autoModePhase === 'waiting' ? 0 : 1), autoModeMaxIterations), max: autoModeMaxIterations })}
              </small>
            </div>
            {autoModeLastPromptPreview && <p title={autoModeLastPromptPreview}>{autoModeLastPromptPreview}</p>}
          </div>
          <div className="auto-mode-composer-actions">
            {autoModeStatus === 'running' ? (
              <button type="button" className="btn-icon" onClick={() => updateAutoMode('pause')} title={t('autoMode.pause')} aria-label={t('autoMode.pause')}><Pause size={15} /></button>
            ) : (
              <button type="button" className="btn-icon" onClick={() => updateAutoMode('resume')} title={t('autoMode.resume')} aria-label={t('autoMode.resume')}><Play size={15} /></button>
            )}
            <button type="button" className="btn-icon danger" onClick={() => updateAutoMode('stop')} title={t('autoMode.stop')} aria-label={t('autoMode.stop')}><Square size={14} /></button>
          </div>
        </div>
      )}
      <div className="chat-input-wrapper">
        {(attachments.length > 0 || (selectedCommandPreset && ActiveCommandIcon)) && (
          <div className={`chat-input-top ${attachments.length === 0 ? 'command-only' : ''}`}>
            {selectedCommandPreset && ActiveCommandIcon && (
              <div
                className={`composer-command-chip ${pendingCommandId ? 'pending' : ''}`}
                title={activeRunConfig?.commandGoal || selectedCommandPreset.description}
              >
                <ActiveCommandIcon size={14} />
                <span>{activeCommandLabel || t('chat.command')}</span>
                <button
                  type="button"
                  className="composer-command-remove"
                  onClick={resetCommand}
                  aria-label={t('chat.resetCommand')}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {attachments.map((attachment, i) => (
              <div key={attachment.id} className="file-chip">
                {attachment.name}
                <button
                  className="attachment-remove"
                  onClick={() => removeAttachment(i)}
                  aria-label={t('common.delete')}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          placeholder={selectedCommandPreset?.nativeCommand?.kind === 'goal' ? t('chat.goalPlaceholder') : t('chat.placeholder')}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        {commandMatches.length > 0 && (
          <div className="command-palette motion-panel">
            {(['provider-native', 'llmelt-workflow'] as const).map((source) => {
              const matches = commandMatches.filter((preset) => preset.source === source);
              if (!matches.length) return null;
              return (
                <React.Fragment key={source}>
                  <div className="command-palette-section-label">
                    {source === 'provider-native'
                      ? t('runSettings.providerNative')
                      : t('runSettings.appWorkflows')}
                  </div>
                  {matches.map((preset) => {
                    const Icon = preset.icon;
                    return (
                      <button key={preset.id} type="button" className="command-palette-item" onClick={() => handleCommandPick(preset)}>
                        <Icon size={16} />
                        <span>
                          <strong>{preset.slash}</strong>
                          <small>{preset.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        )}

        <div className="chat-input-bottom">
          <div className="chat-input-actions">
            <IconButton label={t('chat.uploadFiles')} icon={Paperclip} onClick={handleSelectFiles} />
            <IconButton
              label={t('chat.editSystemPrompt')}
              icon={FileText}
              data-utility-panel="system-prompt"
              onClick={() => requestUtilityPanelToggle('system-prompt')}
            />
          </div>

          <div className="composer-model-controls">
            <button
              type="button"
              className="composer-model-chip"
              onClick={() => setShowModelSelector(true)}
              disabled={isRefreshingModels}
              title={isRefreshingModels ? t('models.catalogChecking') : undefined}
            >
              <span className="composer-model-label">
                {isRefreshingModels
                  ? t('models.refreshing')
                  : activeModelId
                    ? `${providerLabel(activeProvider)}: ${activeModelLabel}`
                    : t('models.noModel')}
              </span>
              {activeModel && !isRefreshingModels && <QuotaBadge model={activeModel} />}
            </button>
            <div ref={accessMenuRef} className="composer-access-control">
              <button
                type="button"
                className={`composer-access-chip ${accessMeta.tone} ${showAccessMenu ? 'active' : ''}`}
                aria-expanded={showAccessMenu}
                onClick={() => {
                  setShowRunSettings(false);
                  setShowAccessMenu((value) => !value);
                }}
                title={chatAgentMode ? t('chat.access.thisChat') : t('chat.access.followsSettings')}
              >
                <accessMeta.Icon size={14} />
                <span>{agentToolsEnabled ? accessMeta.shortLabel : t('chat.access.toolsOff')}</span>
                {chatAgentMode && <span className="composer-access-dot" title={t('chat.access.onlyThisChat')} />}
                <ChevronDown size={14} />
              </button>
              {accessMenuPresence.mounted && (
                <div className={`access-mode-popover motion-panel dismissible-popover ${accessMenuPresence.phase}`}>
                  <div className="access-mode-header">
                    <span>{t('chat.access.question')}</span>
                    <small>{chatAgentMode ? t('chat.access.onlyThisChat') : t('chat.access.followsSettings')}</small>
                  </div>
                  <button
                    type="button"
                    className={`access-mode-option tone-default ${!chatAgentMode ? 'active' : ''}`}
                    onClick={() => saveChatAgentMode(null)}
                  >
                    <Shield size={16} />
                    <span>
                      <strong>{t('chat.access.settingsDefault')}</strong>
                      <small>{t('chat.access.current', { mode: approvalModeMeta(defaultAgentMode, t).label })}</small>
                    </span>
                    {!chatAgentMode && <Check size={15} />}
                  </button>
                  {AGENT_MODE_OPTIONS.map((option) => {
                    const meta = approvalModeMeta(option.value, t);
                    const active = chatAgentMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`access-mode-option tone-${meta.tone} ${active ? 'active' : ''}`}
                        onClick={() => saveChatAgentMode(option.value)}
                      >
                        <meta.Icon size={16} />
                        <span>
                          <strong>{meta.label}</strong>
                          <small>{t(option.descriptionKey)}</small>
                        </span>
                        {active && <Check size={15} />}
                      </button>
                    );
                  })}
                  {!agentToolsEnabled && (
                    <div className="access-mode-note">
                      {t('chat.access.globallyOffNote')}
                    </div>
                  )}
                </div>
              )}
            </div>
            {activeModelId && hasNativeRunSettings && (
              <div ref={runSettingsRef} className="run-settings">
                <IconButton
                  label={t('runSettings.title', { defaultValue: 'Run settings' })}
                  icon={Settings2}
                  active={showRunSettings}
                  onClick={() => {
                    setShowAccessMenu(false);
                    setShowRunSettings((value) => !value);
                  }}
                />
                {runSettingsPresence.mounted && (
                  <div className={`run-settings-popover motion-panel dismissible-popover ${runSettingsPresence.phase}`}>
                    <div className="run-settings-header">
                      <ProviderBadge
                        provider={activeProvider}
                        label={t('runSettings.title')}
                      />
                      {activeModel && <QuotaBadge model={activeModel} />}
                    </div>
                    <div className="run-settings-grid">
                        {runControls.reasoningEfforts.length > 1 && (
                          <SelectField
                            label={t('runSettings.effort')}
                            value={activeEffort}
                            onChange={(value) => setNativeRunControl({ reasoningEffort: value as ReasoningEffort })}
                            options={[
                              ...(activeModel?.defaultReasoningEffort ? [] : [{ value: '', label: t('models.standard') }]),
                              ...runControls.reasoningEfforts.map((effort) => ({
                                value: effort,
                                label: localizedReasoningEffortLabel(t, effort),
                              })),
                            ]}
                          />
                        )}
                        {runControls.chatgptThinkingEfforts.length > 1 && (
                          <SelectField
                            label={t('runSettings.intelligence')}
                            value={activeRunConfig?.chatgptThinkingEffort
                              || activeModel?.runConfig?.chatgptThinkingEffort
                              || runControls.chatgptThinkingEfforts[0].value}
                            onChange={(value) => setNativeRunControl({ chatgptThinkingEffort: value })}
                            options={runControls.chatgptThinkingEfforts.map((effort) => ({
                              value: effort.value,
                              label: effort.label,
                            }))}
                          />
                        )}
                        {runControls.serviceTiers.length > 0 && (
                          <SelectField
                            label={t('runSettings.speed')}
                            value={activeRunConfig?.serviceTier || ''}
                            onChange={(value) => setNativeRunControl({ serviceTier: value })}
                            options={[
                              { value: '', label: t('models.standard') },
                              ...runControls.serviceTiers.map((tier) => ({
                                value: tier,
                                label: localizedServiceTierLabel(t, tier),
                              })),
                            ]}
                          />
                        )}
                    </div>
                    {providerRunActions.length > 0 && (
                      <div className="run-settings-native-actions">
                        <div className="run-settings-section-label">
                          {t('runSettings.providerNativeActions')}
                        </div>
                        <div className="run-settings-native-grid">
                          {providerRunActions.map((preset) => {
                            const Icon = preset.icon;
                            return (
                              <button
                                key={preset.id}
                                type="button"
                                className="run-settings-native-action"
                                title={preset.description}
                                onClick={() => {
                                  handleCommandPick(preset);
                                  setShowRunSettings(false);
                                }}
                              >
                                <Icon size={15} />
                                <span>{preset.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {llmeltCommandPresets.length > 0 && (
                      <div className="run-settings-native-actions run-settings-workflow-actions">
                        <div className="run-settings-section-label">
                          {t('runSettings.appWorkflows')}
                        </div>
                        <div className="run-settings-native-grid">
                          {llmeltCommandPresets.map((preset) => {
                            const Icon = preset.icon;
                            return (
                              <button
                                key={preset.id}
                                type="button"
                                className="run-settings-native-action"
                                title={preset.description}
                                onClick={() => {
                                  handleCommandPick(preset);
                                  setShowRunSettings(false);
                                }}
                              >
                                <Icon size={15} />
                                <span>{preset.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {nativeCommandsLoading && (
                      <div className="run-settings-native-loading"><Loader2 size={13} /> {t('models.refreshing')}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <ContextMeter context={contextUsage} fallbackTotal={activeModel?.contextWindow || 0} />
          </div>

          <div className="chat-input-actions">
            {isStreaming ? (
              <button className="btn btn-secondary composer-stop-btn" onClick={handleStop}>
                <Square size={14} />
                {t('chat.stop')}
              </button>
            ) : (
              <button className="btn-send" onClick={handleSend} disabled={!input.trim() || !activeModelId || isRefreshingModels} title={t('chat.send')}>
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {showModelSelector && <ModelSelector onClose={() => setShowModelSelector(false)} />}
    </div>
  );
};

function ContextMeter({ context, fallbackTotal }: { context: TokenDashboard['context'] | null; fallbackTotal: number }) {
  const { t } = useTranslation();
  const total = context?.total || fallbackTotal || 0;
  const used = context?.used || 0;
  const percent = total > 0 ? Math.max(0, used / total * 100) : 0;
  const source = context?.source || (total ? 'estimate' : 'unknown');
  const windowSource = context?.windowSource || (fallbackTotal ? 'estimate' : 'unknown');
  const sourceLabel = contextMeterSourceLabel(source, t);
  const windowSourceLabel = contextMeterSourceLabel(windowSource, t);

  return (
    <div
      className="composer-context-meter"
      title={`${t('tokens.contextCountSource', { source: sourceLabel })} · ${t('tokens.contextWindowSource', { source: windowSourceLabel })}`}
    >
      <div className="context-mini-bar">
        <div className={`context-mini-fill ${percent > 80 ? 'warning' : ''}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span>{formatTokens(used)} / {total ? formatTokens(total) : '—'}</span>
      <span>{formatContextPercent(percent)}</span>
      <span>{sourceLabel}</span>
    </div>
  );
}

function contextMeterSourceLabel(source: string, t: ReturnType<typeof useTranslation>['t']) {
  if (source === 'provider') return t('tokens.providerMeasured');
  if (source === 'cli') return t('tokens.cliMeasured');
  if (source === 'local') return t('tokens.localMeasured');
  if (source === 'estimate') return t('tokens.usageEstimated');
  return t('tokens.usageUnknown');
}

function localizedApprovalTitle(
  approval: QueuedAgentApproval,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const knownLabels: Record<string, string> = {
    'bestand lezen': t('chat.approval.fileRead'),
    'bestand maken': t('chat.approval.fileCreate'),
    'bestand wijzigen': t('chat.approval.fileEdit'),
    'commando uitvoeren': t('chat.approval.runCommand'),
  };
  if (approval.label) return knownLabels[approval.label.trim().toLowerCase()] || approval.label;
  if (approval.kind === 'file-read') return t('chat.approval.fileRead');
  if (approval.kind === 'file-create') return t('chat.approval.fileCreate');
  if (approval.kind === 'file-edit') return t('chat.approval.fileEdit');
  return t('chat.approval.runCommand');
}

function formatContextPercent(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatTokens(tokens: number) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function localizedReasoningEffortLabel(t: ReturnType<typeof useTranslation>['t'], effort: string) {
  return t(`models.efforts.${effort}`, { defaultValue: effort });
}

function localizedServiceTierLabel(t: ReturnType<typeof useTranslation>['t'], tier: string) {
  const normalized = tier.trim().toLowerCase();
  if (normalized === 'standard' || normalized === 'default' || !normalized) {
    return t('models.serviceTiers.standard');
  }
  if (normalized === 'fast' || normalized === 'priority') {
    return t('models.serviceTiers.fast');
  }
  if (normalized === 'flex') return t('models.serviceTiers.flex');
  return tier;
}

export default ChatInput;
