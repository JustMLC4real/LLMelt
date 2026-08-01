import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, FileText, Loader2, Paperclip, Pause, Play, RefreshCw, Send, Settings2, Shield, ShieldAlert, ShieldCheck, Sparkles, Square, Terminal, X } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import ModelSelector from './ModelSelector';
import type { AgentApprovalMode, AttachmentRef, Message, ReasoningEffort, TokenDashboard } from '../providers/types';
import { codexEffortForModel, codexEffortsForModel, codexRunConfig, modelDisplayName, providerLabel, reasoningEffortLabel, serviceTierLabel, serviceTiersForModel } from './model-utils';
import { FlipText, IconButton, ProviderBadge, QuotaBadge, SelectField } from './ui';
import { COMMAND_PRESETS, applyCommandPreset, clearCommandConfig, commandLabel, parseCommandInput, type CommandPreset } from './command-presets';
import { COMPOSER_FOCUS_EVENT } from './composer-focus';
import { approvalTitle, deferredAgentApprovalsForChat, type QueuedAgentApproval } from './approval-queue';
import { chatScopedList } from './chat-scope';
import { shouldAcceptOwnedRequestEvent } from './command-run-utils';
import { shouldApplyChatRunResult } from './chat-run-state';
import { chatFromVisibleOrDraft } from './draft-chat';
import { ensureChatMaterialized, isDraftChatId } from './new-chat';
import { usePanelPresence } from './use-panel-presence';
import { requestUtilityPanelToggle } from './utility-panels';

const AGENT_MODE_OPTIONS: Array<{ value: AgentApprovalMode; description: string }> = [
  { value: 'ask', description: 'Vraag per bestand lezen/maken/wijzigen en commando om goedkeuring.' },
  { value: 'auto-project', description: 'Bestandstools binnen de werkmap gaan automatisch; shellcommando’s blijven vragen.' },
  { value: 'full', description: 'Geen approval-popups voor deze chat. Riskant, maar snel.' },
];

function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return value === 'ask' || value === 'auto-project' || value === 'full';
}

function approvalModeMeta(mode: AgentApprovalMode) {
  if (mode === 'full') {
    return { label: 'Volledige toegang', shortLabel: 'Volledige toegang', tone: 'danger', Icon: ShieldAlert };
  }
  if (mode === 'auto-project') {
    return { label: 'Auto in werkmap', shortLabel: 'Auto in werkmap', tone: 'warn', Icon: ShieldCheck };
  }
  return { label: 'Goedkeuring aanvragen', shortLabel: 'Goedkeuring vragen', tone: 'safe', Icon: Shield };
}

