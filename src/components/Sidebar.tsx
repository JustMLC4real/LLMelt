import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, KeyRound, Loader2, Menu, MessageSquarePlus, PanelLeftClose, Pencil, Search, Settings, Trash2, type LucideIcon } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { useUpdateStore, updateNeedsAttention } from '../stores/update-store';
import type { Chat } from '../providers/types';
import ConfirmDialog from './ConfirmDialog';
import { FlipText } from './ui';
import { requestComposerFocus } from './composer-focus';
import { startNewChat } from './new-chat';
import { requestIdsForChats } from './chat-run-state';
import { activeProjectFolderId, isCollapsedProjectActive } from './draft-chat';

interface SidebarProps {
  collapsed?: boolean;
  mobileDrawerOpen?: boolean;
  onToggle?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ collapsed, mobileDrawerOpen = false, onToggle }) => {
  const { t } = useTranslation();
  const {
    chats,
    draftChats,
    currentChatId,
    folders,
    sidebarCollapsed,
    setCurrentChat,
    addChat,
    removeChat,
    updateChat,
    setCurrentView,
    currentView,
    generatingTitleChatIds,
    chatRuns,
    chatsHydrated,
    addFolder,
    updateFolder,
    removeFolder,
    toggleSidebar,
  } = useChatStore();
  const displayCollapsed = collapsed ?? sidebarCollapsed;
  const handleToggle = onToggle ?? toggleSidebar;
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [deletingChats, setDeletingChats] = useState<Set<string>>(new Set());
  const [deletingFolders, setDeletingFolders] = useState<Set<string>>(new Set());
  const [enteringChats, setEnteringChats] = useState<Set<string>>(new Set());
  const [enteringFolders, setEnteringFolders] = useState<Set<string>>(new Set());
  const [pendingFolderDelete, setPendingFolderDelete] = useState<{ id: string; name: string; chatCount: number } | null>(null);
  const activeFolderId = activeProjectFolderId(chats, draftChats, currentChatId);
  const autoModeStatus = useProviderStore((state) => state.autoModeStatus);
  const autoModeChatId = useProviderStore((state) => state.autoModeChatId);
  const updateStatus = useUpdateStore((state) => state.status);
  const showUpdateBadge = updateNeedsAttention(updateStatus.state);
  const updateBadgeText = updateStatus.state === 'downloading'
    ? `${updateStatus.percent}%`
    : updateStatus.state === 'downloaded'
      ? t('sidebar.updateBadge.ready')
      : updateStatus.state === 'installing'
        ? t('sidebar.updateBadge.installing')
        : updateStatus.state === 'error'
          ? t('sidebar.updateBadge.error')
          : t('sidebar.updateBadge.available');
  const updateBadgeTitle = updateStatus.state === 'downloaded'
    ? t('sidebar.updateTitle.ready', { version: updateStatus.version ?? '' })
    : updateStatus.state === 'downloading'
      ? t('sidebar.updateTitle.downloading', { percent: updateStatus.percent })
      : updateStatus.state === 'installing'
        ? t('sidebar.updateTitle.installing')
        : updateStatus.state === 'error'
          ? t('sidebar.updateTitle.error', { error: updateStatus.error })
          : t('sidebar.updateTitle.available');
  // Elke handmatige beurt blijft bij zijn eigen chat. Auto-modus is nog gekoppeld
  // aan de geopende chat waarop die gestart is.
  const isChatBusy = (chatId: string) => !!chatRuns[chatId] || (autoModeStatus === 'running' && autoModeChatId === chatId);
  const toggleFolderCollapse = (id: string) => setCollapsedFolders((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Nieuw aangemaakte chats/mappen krijgen kort een enter-animatie — ook de
  // állereerste (als de lijst nog leeg was). Bestaande items bij het opstarten
  // animeren niet: die worden meteen als "gezien" gemarkeerd.
  // useLayoutEffect: de class staat er vóór de browser tekent, zodat het item
  // niet eerst vol verschijnt en dán terugspringt naar opacity 0 (dat gaf jank).
  const seenChatIds = useRef<Set<string> | null>(null);
  const seenFolderIds = useRef<Set<string> | null>(null);
  // Elke batch nieuwe items krijgt z'n eigen timer die zichzelf opruimt. We
  // clearen die NIET bij de volgende render — anders annuleert snel achter elkaar
  // toevoegen (spammen) de opruiming en blijft een item half in de enter-state hangen.
  useLayoutEffect(() => {
    if (!chatsHydrated) return; // wacht tot de eerste DB-load klaar is
    if (seenChatIds.current === null) { seenChatIds.current = new Set(chats.map((c) => c.id)); return; }
    const fresh = chats.filter((c) => !seenChatIds.current!.has(c.id)).map((c) => c.id);
    if (!fresh.length) return;
    fresh.forEach((id) => seenChatIds.current!.add(id));
    setEnteringChats((prev) => { const n = new Set(prev); fresh.forEach((id) => n.add(id)); return n; });
    window.setTimeout(() => setEnteringChats((prev) => { const n = new Set(prev); fresh.forEach((id) => n.delete(id)); return n; }), 360);
  }, [chats, chatsHydrated]);
  useLayoutEffect(() => {
    if (!chatsHydrated) return;
    if (seenFolderIds.current === null) { seenFolderIds.current = new Set(folders.map((f) => f.id)); return; }
    const fresh = folders.filter((f) => !seenFolderIds.current!.has(f.id)).map((f) => f.id);
    if (!fresh.length) return;
    fresh.forEach((id) => seenFolderIds.current!.add(id));
    setEnteringFolders((prev) => { const n = new Set(prev); fresh.forEach((id) => n.add(id)); return n; });
    window.setTimeout(() => setEnteringFolders((prev) => { const n = new Set(prev); fresh.forEach((id) => n.delete(id)); return n; }), 360);
  }, [folders, chatsHydrated]);

  // Krijgt een (lege) map z'n eerste gesprek, dan klapt hij automatisch open —
  // ook als hij eerder handmatig dichtgeklapt was.
  const prevFolderCounts = useRef<Record<string, number>>({});
  useEffect(() => {
    const next: Record<string, number> = {};
    const toOpen: string[] = [];
    for (const folder of folders) {
      const count = chats.reduce((n, c) => (c.folderId === folder.id ? n + 1 : n), 0);
      next[folder.id] = count;
      if ((prevFolderCounts.current[folder.id] ?? 0) === 0 && count > 0) toOpen.push(folder.id);
    }
    prevFolderCounts.current = next;
    if (toOpen.length) {
      setCollapsedFolders((cur) => {
        if (!toOpen.some((id) => cur.has(id))) return cur;
        const n = new Set(cur);
        toOpen.forEach((id) => n.delete(id));
        return n;
      });
    }
  }, [chats, folders]);
  const chatsLabel = t('sidebar.chats');
  const projectsLabel = t('sidebar.projects');
  const projectlessLabel = t('sidebar.projectlessChats');

  const filteredChats = chats.filter((chat) => chat.title.toLowerCase().includes(searchQuery.toLowerCase()));
  // Een chat met een folderId van een niet-bestaande map telt als "zonder project",
  // zodat zo'n gesprek nooit uit de zijbalk kan verdwijnen.
  const folderIds = new Set(folders.map((folder) => folder.id));
  const uncategorizedChats = filteredChats.filter((chat) => !chat.folderId || !folderIds.has(chat.folderId));
  const chatsByFolder = folders.map((folder) => ({
    folder,
    chats: filteredChats.filter((chat) => chat.folderId === folder.id),
  }));

  // "Presence" voor de secties: houd de kop nog even in beeld tijdens de uit-animatie,
  // zodat "Gesprekken" / "Projecten" netjes in- én uitfaden (i.p.v. poppen).
  const uncatShouldShow = uncategorizedChats.length > 0;
  const [uncatMounted, setUncatMounted] = useState(uncatShouldShow);
  const [uncatLeaving, setUncatLeaving] = useState(false);
  useEffect(() => {
    if (uncatShouldShow) { setUncatMounted(true); setUncatLeaving(false); return; }
    if (!uncatMounted) return;
    setUncatLeaving(true);
    const t = window.setTimeout(() => { setUncatMounted(false); setUncatLeaving(false); }, 260);
    return () => clearTimeout(t);
  }, [uncatShouldShow, uncatMounted]);

  const projShouldShow = folders.length > 0;
  const [projMounted, setProjMounted] = useState(projShouldShow);
  const [projLeaving, setProjLeaving] = useState(false);
  useEffect(() => {
    if (projShouldShow) { setProjMounted(true); setProjLeaving(false); return; }
    if (!projMounted) return;
    setProjLeaving(true);
    const t = window.setTimeout(() => { setProjMounted(false); setProjLeaving(false); }, 260);
    return () => clearTimeout(t);
  }, [projShouldShow, projMounted]);

  const handleNewChat = (folderId?: string) => startNewChat(folderId);

  const cancelWorkForChats = (chatIds: string[]) => {
    if (!chatIds.length) return;
    const ids = new Set(chatIds);
    const state = useChatStore.getState();
    for (const requestId of requestIdsForChats(state.chatRuns, ids)) {
      void window.electronAPI?.chat.cancel(requestId);
    }
    const providerState = useProviderStore.getState();
    if (
      providerState.autoModeChatId
      && ids.has(providerState.autoModeChatId)
      && (providerState.autoModeStatus === 'running' || providerState.autoModeStatus === 'paused')
    ) {
      void window.electronAPI?.autoMode.stop();
    }
  };

  const handleDeleteChat = async (id: string) => {
    // Eerst helemaal uit-animeren (0.22s), dan pas echt verwijderen — iets langer
    // dan de animatie zodat 'ie altijd netjes afspeelt.
    setDeletingChats((prev) => new Set(prev).add(id));
    cancelWorkForChats([id]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 260));
      if (window.electronAPI) await window.electronAPI.db.deleteChat(id);
      removeChat(id);
    } finally {
      setDeletingChats((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handleRenameChat = async (id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    updateChat(id, { title: clean });
    if (window.electronAPI) await window.electronAPI.db.updateChat(id, { title: clean });
  };

  const handleCreateProject = async () => {
    const selected = await window.electronAPI?.files.selectDirectory();
    if (!selected) return;
    const name = selected.split(/[\\/]/).filter(Boolean).pop() || t('sidebar.defaultProjectName');
    let folder = {
      id: crypto.randomUUID(),
      name,
      projectPath: selected,
      sortOrder: folders.length,
      createdAt: new Date().toISOString(),
    };
    if (window.electronAPI) {
      const created = await window.electronAPI.db.createFolder(name);
      const saved = await window.electronAPI.db.updateFolder(created.id, { projectPath: selected });
      folder = saved || { ...created, projectPath: selected };
    }
    addFolder(folder);
    await handleNewChat(folder.id);
  };

  // Een project wissen verwijdert ook de gesprekken erin -> eerst bevestigen
  // via een in-app dialoog (zie ConfirmDialog onderaan de render).
  const requestDeleteFolder = (id: string) => {
    const folder = folders.find((candidate) => candidate.id === id);
    const chatCount = chats.filter((chat) => chat.folderId === id).length;
    setPendingFolderDelete({ id, name: folder?.name || t('sidebar.thisProject'), chatCount });
  };

  const confirmDeleteFolder = async () => {
    const pending = pendingFolderDelete;
    if (!pending) return;
    setPendingFolderDelete(null);
    const { id } = pending;
    cancelWorkForChats(chats.filter((chat) => chat.folderId === id).map((chat) => chat.id));
    setDeletingFolders((prev) => new Set(prev).add(id));
    try {
      await new Promise((resolve) => setTimeout(resolve, 280));
      if (window.electronAPI) await window.electronAPI.db.deleteFolder(id);
      removeFolder(id);
    } finally {
      // Ook bij een fout de rij weer normaal tonen i.p.v. half-uitgefadet blijven staan.
      setDeletingFolders((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handleSetFolderProject = async (id: string) => {
    const selected = await window.electronAPI?.files.selectDirectory();
    if (!selected) return;
    updateFolder(id, { projectPath: selected });
    const saved = await window.electronAPI?.db.updateFolder(id, { projectPath: selected });
    if (saved) updateFolder(id, { projectPath: saved.projectPath || selected });
  };

  if (displayCollapsed) {
    return (
      <div className="sidebar collapsed">
        <button className="btn-icon sidebar-icon-btn" onClick={handleToggle} title={t('sidebar.open')} aria-label={t('sidebar.open')}>
          <Menu size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className={`sidebar ${mobileDrawerOpen ? 'mobile-drawer-open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="font-semibold" style={{ fontSize: 'var(--font-size-md)' }}>
            <FlipText text={t('app.title')} />
          </span>
        </div>
        <button className="btn-icon sidebar-icon-btn" onClick={handleToggle} title={t('sidebar.collapse')} aria-label={t('sidebar.collapse')}>
          <PanelLeftClose size={18} />
        </button>
      </div>

      <div className="sidebar-actions">
        <button className="new-chat-btn" onClick={() => handleNewChat()}>
          <MessageSquarePlus size={16} />
          <FlipText text={t('chat.newChat')} />
        </button>
        <button className="sidebar-add-folder compact" onClick={handleCreateProject}>
          <FolderPlus size={16} />
          <FlipText text={t('sidebar.newProject')} />
        </button>
      </div>

      <div className="sidebar-search-wrap">
        <div className="sidebar-search">
          <span className="sidebar-search-icon"><Search size={14} /></span>
          <input className="input" type="text" placeholder={t('common.search')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
      </div>

      <div className="sidebar-content">
        {projMounted && (
        <div className={`sidebar-section ${projLeaving ? 'section-leaving' : 'section-entering'}`}>
        <div className="sidebar-section-title"><FlipText text={projectsLabel} /></div>
        {chatsByFolder.map(({ folder, chats: folderChats }) => {
          const hasChats = folderChats.length > 0;
          // Lege map is simpelweg "dicht": geen pijl nodig. Pas met chats erin kan
          // je in-/uitklappen. Een nieuw gesprek klapt de map automatisch open.
          const collapsed = hasChats && collapsedFolders.has(folder.id);
          const folderBusy = collapsed && folderChats.some((chat) => isChatBusy(chat.id));
          const activeProject = isCollapsedProjectActive(activeFolderId, folder.id, collapsed);
          return (
          <div key={folder.id} className={`sidebar-folder-group ${deletingFolders.has(folder.id) ? 'deleting' : enteringFolders.has(folder.id) ? 'entering' : ''}`}>
            <div className={`folder-item ${activeProject ? 'active' : ''}`} aria-current={activeProject ? 'true' : undefined}>
              {hasChats ? (
                <button
                  className="folder-collapse-btn"
                  onClick={() => toggleFolderCollapse(folder.id)}
                  title={collapsed ? t('sidebar.expandProject') : t('sidebar.collapseProject')}
                  aria-label={collapsed ? t('sidebar.expandProject') : t('sidebar.collapseProject')}
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : (
                <span className="folder-collapse-spacer" />
              )}
              <span className="folder-icon"><Folder size={15} /></span>
              <span className="truncate" style={{ flex: 1 }}>
                {folder.name}
              </span>
              {folderBusy && <Loader2 size={13} className="folder-busy-spinner spin" aria-label={t('sidebar.projectBusy')} />}
              <button
                className={`btn-icon ${folder.projectPath ? 'active' : ''}`}
                onClick={() => handleSetFolderProject(folder.id)}
                title={folder.projectPath ? t('sidebar.projectPathValue', { path: folder.projectPath }) : t('sidebar.chooseProjectPath')}
                aria-label={t('sidebar.chooseProjectPath')}
              >
                <FolderOpen size={14} />
              </button>
              <button className="btn-icon" onClick={() => handleNewChat(folder.id)} title={t('sidebar.newChatInProject')} aria-label={t('sidebar.newChatInProject')}>
                <MessageSquarePlus size={14} />
              </button>
              <button className="btn-icon btn-icon-danger" onClick={() => requestDeleteFolder(folder.id)} title={t('common.delete')} aria-label={t('common.delete')}>
                <Trash2 size={14} />
              </button>
            </div>
            {hasChats && (
              <div className={`sidebar-folder-chats-wrap ${collapsed ? 'collapsed' : ''}`}>
                <div className="sidebar-folder-chats">
                  {folderChats.map((chat) => (
                    <ChatRow key={chat.id} chat={chat} active={currentChatId === chat.id} generating={generatingTitleChatIds.includes(chat.id)} busy={isChatBusy(chat.id)} deleting={deletingChats.has(chat.id)} entering={enteringChats.has(chat.id)} onSelect={() => { setCurrentChat(chat.id); setCurrentView('chat'); requestComposerFocus(); }} onDelete={() => handleDeleteChat(chat.id)} onRename={(title) => handleRenameChat(chat.id, title)} />
                  ))}
                </div>
              </div>
            )}
          </div>
          );
        })}
        </div>
        )}

        {uncatMounted && (
          <div className={`sidebar-section ${uncatLeaving ? 'section-leaving' : 'section-entering'}`}>
            <div className="sidebar-section-title"><FlipText text={folders.length ? projectlessLabel : chatsLabel} /></div>
            {uncategorizedChats.map((chat) => (
              <ChatRow key={chat.id} chat={chat} active={currentChatId === chat.id} generating={generatingTitleChatIds.includes(chat.id)} busy={isChatBusy(chat.id)} deleting={deletingChats.has(chat.id)} entering={enteringChats.has(chat.id)} onSelect={() => { setCurrentChat(chat.id); setCurrentView('chat'); requestComposerFocus(); }} onDelete={() => handleDeleteChat(chat.id)} onRename={(title) => handleRenameChat(chat.id, title)} />
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <NavItem active={currentView === 'tokens'} onClick={() => setCurrentView('tokens')} label={t('tokens.dashboard')} icon={BarChart3} motion="chart" />
        <NavItem active={currentView === 'keyChecker'} onClick={() => setCurrentView('keyChecker')} label={t('keyChecker.title')} icon={KeyRound} motion="key" />
        <NavItem
          active={currentView === 'settings'}
          onClick={() => setCurrentView('settings')}
          label={t('settings.title')}
          icon={Settings}
          motion="gear"
          badge={showUpdateBadge ? (
            <span
              className={`nav-item-badge ${updateStatus.state === 'downloaded' ? 'ready' : ''}`}
              title={updateBadgeTitle}
            >
              {updateBadgeText}
            </span>
          ) : undefined}
        />
      </div>

      {pendingFolderDelete && (
        <ConfirmDialog
          title={t('sidebar.deleteProject.title')}
          message={t('sidebar.deleteProject.message', { name: pendingFolderDelete.name })}
          detail={pendingFolderDelete.chatCount > 0
            ? t(pendingFolderDelete.chatCount === 1 ? 'sidebar.deleteProject.detailOne' : 'sidebar.deleteProject.detailMany', { count: pendingFolderDelete.chatCount })
            : t('sidebar.deleteProject.detailEmpty')}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={confirmDeleteFolder}
          onCancel={() => setPendingFolderDelete(null)}
        />
      )}
    </div>
  );
};

// Skeleton dat nep-tekst nabootst met grijze pillen terwijl de titel laadt.
const TITLE_SKELETON_PILLS = [40, 22, 15];
function TitleSkeleton() {
  const { t } = useTranslation();
  return (
    <span className="title-skeleton" aria-label={t('sidebar.titleGenerating')}>
      {TITLE_SKELETON_PILLS.map((width, i) => (
        <span
          key={i}
          className="title-skeleton-pill"
          style={{ width: `${width}%`, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

function ChatRow({ chat, active, generating, busy, deleting, entering, onSelect, onDelete, onRename }: { chat: Chat; active: boolean; generating?: boolean; busy?: boolean; deleting?: boolean; entering?: boolean; onSelect: () => void; onDelete: () => void; onRename: (title: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);

  const startEdit = () => { setDraft(chat.title); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const clean = draft.trim();
    if (clean && clean !== chat.title) onRename(clean);
    else setDraft(chat.title);
  };

  if (editing) {
    return (
      <div className="chat-item editing">
        <input
          className="chat-item-input"
          aria-label={t('sidebar.renameChat')}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setDraft(chat.title); setEditing(false); }
          }}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div className={`chat-item ${active ? 'active' : ''} ${deleting ? 'deleting' : entering ? 'entering' : ''}`} onClick={onSelect} onDoubleClick={startEdit}>
      {generating ? (
        // Titel wordt gemaakt -> alleen de skeleton, geen knopjes (rustiger, past beter).
        <TitleSkeleton />
      ) : (
        <>
          <span className="chat-item-title">{chat.title}</span>
          {busy ? (
            // Bezig -> alleen de spinner rechts (geen hernoem/verwijder tijdens streamen).
            <Loader2 size={14} className="chat-busy-spinner spin" aria-label={t('sidebar.chatBusy')} />
          ) : (
            <>
              <button
                className="btn-icon chat-item-action"
                onClick={(e) => { e.stopPropagation(); startEdit(); }}
                title={t('sidebar.renameChat')}
                aria-label={t('sidebar.renameChat')}
              >
                <Pencil size={13} />
              </button>
              <button
                className="btn-icon btn-icon-danger chat-item-action"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function NavItem({ active, onClick, label, icon: Icon, badge, motion }: { active: boolean; onClick: () => void; label: string; icon: LucideIcon; badge?: React.ReactNode; motion?: 'chart' | 'key' | 'gear' }) {
  const [motionRunning, setMotionRunning] = useState(false);
  useEffect(() => {
    if (!motionRunning) return undefined;
    // animationend kan bij navigatie of reduced-motion worden overgeslagen.
    // Deze backstop voorkomt dat het tandwiel daarna permanent "bezig" blijft.
    const timeout = window.setTimeout(() => setMotionRunning(false), 900);
    return () => window.clearTimeout(timeout);
  }, [motionRunning]);
  const runMotion = () => {
    // Hover en klik mogen beide starten, maar nooit tegelijk. De klik direct na
    // pointer-enter laat de lopende rotatie daarom rustig afmaken.
    if (!motion || motionRunning) return;
    setMotionRunning(true);
  };
  return (
    <button
      type="button"
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={() => {
        runMotion();
        onClick();
      }}
      onPointerEnter={runMotion}
    >
      <span
        className={`nav-item-icon ${motion && motionRunning ? `motion-${motion}` : ''}`}
        onAnimationEnd={() => setMotionRunning(false)}
      >
        <Icon size={16} />
      </span>
      <FlipText text={label} />
      {badge}
    </button>
  );
}

export default Sidebar;
