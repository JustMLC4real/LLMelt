import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Terminal, Check, X } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { useProfileStore } from '../stores/profile-store';
import { useUpdateStore } from '../stores/update-store';
import Titlebar from './Titlebar';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import TokenDashboard from './TokenDashboard';
import ApiKeyChecker from './ApiKeyChecker';
import Settings from './Settings';
import { startNewChat, lastUsedFolderId } from './new-chat';
import { ONBOARDING_DONE_KEY, ONBOARDING_LAUNCH_EVENT } from './onboarding-launch';
import type { AIModel, AutoModeState, ProviderType } from '../providers/types';
import { connectedModels } from './model-utils';
import {
  isChatgptCatalogReady,
  modelsInCurrentChatgptCatalog,
  retryChatgptCatalog,
} from './chatgpt-catalog-sync';
import { settleLiveCatalog } from './live-catalog-settle';
import { usePanelPresence } from './use-panel-presence';
import { clampPanelWidth, draggedPanelWidth, keyboardPanelWidth, type HorizontalPanelEdge } from './panel-resize';
import {
  approvalTitle,
  deferAgentApproval,
  deferAgentApprovalsOutsideChat,
  enqueueAgentApproval,
  nextModalAgentApproval,
  removeAgentApproval,
  type AgentApprovalRequest,
  type QueuedAgentApproval,
} from './approval-queue';

const loadTerminalPanel = () => import('./TerminalPanel');
const TerminalPanel = lazy(loadTerminalPanel);
const OnboardingGuide = lazy(() => import('./OnboardingGuide'));

function applyAutoModeState(state: AutoModeState) {
  useProviderStore.getState().setAutoModeState(state);
}

const SIDEBAR_WIDTH_KEY = 'superapp:sidebar-width';
const TERMINAL_WIDTH_KEY = 'superapp:terminal-width';

function savedPanelWidth(key: string, fallback: number, min: number, max: number) {
  const stored = Number(window.localStorage.getItem(key));
  return clampPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : fallback, min, max);
}