interface ChatInputProps {
  approvals: QueuedAgentApproval[];
  onRespondApproval: (approval: QueuedAgentApproval, approved: boolean) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({ approvals, onRespondApproval }) => {
  const { t } = useTranslation();
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const runSettingsRef = useRef<HTMLDivElement>(null);
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
  const accessMeta = approvalModeMeta(effectiveAgentMode);
  const activeModel = models.find((model) => model.provider === activeProvider && model.id === activeModelId);
  const baseModelLabel = modelDisplayName(activeModel) || activeModelId || 'Geen model';
  // For ChatGPT, also show the chosen Inspanning (e.g. "Langer") in the label.
  const chatgptEffortValue = activeProvider === 'openai' && activeModelId.startsWith('chatgpt:') ? activeRunConfig?.chatgptThinkingEffort : undefined;
  const chatgptEffortLabel = chatgptEffortValue
    ? (activeModel?.chatgptThinkingEfforts?.find((e) => e.value === chatgptEffortValue)?.label || chatgptEffortValue)
    : '';
  const activeModelLabel = chatgptEffortLabel ? `${baseModelLabel} · ${chatgptEffortLabel}` : baseModelLabel;
  const activeEffort = activeProvider === 'codex'
    ? codexEffortForModel(activeModel, activeRunConfig?.reasoningEffort || activeModel?.runConfig?.reasoningEffort)
    : activeRunConfig?.reasoningEffort || activeModel?.runConfig?.reasoningEffort || activeModel?.defaultReasoningEffort || 'high';
  const slashInput = input.trimStart();
  const commandMatches = useMemo(() => {
    if (!slashInput.startsWith('/')) return [];
    const query = slashInput.slice(1).toLowerCase();
    if (query.includes(' ')) return [];
    return COMMAND_PRESETS.filter((preset) =>
      preset.slash.slice(1).includes(query) || preset.label.toLowerCase().includes(query),
    );
  }, [slashInput]);

  const activeCommandLabel = commandLabel(activeRunConfig?.commandPresetId);

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
  }, [currentChatId]);

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

  const handleCommandPick = useCallback((preset: CommandPreset) => {
    if (preset.id === 'goal') {
      setInputValue('/doel ');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    applyPreset(preset);
    setInputValue('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [applyPreset, setInputValue]);

  const resetCommand = useCallback(() => {
    setActiveRunConfig(clearCommandConfig(activeRunConfig));
  }, [activeRunConfig, setActiveRunConfig]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !currentChatId || isStreaming || isRefreshingModels || requestInFlightByChatRef.current.has(currentChatId) || !activeModelId || !activeModel) return;
    const runChatId = currentChatId;
    const requestId = crypto.randomUUID();
    let streamCleanup: (() => void) | undefined;
    let usageModel = { provider: activeProvider, modelId: activeModelId };
    let promptText = input.trim();
    let requestRunConfig = activeRunConfig;
    const command = parseCommandInput(promptText);
    setComposerError('');

    if (command) {
      if (command.preset.id === 'reset') {
        setActiveRunConfig(clearCommandConfig(activeRunConfig));
        setInputValue('');
        return;
      }

      const commandArgs = command.args.trim();
      const applied = applyCommandPreset(command.preset, activeProvider, activeModel, activeRunConfig, commandArgs);
      setActiveRunConfig(applied);

      if (command.preset.id === 'goal') {
        setInputValue('');
        return;
      }

      requestRunConfig = applied;
      promptText = command.rest.trim();
      if (!promptText) {
        setInputValue('');
        return;
      }
    }

    try {
      await ensureChatMaterialized(runChatId);
    } catch (error: any) {
      setComposerError(`Gesprek kon niet worden gestart: ${error?.message || String(error)}`);
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
            setChatRunStatus(runChatId, requestId, `Schakelt naar ${event.to?.modelId || 'volgend model'}...`);
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
            appendChatRunContent(runChatId, requestId, `\n\nFout: ${event.error || 'Providerverzoek mislukt.'}`);
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
        });
      } else {
        const demoResponse = `Demoantwoord van ${activeModelId} (${activeProvider}). Start de Electron-app en voeg API-keys of lokale CLI's toe voor echte providercalls.`;
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
      appendChatRunContent(runChatId, requestId, `\n\nError: ${error.message || String(error)}`);
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
    activeModel,
    attachments,
    addMessage,
    confirmPersistedUserMessage,
    appendChatRunContent,
    clearLiveToolStateForChat,
    finishChatRun,
    reloadMessages,
    setActiveRunConfig,
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
              <span>Wacht op jouw goedkeuring: {approvalTitle(deferredApproval)}</span>
              <span className="approval-dock-count">
                {deferredApprovals.length > 1 ? `1 van ${deferredApprovals.length}` : 'Uitgesteld'}
              </span>
            </div>
            <code className="approval-dock-command" title={deferredApproval.command}>{deferredApproval.command}</code>
          </div>
          <div className="approval-dock-actions">
            <button className="btn btn-primary" onClick={() => onRespondApproval(deferredApproval, true)}>
              <Check size={14} /> Toestaan
            </button>
            <button className="btn btn-secondary" onClick={() => onRespondApproval(deferredApproval, false)}>
              <X size={14} /> Weigeren
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
              <strong>Auto Mode</strong>
              <span>{autoModeStatus === 'paused' ? 'Gepauzeerd' : autoModeDetail || 'Bezig'}</span>
              <small>
                {autoModeMaxIterations === 0
                  ? `ronde ${autoModeIteration + (autoModePhase === 'waiting' ? 0 : 1)} / ∞`
                  : `ronde ${Math.min(autoModeIteration + (autoModePhase === 'waiting' ? 0 : 1), autoModeMaxIterations)} / ${autoModeMaxIterations}`}
              </small>
            </div>
            {autoModeLastPromptPreview && <p title={autoModeLastPromptPreview}>{autoModeLastPromptPreview}</p>}
          </div>
          <div className="auto-mode-composer-actions">
            {autoModeStatus === 'running' ? (
              <button type="button" className="btn-icon" onClick={() => updateAutoMode('pause')} title="Auto Mode pauzeren" aria-label="Auto Mode pauzeren"><Pause size={15} /></button>
            ) : (
              <button type="button" className="btn-icon" onClick={() => updateAutoMode('resume')} title="Auto Mode hervatten" aria-label="Auto Mode hervatten"><Play size={15} /></button>
            )}
            <button type="button" className="btn-icon danger" onClick={() => updateAutoMode('stop')} title="Auto Mode stoppen" aria-label="Auto Mode stoppen"><Square size={14} /></button>
          </div>
        </div>
      )}
      <div className="chat-input-wrapper">
        {(attachments.length > 0 || activeCommandLabel || activeRunConfig?.commandGoal) && (
          <div className="chat-input-top">
            {(activeCommandLabel || activeRunConfig?.commandGoal) && (
              <div className="command-state-chip">
                <FlipText text={activeCommandLabel || 'Command'} />
                {activeRunConfig?.commandGoal && <strong>{activeRunConfig.commandGoal}</strong>}
                <button type="button" className="attachment-remove" onClick={resetCommand} aria-label="Command resetten">
                  <X size={13} />
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
          placeholder={t('chat.placeholder')}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        {commandMatches.length > 0 && (
          <div className="command-palette motion-panel">
            {commandMatches.map((preset) => {
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
              title={isRefreshingModels ? 'De live modelcatalogus wordt nog gecontroleerd' : undefined}
            >
              <span className="composer-model-label">{activeModelId ? `${providerLabel(activeProvider)}: ${activeModelLabel}` : 'Geen model'}</span>
              {activeModel && <QuotaBadge model={activeModel} />}
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
                title={chatAgentMode ? 'PC-toegang voor deze chat' : 'PC-toegang volgt Settings'}
              >
                <accessMeta.Icon size={14} />
                <span>{agentToolsEnabled ? accessMeta.shortLabel : 'PC-tools uit'}</span>
                {chatAgentMode && <span className="composer-access-dot" title="Alleen deze chat" />}
                <ChevronDown size={14} />
              </button>
              {accessMenuPresence.mounted && (
                <div className={`access-mode-popover motion-panel dismissible-popover ${accessMenuPresence.phase}`}>
                  <div className="access-mode-header">
                    <span>Hoe moeten AI-acties worden goedgekeurd?</span>
                    <small>{chatAgentMode ? 'Alleen deze chat' : 'Volgt instellingen'}</small>
                  </div>
                  <button
                    type="button"
                    className={`access-mode-option tone-default ${!chatAgentMode ? 'active' : ''}`}
                    onClick={() => saveChatAgentMode(null)}
                  >
                    <Shield size={16} />
                    <span>
                      <strong>Standaard uit instellingen</strong>
                      <small>Nu: {approvalModeMeta(defaultAgentMode).label}</small>
                    </span>
                    {!chatAgentMode && <Check size={15} />}
                  </button>
                  {AGENT_MODE_OPTIONS.map((option) => {
                    const meta = approvalModeMeta(option.value);
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
                          <small>{option.description}</small>
                        </span>
                        {active && <Check size={15} />}
                      </button>
                    );
                  })}
                  {!agentToolsEnabled && (
                    <div className="access-mode-note">
                      PC-tools staan globaal uit in Settings. Deze keuze wordt alvast voor deze chat bewaard.
                    </div>
                  )}
                </div>
              )}
            </div>
            {isRefreshingModels && (
              <span className="model-refresh-hint" title="Modellen verversen…">
                <RefreshCw size={11} className="spin-slow" />
                verversen…
              </span>
            )}

            {activeModelId && (
              <div ref={runSettingsRef} className="run-settings">
                <IconButton
                  label="Run settings"
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
                      <ProviderBadge provider={activeProvider} label={activeProvider === 'codex' ? 'Codex run settings' : 'Run settings'} />
                      {activeModel && <QuotaBadge model={activeModel} />}
                    </div>
                    {activeProvider === 'codex' && (
                      <div className="run-settings-grid">
                        <SelectField
                          label="Inspanning"
                          value={activeEffort}
                          onChange={(value) =>
                            setActiveRunConfig(codexRunConfig(activeModel, {
                              ...(activeRunConfig || {}),
                              reasoningEffort: value as ReasoningEffort,
                            }))
                          }
                          options={codexEffortsForModel(activeModel).map((effort) => ({
                            value: effort,
                            label: reasoningEffortLabel(effort),
                          }))}
                        />
                        <SelectField
                          label="Snelheid"
                          value={activeRunConfig?.serviceTier || activeModel?.runConfig?.serviceTier || serviceTiersForModel(activeModel)[0] || ''}
                          onChange={(value) =>
                            setActiveRunConfig(codexRunConfig(activeModel, {
                              ...(activeRunConfig || {}),
                              serviceTier: value,
                            }))
                          }
                          options={serviceTiersForModel(activeModel).map((tier) => ({ value: tier, label: serviceTierLabel(tier) }))}
                        />
                      </div>
                    )}
                    <div className="command-button-grid">
                      {COMMAND_PRESETS.map((preset) => {
                        const Icon = preset.icon;
                        const active = activeRunConfig?.commandPresetId === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={`command-preset-button ${active ? 'active' : ''}`}
                            onClick={() => handleCommandPick(preset)}
                          >
                            <Icon size={15} />
                            <span>{preset.label}</span>
                          </button>
                        );
                      })}
                    </div>
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
  const total = context?.total || fallbackTotal || 0;
  const used = context?.used || 0;
  const percent = context?.percent || 0;
  const source = context?.source || (total ? 'estimate' : 'unknown');

  return (
    <div className="composer-context-meter" title={`Contextbron: ${source}`}>
      <div className="context-mini-bar">
        <div className={`context-mini-fill ${percent > 80 ? 'warning' : ''}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span>{formatTokens(used)} / {total ? formatTokens(total) : 'unknown'}</span>
      <span>{percent}%</span>
      <span>{source}</span>
    </div>
  );
}

function formatTokens(tokens: number) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export default ChatInput;
