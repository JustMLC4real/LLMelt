import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
import SystemPromptEditor from './SystemPromptEditor';
import AutoModePanel from './AutoModePanel';
import CommandRunActivity from './CommandRunActivity';
import { buildMessageRenderItems, parseCommandRun, shouldAcceptLiveRequestEvent } from './command-run-utils';
import { requestComposerFocus } from './composer-focus';
import { chatIdForRequest } from './chat-run-state';
import { itemsOwnedByChat } from './chat-scope';
import { cliConnectionChipStatus } from './connection-chip-status';
import { chatFromVisibleOrDraft } from './draft-chat';
import { startNewChat } from './new-chat';
import { usePanelPresence } from './use-panel-presence';
import { replacementForUnavailableModel } from './model-utils';
import type { QueuedAgentApproval } from './approval-queue';
import type { Message } from '../providers/types';
import {
  isUtilityPanelId,
  toggledUtilityPanel,
  UTILITY_PANEL_TOGGLE_EVENT,
  type UtilityPanelId,
} from './utility-panels';

interface ChatViewProps {
  approvals: QueuedAgentApproval[];
  onRespondApproval: (approval: QueuedAgentApproval, approved: boolean) => void;
}

const ChatView: React.FC<ChatViewProps> = ({ approvals, onRespondApproval }) => {
  const { t } = useTranslation();
  const {
    currentChatId,
    chats,
    draftChats,
    folders,
    messages,
    liveToolRuns,
    liveToolActivities,
    chatRuns,
    showSystemPromptEditor,
    setShowSystemPromptEditor,
    showTerminal,
    setShowTerminal,
    activeModelId,
    activeProvider,
    activeRunConfig,
    setActiveModel,
    updateChat,
    clearLiveToolRuns,
  } = useChatStore();
  const { autoModeStatus, autoModeChatId, autoModeDetail, models, authStatus, chatgptVersions, chatgptSessionActive, isRefreshingModels } = useProviderStore();
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const utilityToolsRef = useRef<HTMLDivElement>(null);
  const utilityStageRef = useRef<HTMLDivElement>(null);
  const systemPromptPanelRef = useRef<HTMLDivElement>(null);
  const autoModePanelRef = useRef<HTMLDivElement>(null);
  // Een draft houdt bij materialisatie hetzelfde id. Onthoud daarom de gekozen
  // chat los van zijn draft-status, zodat die statusflip geen lege DB-load start
  // die het zojuist getoonde userbericht kan overschrijven.
  const messageLoadChatIdRef = useRef<string | null>(null);
  const [showAutoModePanel, setShowAutoModePanel] = React.useState(false);
  const systemPromptPresence = usePanelPresence(showSystemPromptEditor);
  const autoModePresence = usePanelPresence(showAutoModePanel);
  const activeUtilityPanelRef = useRef<UtilityPanelId | null>(null);
  const [utilityPanelHeights, setUtilityPanelHeights] = React.useState({ systemPrompt: 0, autoMode: 0 });
  const [defaultWorkspacePath, setDefaultWorkspacePath] = React.useState('');
  const [agentMode, setAgentMode] = React.useState<'ask' | 'auto-project' | 'full'>('ask');
  const [agentToolsEnabled, setAgentToolsEnabled] = React.useState(false);
  const [statusNow, setStatusNow] = React.useState(() => Date.now());
  const currentChat = chatFromVisibleOrDraft(chats, draftChats, currentChatId);
  const currentChatIsDraft = !!currentChatId && draftChats.some((chat) => chat.id === currentChatId);
  const currentFolder = folders.find((folder) => folder.id === currentChat?.folderId);
  const legacyChatProjectPath = currentChat?.projectPath || '';
  const effectiveProjectPath = currentFolder?.projectPath || legacyChatProjectPath || defaultWorkspacePath || '';
  const autoModeForCurrentChat = !!currentChatId && autoModeChatId === currentChatId;
  const autoModeActive = autoModeForCurrentChat && (autoModeStatus === 'running' || autoModeStatus === 'paused');
  const activeModel = models.find((model) => model.provider === activeProvider && model.id === activeModelId);

  useEffect(() => {
    if (
      isRefreshingModels
      || !currentChatId
      || !activeModelId
      || !activeProvider
      || activeModel
    ) return;

    const replacement = replacementForUnavailableModel(models, activeProvider, activeModelId);
    if (!replacement) return;
    setActiveModel(replacement.id, replacement.provider, replacement.runConfig);
    updateChat(currentChatId, {
      activeModelId: replacement.id,
      activeProvider: replacement.provider,
      activeRunConfig: replacement.runConfig || null,
    });
    if (!currentChatIsDraft) {
      window.electronAPI?.db.updateChat(currentChatId, {
        activeModelId: replacement.id,
        activeProvider: replacement.provider,
        activeRunConfig: replacement.runConfig || null,
      }).catch(() => {});
    }
  }, [
    activeModel,
    activeModelId,
    activeProvider,
    currentChatId,
    currentChatIsDraft,
    isRefreshingModels,
    models,
    setActiveModel,
    updateChat,
  ]);

  const currentRun = currentChatId ? chatRuns[currentChatId] : undefined;
  const scopedMessages = React.useMemo(
    () => itemsOwnedByChat(messages, currentChatId),
    [currentChatId, messages],
  );
  const isStreaming = !!currentRun;
  const streamingContent = currentRun?.streamingContent || '';
  const streamingStatus = currentRun?.streamingStatus || '';
  const streamingStatusStartedAt = currentRun?.streamingStatusStartedAt || null;
  const nativeStreamId = currentRun?.nativeStreamId || null;
  const pendingStreamMessage = React.useMemo<Message | null>(() => {
    if (!currentChatId || !currentRun || nativeStreamId) return null;
    return {
      id: `streaming-${currentRun.requestId}`,
      chatId: currentChatId,
      role: 'assistant',
      content: streamingContent,
      modelId: currentRun.modelId,
      provider: currentRun.provider,
      inputTokens: 0,
      outputTokens: 0,
      runConfig: currentRun.runConfig ? JSON.stringify(currentRun.runConfig) : null,
      createdAt: new Date().toISOString(),
    };
  }, [currentChatId, currentRun, nativeStreamId, streamingContent]);
  const renderedMessages = React.useMemo(
    () => {
      const persistedIds = new Set(scopedMessages.map((message) => message.id));
      const liveNativeMessages = currentRun?.nativeMessages.filter((message) => !persistedIds.has(message.id)) || [];
      const withNative = liveNativeMessages.length ? [...scopedMessages, ...liveNativeMessages] : scopedMessages;
      return pendingStreamMessage ? [...withNative, pendingStreamMessage] : withNative;
    },
    [currentRun?.nativeMessages, pendingStreamMessage, scopedMessages],
  );
  const renderItems = React.useMemo(
    () => buildMessageRenderItems(renderedMessages, liveToolRuns, currentChatId, liveToolActivities),
    [renderedMessages, liveToolRuns, liveToolActivities, currentChatId],
  );

  // Groepeer een beurt (assistent-berichten + tool-kaarten) visueel tot één geheel: alleen
  // het EERSTE assistent-item toont de avatar/kop, de rest is een "continuation" (avatar
  // verborgen, strak eronder). Een gebruikersbericht start een nieuwe beurt.
  const continuationFlags = React.useMemo(() => {
    const flags: boolean[] = [];
    let inTurn = false;
    for (const item of renderItems) {
      if (item.type === 'message' && item.message.role === 'user') {
        inTurn = false;
        flags.push(false);
      } else {
        flags.push(inTurn);
        inTurn = true;
      }
    }
    return flags;
  }, [renderItems]);

  // De kop van het LEIDENDE segment toont de modelstatus. Een tijdelijke status als
  // "Model vat samen" hoort bij de beurtkop, niet tussen de uitgevoerde acties.
  const activeStreamHeaderIndex = React.useMemo(() => {
    if (!isStreaming) return -1;
    for (let i = renderItems.length - 1; i >= 0; i--) {
      const item = renderItems[i];
      if (item.type === 'message' && item.message.role === 'assistant' && !continuationFlags[i]) return i;
    }
    return -1;
  }, [isStreaming, renderItems, continuationFlags]);

  const activeTurnStartIndex = React.useMemo(() => {
    if (!isStreaming) return -1;
    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const item = renderItems[index];
      if (item.type === 'message' && item.message.role === 'user') return index;
    }
    return activeStreamHeaderIndex;
  }, [activeStreamHeaderIndex, isStreaming, renderItems]);

  // Meet beide panelen terwijl ze al verborgen klaarstaan. Een bekende pixelhoogte
  // animeren voorkomt dat CSS bij elk frame opnieuw een intrinsieke 0fr -> 1fr-grid
  // moet oplossen; juist die eerste layoutpiek veroorzaakte de zichtbare hapering.
  React.useLayoutEffect(() => {
    const panels = [
      ['systemPrompt', systemPromptPanelRef.current],
      ['autoMode', autoModePanelRef.current],
    ] as const;
    const measure = () => {
      setUtilityPanelHeights((current) => {
        const next = { ...current };
        for (const [name, panel] of panels) {
          if (panel) next[name] = panel.scrollHeight;
        }
        return next.systemPrompt === current.systemPrompt && next.autoMode === current.autoMode
          ? current
          : next;
      });
    };
    measure();
    const observers = panels.flatMap(([, panel]) => {
      if (!panel) return [];
      const observer = new ResizeObserver(measure);
      observer.observe(panel);
      return [observer];
    });
    return () => observers.forEach((observer) => observer.disconnect());
  }, [currentChatId]);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'auto') => {
    const scrollArea = messagesScrollRef.current;
    if (!scrollArea) return;

    const run = () => {
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior });
    };

    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
      window.setTimeout(run, 80);
    });
  }, []);

  useEffect(() => {
    scrollToBottom('auto');
  }, [currentChatId, scrollToBottom]);

  useEffect(() => {
    scrollToBottom(isStreaming ? 'smooth' : 'auto');
  }, [messages.length, renderItems.length, streamingContent, streamingStatus, isStreaming, scrollToBottom]);

  useEffect(() => {
    if (!isStreaming || !streamingStatus || !streamingStatusStartedAt) return;
    const id = window.setInterval(() => setStatusNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isStreaming, streamingStatus, streamingStatusStartedAt]);

  useEffect(() => {
    if (!currentChatId) {
      messageLoadChatIdRef.current = null;
      return undefined;
    }
    if (messageLoadChatIdRef.current === currentChatId) return undefined;
    messageLoadChatIdRef.current = currentChatId;

    if (window.electronAPI && !currentChatIsDraft) {
      let cancelled = false;
      const requestedChatId = currentChatId;
      window.electronAPI.db
        .getMessages(requestedChatId)
        .then((msgs) => {
          if (!cancelled && useChatStore.getState().currentChatId === requestedChatId) {
            useChatStore.getState().setMessagesForChat(requestedChatId, msgs);
          }
        })
        .catch(console.error);
      // Authoritatively restore this chat's saved model + Stand + Inspanning from the
      // DB (the in-memory chat list can be stale). Skip brand-new chats with no model
      // so the user's current selection is kept.
      window.electronAPI.db
        .getChat(requestedChatId)
        .then((chat: any) => {
          if (!cancelled && useChatStore.getState().currentChatId === requestedChatId && chat?.activeModelId && chat.activeProvider) {
            useChatStore.getState().setActiveModel(chat.activeModelId, chat.activeProvider, chat.activeRunConfig || undefined);
          }
          if (chat?.id) {
            useChatStore.getState().updateChat(chat.id, {
              agentMode: chat.agentMode || null,
              projectPath: chat.projectPath || null,
              activeRunConfig: chat.activeRunConfig || null,
            });
          }
        })
        .catch(console.error);
      return () => { cancelled = true; };
    }
    return undefined;
  }, [currentChatId, currentChatIsDraft]);

  useEffect(() => {
    window.electronAPI?.files.getDefaultWorkspace?.()
      .then((workspace: string) => setDefaultWorkspacePath(workspace || ''))
      .catch(() => setDefaultWorkspacePath(''));
  }, []);

  useEffect(() => {
    const refreshAgentConfig = () => {
      window.electronAPI?.agent.getConfig()
        .then((config: any) => {
          setAgentMode(config?.mode || 'ask');
          setAgentToolsEnabled(!!config?.toolsEnabled);
        })
        .catch(() => {});
    };
    refreshAgentConfig();
    window.addEventListener('focus', refreshAgentConfig);
    return () => window.removeEventListener('focus', refreshAgentConfig);
  }, []);

  // Reload when the backend signals new messages (agent tool loop, auto mode, …).
  useEffect(() => {
    if (!window.electronAPI?.chat?.onRefresh) return;
    return window.electronAPI.chat.onRefresh(({ chatId }) => {
      if (chatId && chatId === useChatStore.getState().currentChatId) {
        window.electronAPI!.db.getMessages(chatId)
          .then((msgs) => useChatStore.getState().setMessagesForChat(chatId, msgs))
          .catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    const persistedRunIds = scopedMessages.map((message) => parseCommandRun(message.toolRun)?.id).filter(Boolean) as string[];
    if (persistedRunIds.length && currentChatId) clearLiveToolRuns(persistedRunIds, currentChatId);
  }, [scopedMessages, clearLiveToolRuns, currentChatId]);

  useEffect(() => {
    if (!window.electronAPI?.chat?.onStreamEvent) return;
    return window.electronAPI.chat.onStreamEvent((event) => {
      const state = useChatStore.getState();
      const eventChatId = event.chatId || chatIdForRequest(state.chatRuns, event.requestId);
      if (!eventChatId) return;
      const requestId = state.chatRuns[eventChatId]?.requestId || null;
      if (!shouldAcceptLiveRequestEvent(requestId, event.requestId)) return;

      // Native provider: het assistent-segment bestaat vooraf en groeit live.
      if (event.type === 'assistant_start' && event.message) {
        state.startChatRunNativeMessage(eventChatId, event.requestId, event.message);
        return;
      }
      if (event.type === 'assistant_delta' && event.messageId && event.delta) {
        state.appendChatRunNativeMessage(eventChatId, event.requestId, event.messageId, event.delta);
        return;
      }
      if (event.type === 'done' || event.type === 'error') {
        state.endChatRunNativeMessage(eventChatId, event.requestId);
        return;
      }

      if (!event.type.startsWith('tool_run_') && event.type !== 'tool_activity') return;

      if (event.type === 'tool_activity' && event.activityId && event.phase && event.label) {
        useChatStore.getState().upsertLiveToolActivity({
          id: event.activityId,
          chatId: eventChatId,
          requestId: event.requestId,
          anchorMessageId: event.anchorMessageId,
          phase: event.phase,
          label: event.label,
          detail: event.detail,
          approvalStatus: event.approvalStatus,
          attempt: event.attempt,
          stopReason: event.stopReason,
          tone: event.tone,
        });
      }

      if ((event.type === 'tool_run_started' || event.type === 'tool_run_finished') && event.run) {
        useChatStore.getState().upsertLiveToolRun(event.run, {
          chatId: eventChatId,
          requestId: event.requestId,
          anchorMessageId: event.anchorMessageId,
        });
      }

      if (event.type === 'tool_run_output' && event.runId && event.stream && event.delta) {
        useChatStore.getState().appendLiveToolRunOutput(
          { chatId: eventChatId, requestId: event.requestId },
          event.runId,
          event.stream,
          event.delta,
        );
      }
    });
  }, []);

  const applyUtilityPanel = React.useCallback((panel: UtilityPanelId | null) => {
    activeUtilityPanelRef.current = panel;
    setShowSystemPromptEditor(panel === 'system-prompt');
    setShowAutoModePanel(panel === 'auto-mode');
    setShowTerminal(panel === 'terminal');
  }, [setShowSystemPromptEditor, setShowTerminal]);

  const closeInlineUtilityPanels = React.useCallback(() => {
    activeUtilityPanelRef.current = null;
    setShowSystemPromptEditor(false);
    setShowAutoModePanel(false);
  }, [setShowSystemPromptEditor]);

  const handleSystemPromptToggle = React.useCallback(() => {
    applyUtilityPanel(toggledUtilityPanel(activeUtilityPanelRef.current, 'system-prompt'));
  }, [applyUtilityPanel]);

  const handleAutoModeToggle = React.useCallback(() => {
    applyUtilityPanel(toggledUtilityPanel(activeUtilityPanelRef.current, 'auto-mode'));
  }, [applyUtilityPanel]);

  const handleTerminalToggle = React.useCallback(() => {
    applyUtilityPanel(toggledUtilityPanel(activeUtilityPanelRef.current, 'terminal'));
  }, [applyUtilityPanel]);

  React.useLayoutEffect(() => {
    if (showSystemPromptEditor) {
      activeUtilityPanelRef.current = 'system-prompt';
      setShowAutoModePanel(false);
      setShowTerminal(false);
    } else if (activeUtilityPanelRef.current === 'system-prompt') {
      activeUtilityPanelRef.current = null;
    }
  }, [setShowTerminal, showSystemPromptEditor]);

  React.useLayoutEffect(() => {
    if (showTerminal) {
      activeUtilityPanelRef.current = 'terminal';
      closeInlineUtilityPanels();
      activeUtilityPanelRef.current = 'terminal';
    } else if (activeUtilityPanelRef.current === 'terminal') {
      activeUtilityPanelRef.current = null;
    }
  }, [closeInlineUtilityPanels, showTerminal]);

  useEffect(() => {
    const handleToggleRequest = (event: Event) => {
      const panel = (event as CustomEvent<unknown>).detail;
      if (!isUtilityPanelId(panel)) return;
      applyUtilityPanel(toggledUtilityPanel(activeUtilityPanelRef.current, panel));
    };
    window.addEventListener(UTILITY_PANEL_TOGGLE_EVENT, handleToggleRequest);
    return () => window.removeEventListener(UTILITY_PANEL_TOGGLE_EVENT, handleToggleRequest);
  }, [applyUtilityPanel]);

  useEffect(() => {
    if (!showSystemPromptEditor && !showAutoModePanel && !showTerminal) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') applyUtilityPanel(null);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [applyUtilityPanel, showAutoModePanel, showSystemPromptEditor, showTerminal]);

  if (!currentChatId) {
    const providerChips = [
      {
        name: 'ChatGPT websessie',
        status: chatgptSessionActive === true ? 'online' : 'offline',
      },
      {
        name: 'OpenAI API',
        status: authStatus.openai?.authenticated && authStatus.openai.method === 'apikey' ? 'online' : 'offline',
      },
      {
        name: 'Codex CLI',
        status: cliConnectionChipStatus({
          authenticated: !!authStatus.codex?.authenticated,
          hasLiveCatalog: models.some((model) => model.provider === 'codex'),
          refreshing: isRefreshingModels,
        }),
      },
      {
        name: 'Gemini',
        status: authStatus.google?.authenticated ? 'online' : 'offline',
      },
      {
        name: 'Claude',
        status: authStatus.anthropic?.authenticated ? 'online' : 'offline',
      },
      {
        name: 'Antigravity',
        status: authStatus.antigravity?.authenticated ? 'online' : 'offline',
      },
      {
        name: 'Ollama',
        status: authStatus.ollama?.authenticated ? 'online' : 'offline',
      },
    ] as const;

    return (
      <div className="empty-state view-fade-in">
        <img className="empty-state-icon" src="./icon.png" alt="" />
        <div className="empty-state-title">{t('app.title')}</div>
        <div className="empty-state-text">{t('app.tagline')}</div>
        <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
          {providerChips.map(({ name, status }) => (
            <div key={name} className="model-chip" style={{ cursor: 'default' }}>
              <span className={`status-dot ${status}`} />
              {name}
            </div>
          ))}
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { void startNewChat(); }}
          style={{ marginTop: 'var(--space-4)' }}
        >
          + {t('chat.newChat')}
        </button>
      </div>
    );
  }

  const streamingStatusElapsed =
    streamingStatusStartedAt && streamingStatus
      ? Math.max(0, Math.floor((statusNow - streamingStatusStartedAt) / 1000))
      : 0;
  const visibleStreamingStatusBase =
    streamingStatus && streamingStatusElapsed >= 1
      ? `${streamingStatus} · ${streamingStatusElapsed}s`
      : streamingStatus;

  return (
    <div className="chat-view-shell chat-view-enter flex-col" style={{ height: '100%', display: 'flex' }}>
      <div className="chat-toolbar">
        <div ref={utilityToolsRef} className="chat-toolbar-tools">
          <button
            className={`chat-toolbar-btn ${showSystemPromptEditor ? 'active' : ''}`}
            onClick={handleSystemPromptToggle}
            title={t('chat.systemPrompt')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" /><path d="M12 4v16" />
            </svg>
            {t('chat.systemPrompt')}
          </button>
          <button
            className={`chat-toolbar-btn ${showAutoModePanel || autoModeActive ? 'active' : ''}`}
            onClick={handleAutoModeToggle}
            title={t('autoMode.title')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v4" /><path d="m16.2 7.8 2.9-2.9" /><path d="M18 12h4" /><path d="m16.2 16.2 2.9 2.9" /><path d="M12 18v4" /><path d="m4.9 19.1 2.9-2.9" /><path d="M2 12h4" /><path d="m4.9 4.9 2.9 2.9" />
            </svg>
            {t('autoMode.title')}
          </button>
          <button
            data-utility-panel="terminal"
            className={`chat-toolbar-btn ${showTerminal ? 'active' : ''}`}
            onClick={handleTerminalToggle}
            title="Agent terminal"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Terminal
          </button>
        </div>
        {agentToolsEnabled && (currentChat?.agentMode || agentMode) !== 'ask' && (
          <span className={`agent-mode-badge ${(currentChat?.agentMode || agentMode) === 'full' ? 'danger' : 'limited'}`}>
            {(currentChat?.agentMode || agentMode) === 'full' ? 'PC-toegang: full zonder vragen' : 'PC-toegang: auto in werkmap'}
            {currentChat?.agentMode ? ' (deze chat)' : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {effectiveProjectPath && (
          <span className="project-path-chip" title={effectiveProjectPath}>
            {currentFolder ? currentFolder.name : legacyChatProjectPath ? 'Legacy chat-project' : 'Default workspace'} · {effectiveProjectPath}
          </span>
        )}
        {autoModeActive && (
          <span className={`status-badge ${autoModeStatus === 'paused' ? 'online' : 'limited'}`} title={autoModeDetail || t('autoMode.running')}>
            {autoModeDetail || (autoModeStatus === 'paused' ? t('autoMode.paused') : t('autoMode.running'))}
          </span>
        )}
      </div>

      <div
        ref={utilityStageRef}
        className={`utility-panel-stage ${autoModePresence.mounted ? 'auto-mode-overlay' : ''}`}
        style={{ height: showSystemPromptEditor ? utilityPanelHeights.systemPrompt : 0 }}
      >
        <div ref={systemPromptPanelRef} className={`utility-panel-shell ${systemPromptPresence.phase}`} aria-hidden={!showSystemPromptEditor} inert={!showSystemPromptEditor}>
          <SystemPromptEditor key={currentChatId || 'geen-chat'} active={showSystemPromptEditor} />
        </div>
        <div ref={autoModePanelRef} className={`utility-panel-shell auto-mode-utility-shell ${autoModePresence.phase}`} aria-hidden={!showAutoModePanel} inert={!showAutoModePanel}>
          <AutoModePanel key={currentChatId || 'geen-chat'} onClose={() => applyUtilityPanel(null)} />
        </div>
      </div>

      <div ref={messagesScrollRef} className="chat-messages">
        <div key={currentChatId} className="chat-messages-inner chat-switch-fade">
          {renderItems.map((item, index) => (
            item.type === 'message' ? (
              <MessageBubble
                key={item.message.id}
                message={item.message}
                isStreaming={item.message.id === pendingStreamMessage?.id}
                actionsDisabled={isStreaming && activeTurnStartIndex >= 0 && index >= activeTurnStartIndex}
                hideActions={renderItems[index + 1]?.type === 'command-run-group'}
                continuation={continuationFlags[index]}
                liveStatus={
                  item.message.id === pendingStreamMessage?.id && !item.message.content
                    ? (visibleStreamingStatusBase || 'werkt…')
                    : index === activeStreamHeaderIndex
                      ? (visibleStreamingStatusBase || 'werkt…')
                      : undefined
                }
              />
            ) : (
              <div key={item.key} className="message tool-output-message">
                <div className="message-avatar-spacer" />
                <div className="message-body">
                  <CommandRunActivity group={item.group} />
                </div>
              </div>
            )
          ))}

          <div ref={messagesEndRef} className="messages-end-spacer" />
        </div>
      </div>

      <ChatInput approvals={approvals} onRespondApproval={onRespondApproval} />
    </div>
  );
};

export default ChatView;