const App: React.FC = () => {
  const { currentChatId, currentView, showTerminal, setShowTerminal, sidebarCollapsed } = useChatStore();
  const [approvals, setApprovals] = useState<QueuedAgentApproval[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [terminalWasOpened, setTerminalWasOpened] = useState(showTerminal);
  const [terminalPrepared, setTerminalPrepared] = useState(showTerminal);
  const [sidebarWidth, setSidebarWidth] = useState(() => savedPanelWidth(SIDEBAR_WIDTH_KEY, 280, 220, 520));
  const [terminalWidth, setTerminalWidth] = useState(() => savedPanelWidth(TERMINAL_WIDTH_KEY, 380, 280, 860));
  const terminalPresence = usePanelPresence(showTerminal);
  const chatgptSessionActive = useProviderStore((state) => state.chatgptSessionActive);
  const isRefreshingModels = useProviderStore((state) => state.isRefreshingModels);
  const codexCatalogAvailable = useProviderStore((state) => state.modelsByProvider.codex.length > 0);
  const chatgptCatalogSyncStarted = React.useRef(false);
  const codexCatalogSyncStarted = React.useRef(false);

  const panelMaximum = useCallback((edge: HorizontalPanelEdge) => {
    const reservedMain = 460;
    return edge === 'left'
      ? Math.max(220, Math.min(520, window.innerWidth - (showTerminal ? terminalWidth : 0) - reservedMain))
      : Math.max(280, Math.min(860, window.innerWidth - (sidebarCollapsed ? 44 : sidebarWidth) - reservedMain));
  }, [showTerminal, sidebarCollapsed, sidebarWidth, terminalWidth]);

  const beginPanelResize = useCallback((
    edge: HorizontalPanelEdge,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startClientX = event.clientX;
    const startWidth = edge === 'left' ? sidebarWidth : terminalWidth;
    const min = edge === 'left' ? 220 : 280;
    let finalWidth = startWidth;
    document.body.classList.add('panel-resize-active');

    const move = (moveEvent: PointerEvent) => {
      finalWidth = draggedPanelWidth(edge, startWidth, startClientX, moveEvent.clientX, min, panelMaximum(edge));
      if (edge === 'left') setSidebarWidth(finalWidth);
      else setTerminalWidth(finalWidth);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.classList.remove('panel-resize-active');
      window.localStorage.setItem(edge === 'left' ? SIDEBAR_WIDTH_KEY : TERMINAL_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }, [panelMaximum, sidebarWidth, terminalWidth]);

  const resizePanelWithKeyboard = useCallback((edge: HorizontalPanelEdge, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const min = edge === 'left' ? 220 : 280;
    const current = edge === 'left' ? sidebarWidth : terminalWidth;
    const next = keyboardPanelWidth(edge, current, event.key, min, panelMaximum(edge));
    if (edge === 'left') setSidebarWidth(next); else setTerminalWidth(next);
    window.localStorage.setItem(edge === 'left' ? SIDEBAR_WIDTH_KEY : TERMINAL_WIDTH_KEY, String(next));
  }, [panelMaximum, sidebarWidth, terminalWidth]);

  useEffect(() => {
    if (showTerminal) setTerminalWasOpened(true);
  }, [showTerminal]);

  useEffect(() => {
    let cancelled = false;

    // Xterm is beduidend zwaarder. Warm de module en de verborgen terminal pas in
    // browser-idle op, zodat de eerste zichtbare slide niet tegelijk xterm opbouwt.
    const idleId = window.requestIdleCallback(() => {
      void loadTerminalPanel()
        .then(() => { if (!cancelled) setTerminalPrepared(true); })
        .catch(() => {});
    }, { timeout: 1500 });
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idleId);
    };
  }, []);

  useEffect(() => {
    if (!showTerminal) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowTerminal(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [setShowTerminal, showTerminal]);

  // Eerste keer openen -> gids tonen. Daarna alleen nog via Instellingen.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.settings.get(ONBOARDING_DONE_KEY)
      .then((completedAt) => { if (!cancelled && !completedAt) setShowOnboarding(true); })
      .catch(() => {});
    const relaunch = () => setShowOnboarding(true);
    window.addEventListener(ONBOARDING_LAUNCH_EVENT, relaunch);
    return () => { cancelled = true; window.removeEventListener(ONBOARDING_LAUNCH_EVENT, relaunch); };
  }, []);

  // App-update status globaal bijhouden (voor de badge in de sidebar).
  useEffect(() => {
    const { setStatus, setCurrentVersion } = useUpdateStore.getState();
    window.electronAPI?.updater?.getStatus?.()
      .then((result: any) => {
        if (result?.status) setStatus(result.status);
        if (result?.currentVersion) setCurrentVersion(result.currentVersion);
      })
      .catch(() => {});
    const off = window.electronAPI?.updater?.onStatus?.((status: any) => setStatus(status));
    return () => { off?.(); };
  }, []);

  // Een gesprek openen vanuit het Windows tray-menu.
  useEffect(() => {
    const off = window.electronAPI?.tray?.onOpenChat?.((chatId: string) => {
      if (chatId === '__new__') {
        // Tray "Nieuw gesprek" -> echt een gesprek starten in de map waar je laatst
        // werkte (of los), i.p.v. het lege welkomstscherm openen.
        void startNewChat(lastUsedFolderId());
        return;
      }
      const store = useChatStore.getState();
      store.setCurrentView('chat');
      store.setCurrentChat(chatId);
    });
    return () => { off?.(); };
  }, []);

  // Houd het Windows tray-menu realtime gelijk aan de zijbalk: stuur de exacte
  // chat-lijst zodra die verandert (maken/verwijderen/hernoemen). De mapnaam gaat
  // mee zodat een recent gesprek "titel · project" kan tonen.
  const trayChats = useChatStore((state) => state.chats);
  const trayFolders = useChatStore((state) => state.folders);
  useEffect(() => {
    const folderName = new Map(trayFolders.map((folder) => [folder.id, folder.name]));
    window.electronAPI?.tray?.setChats?.(trayChats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      folder: chat.folderId ? folderName.get(chat.folderId) : undefined,
    })));
  }, [trayChats, trayFolders]);

  // Automatisch gegenereerde gesprekstitel in de sidebar bijwerken.
  useEffect(() => {
    const offGenerating = window.electronAPI?.chat?.onTitleGenerating?.(({ chatId }) => {
      useChatStore.getState().setTitleGenerating(chatId, true);
    });
    const offUpdated = window.electronAPI?.chat?.onTitleUpdated?.(({ chatId, title }) => {
      const store = useChatStore.getState();
      store.updateChat(chatId, { title });
      store.setTitleGenerating(chatId, false);
    });
    return () => { offGenerating?.(); offUpdated?.(); };
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const snapshots = await api.tokens.refreshQuotas();
        if (Array.isArray(snapshots)) useProviderStore.getState().setQuotaSnapshots(snapshots);
      } catch {
        // Een quotumbron mag chatten nooit blokkeren; de collector bewaart een
        // expliciete 'niet beschikbaar'-status zodra hij wel kan antwoorden.
      } finally {
        refreshing = false;
      }
    };
    const offUsage = api.tokens.onUsageUpdate((dashboard) => {
      if (Array.isArray(dashboard?.quotas)) useProviderStore.getState().setQuotaSnapshots(dashboard.quotas);
    });
    void refresh();
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      offUsage?.();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        useChatStore.getState().toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Initial data load via IPC
    const loadData = async () => {
      const api = window.electronAPI;
      if (api) {
        const providerStore = useProviderStore.getState();
        const providerIds: ProviderType[] = ['codex', 'openai', 'anthropic', 'google', 'antigravity', 'ollama', 'remote'];
        providerStore.setRefreshingModels(true);

        // Start independent work together. Provider cards update one by one instead
        // of waiting for the slowest CLI/API before any picker becomes usable.
        const modelTasks = providerIds.map(async (provider) => {
          try {
            const models = await api.providers.listModels(provider);
            if (Array.isArray(models)) useProviderStore.getState().setProviderModels(provider, models);
          } catch {
            // Zonder actuele bevestiging blijft deze provider uit de modelkiezer.
            useProviderStore.getState().setProviderModels(provider, []);
          }
        });
        const versionsTask = api.providers.chatgptVersions()
          .then((versions) => {
            if (Array.isArray(versions)) useProviderStore.getState().setChatgptVersions(versions);
          })
          .catch(() => {});

        // De modellenlijst blijft als laatst-bekend-goed staan, ook na uitloggen.
        // Alleen de sessiecheck zegt of ChatGPT echt bruikbaar is.
        const sessionTask = api.auth.chatgptSessionStatus()
          .then((status: any) => {
            if (typeof status?.active === 'boolean') useProviderStore.getState().setChatgptSessionActive(status.active);
          })
          .catch(() => {});

        const chatsTask = Promise.all([api.db.getChats(), api.db.getFolders()])
          .then(([chats, folders]) => {
          useChatStore.getState().setChats(chats);
          useChatStore.getState().setFolders(folders);
          useChatStore.getState().setChatsHydrated(true);
          });

        const authTask = api.auth.getStatus().then((authStatus) => {
          Object.entries(authStatus).forEach(([provider, status]) => {
            useProviderStore.getState().setAuthStatus(provider as any, status as any);
          });
        });

        const accountTask = api.providers.getAccountStatuses().then((accountStatuses) => {
          useProviderStore.getState().setAccountStatuses(accountStatuses);
        });

        const healthTask = api.providers.getHealth().then((health) => {
          Object.entries(health).forEach(([provider, status]) => {
            useProviderStore.getState().setProviderHealth(provider as any, status as any);
          });
        });

        const fallbackTask = api.fallback.getConfig().then((fallback) => {
          useProviderStore.getState().setFallbackConfig(fallback);
        });

        const quotaTask = api.tokens.getQuotas().then((snapshots) => {
          if (Array.isArray(snapshots)) useProviderStore.getState().setQuotaSnapshots(snapshots);
        }).catch(() => {});

        const avatarTask = api.settings.get('profile.avatarDataUrl').then((savedAvatar) => {
          useProfileStore.getState().setUserAvatarDataUrl(typeof savedAvatar === 'string' ? savedAvatar : null);
        }).catch(() => {});

        try {
          await Promise.allSettled([chatsTask, authTask, accountTask, healthTask, fallbackTask, quotaTask, avatarTask]);
          await Promise.allSettled([...modelTasks, versionsTask, sessionTask]);

          // Een verse CLI/websessie kan bij de eerste geldige call nog de ingebouwde
          // of vorige catalogus tonen. Doe vóór de eerste automatische modelkeuze
          // één cachevrije warm-upcall, zodat een clean VM niet eerst 5.2 of een
          // verouderde Direct-slug kiest en pas na handmatig vernieuwen corrigeert.
          const initialCatalogSettleTasks: Promise<unknown>[] = [];
          const initialState = useProviderStore.getState();
          if (initialState.modelsByProvider.codex.length > 0) {
            initialCatalogSettleTasks.push(settleLiveCatalog({
              delays: [1_500],
              refresh: () => api.providers.refreshModels('codex'),
              apply: (models) => {
                if (Array.isArray(models)) useProviderStore.getState().setProviderModels('codex', models);
              },
            }));
          }
          if (initialState.chatgptSessionActive === true) {
            initialCatalogSettleTasks.push(settleLiveCatalog({
              delays: [1_500],
              refresh: async () => {
                const models = await api.providers.refreshModels('openai');
                const versions = await api.providers.chatgptVersions();
                return { models, versions };
              },
              apply: ({ models, versions }) => {
                const store = useProviderStore.getState();
                if (Array.isArray(models)) store.setProviderModels('openai', models);
                if (Array.isArray(versions)) store.setChatgptVersions(versions);
              },
            }));
          }
          await Promise.allSettled(initialCatalogSettleTasks);

          const settledState = useProviderStore.getState();
          ensureActiveDiscoveredModel(modelsInCurrentChatgptCatalog(
            settledState.models,
            settledState.chatgptVersions,
          ));
          providerStore.setRefreshingModels(false);

        } catch (err) {
          console.error("Failed to load DB data:", err);
          providerStore.setRefreshingModels(false);
        }
      }
    };

    loadData();

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Goedkeuringen kunnen uit meerdere gelijktijdige chats komen. Bewaar ze daarom
  // allemaal; buiten de popup klikken stelt alleen uit en beantwoordt niets.
  useEffect(() => {
    if (!window.electronAPI?.agent) return;
    const agent = window.electronAPI.agent;
    const offRequest = agent.onApprovalRequest((req) => {
      setApprovals((queue) => enqueueAgentApproval(queue, req, useChatStore.getState().currentChatId));
    });
    const offResolved = agent.onApprovalResolved((result) => {
      setApprovals((queue) => removeAgentApproval(queue, result.id));
    });
    agent.getPendingApprovals()
      .then((pending) => setApprovals((queue) => pending.reduce(
        (next: QueuedAgentApproval[], request: AgentApprovalRequest) => (
          enqueueAgentApproval(next, request, useChatStore.getState().currentChatId)
        ),
        queue,
      )))
      .catch(() => {});
    return () => { offRequest(); offResolved(); };
  }, []);

  // De sessie-cookie kan al geldig zijn terwijl /backend-api/models direct na
  // login nog leeg of niet-leeg maar verouderd antwoordt. Blijf die live catalogus
  // achtergrondmatig synchroniseren; de gebruiker hoeft de picker niet opnieuw
  // te openen of zelf op "Opnieuw laden" te klikken.
  useEffect(() => {
    const api = window.electronAPI;
    if (chatgptSessionActive !== true) {
      chatgptCatalogSyncStarted.current = false;
      return undefined;
    }
    if (!api || isRefreshingModels || chatgptCatalogSyncStarted.current) return undefined;
    chatgptCatalogSyncStarted.current = true;

    let cancelled = false;
    const load = async () => {
      // Eerst de modellen cachevrij ophalen; versions() leest daarna de presets
      // die bij exact diezelfde backend-snapshot horen.
      const models = await api.providers.refreshModels('openai');
      const [versions, session] = await Promise.all([
        api.providers.chatgptVersions(),
        api.auth.chatgptSessionStatus(),
      ]);
      return {
        models: Array.isArray(models) ? models : [],
        versions: Array.isArray(versions) ? versions : [],
        sessionActive: session?.active === true,
      };
    };
    const apply = (snapshot: Awaited<ReturnType<typeof load>>) => {
      const store = useProviderStore.getState();
      store.setProviderModels('openai', snapshot.models);
      store.setChatgptVersions(snapshot.versions);
      store.setChatgptSessionActive(snapshot.sessionActive);
      ensureActiveDiscoveredModel(modelsInCurrentChatgptCatalog(
        useProviderStore.getState().models,
        snapshot.versions,
      ));
    };

    void (async () => {
      const current = useProviderStore.getState();
      if (!isChatgptCatalogReady(current.modelsByProvider.openai, current.chatgptVersions)) {
        await retryChatgptCatalog({
          isCancelled: () => cancelled,
          load,
          apply,
        });
      }
      if (cancelled || useProviderStore.getState().chatgptSessionActive !== true) return;
      await settleLiveCatalog({
        isCancelled: () => cancelled,
        refresh: load,
        apply,
      });
    })();

    return () => { cancelled = true; };
  }, [chatgptSessionActive, isRefreshingModels]);

  // Codex kan bij de eerste `debug models` al een geldige, maar nog niet
  // bijgewerkte catalogus teruggeven. Na de opwarmperiode vragen we daarom twee
  // keer cachevrij opnieuw; modelnamen worden nergens geraden of hardgecodeerd.
  useEffect(() => {
    const api = window.electronAPI;
    if (!codexCatalogAvailable) {
      codexCatalogSyncStarted.current = false;
      return undefined;
    }
    if (!api || isRefreshingModels || codexCatalogSyncStarted.current) return undefined;
    codexCatalogSyncStarted.current = true;

    let cancelled = false;
    void settleLiveCatalog({
      isCancelled: () => cancelled,
      refresh: async () => ({
        models: await api.providers.refreshModels('codex'),
      }),
      apply: (snapshot) => {
        useProviderStore.getState().setProviderModels(
          'codex',
          Array.isArray(snapshot.models) ? snapshot.models : [],
        );
      },
    });

    return () => { cancelled = true; };
  }, [codexCatalogAvailable, isRefreshingModels]);

  // Een popup uit chat A mag na een wissel nooit boven chat B blijven hangen. De
  // aanvraag blijft onbeantwoord in de wachtrij en verschijnt bij A in de dock.
  useEffect(() => {
    setApprovals((queue) => deferAgentApprovalsOutsideChat(queue, currentChatId));
  }, [currentChatId]);

  // Auto Mode draait door als het paneel wordt gesloten. Houd de globale status
  // daarom hier bij en bewaar de chatId waarop de run daadwerkelijk gestart is.
  useEffect(() => {
    const autoMode = window.electronAPI?.autoMode;
    if (!autoMode) return;
    autoMode.getStatus().then(applyAutoModeState).catch(() => {});
    return autoMode.onIteration(applyAutoModeState);
  }, []);

  const approval = nextModalAgentApproval(approvals, currentChatId);

  const respondApproval = (target: QueuedAgentApproval, approved: boolean) => {
    setApprovals((queue) => removeAgentApproval(queue, target.id));
    void window.electronAPI?.agent.respondApproval(target.id, approved);
  };

  const renderMainContent = () => {
    switch (currentView) {
      case 'tokens':
        return <TokenDashboard />;
      case 'keyChecker':
        return <ApiKeyChecker />;
      case 'settings':
        return <Settings />;
      case 'chat':
      default:
        return <ChatView approvals={approvals} onRespondApproval={respondApproval} />;
    }
  };

  return (
    <>
      <Titlebar />
      <Suspense fallback={null}>
        {showOnboarding && <OnboardingGuide onClose={() => setShowOnboarding(false)} />}
      </Suspense>
      <div
        className="app-layout"
        style={{
          '--sidebar-width': `${sidebarWidth}px`,
          '--terminal-panel-width': `${terminalWidth}px`,
        } as React.CSSProperties}
      >
        <Sidebar />
        {!sidebarCollapsed && (
          <div
            className="panel-resize-handle sidebar-resize-handle"
            role="separator"
            aria-label="Breedte van zijbalk aanpassen"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(event) => beginPanelResize('left', event)}
            onKeyDown={(event) => resizePanelWithKeyboard('left', event)}
          />
        )}
        <main className="main-content">
          <Suspense fallback={null}>
            <div key={currentView} className="view-transition">
              {renderMainContent()}
            </div>
          </Suspense>
        </main>
        {(showTerminal || terminalWasOpened || terminalPrepared) && (
          <div
            data-terminal-panel
            className={`terminal-panel-slot ${terminalPresence.phase}`}
            aria-hidden={!showTerminal}
            inert={!showTerminal}
          >
            <div
              className="panel-resize-handle terminal-resize-handle"
              role="separator"
              aria-label="Breedte van terminal aanpassen"
              aria-orientation="vertical"
              tabIndex={showTerminal ? 0 : -1}
              onPointerDown={(event) => beginPanelResize('right', event)}
              onKeyDown={(event) => resizePanelWithKeyboard('right', event)}
            />
            <Suspense fallback={null}><TerminalPanel /></Suspense>
          </div>
        )}
      </div>

      {approval && (
        <div className="model-selector-overlay" onClick={() => setApprovals((queue) => deferAgentApproval(queue, approval.id))}>
          <div className="approval-dialog motion-panel" onClick={(e) => e.stopPropagation()}>
            <div className="approval-title">
              <Terminal size={16} />
              <span>De agent vraagt goedkeuring: {approvalTitle(approval)}</span>
            </div>
            <pre className="approval-command">{approval.command}</pre>
            <div className="approval-cwd">
              {approval.kind === 'command' ? `Shell: ${approval.shell || 'default'} | ` : approval.path ? `Pad: ${approval.path} | ` : ''}
              Werkmap: {approval.cwd}
            </div>
            <div className="approval-actions">
              <button className="btn btn-primary" onClick={() => respondApproval(approval, true)}>
                <Check size={15} /> Toestaan
              </button>
              <button className="btn btn-secondary" onClick={() => respondApproval(approval, false)} style={{ color: 'var(--color-error)' }}>
                <X size={15} /> Weigeren
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default App;

function ensureActiveDiscoveredModel(models: AIModel[]) {
  const chatState = useChatStore.getState();
  const providerState = useProviderStore.getState();
  const available = connectedModels(models, providerState.authStatus, providerState.chatgptSessionActive);
  const currentModel = available.find(
    (model) =>
      model.provider === chatState.activeProvider &&
      model.id === chatState.activeModelId,
  );
  if (currentModel) return;

  const firstAvailable = available[0];
  if (firstAvailable) {
    chatState.setActiveModel(firstAvailable.id, firstAvailable.provider, firstAvailable.runConfig);
  }
}
