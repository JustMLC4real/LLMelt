import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Square, Terminal as TerminalIcon, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useChatStore } from '../stores/chat-store';
import type { AgentShell } from '../providers/types';
import { chatFromVisibleOrDraft } from './draft-chat';

type ShellOption = { id: AgentShell; label: string; available: boolean };
type SessionTab = { id: string; shell: AgentShell; label: string; cwd: string; exited?: boolean };

const SHELL_LABELS: Record<AgentShell, string> = {
  powershell: 'PowerShell',
  cmd: 'Cmd',
  pwsh: 'PowerShell 7',
};

const TerminalPanel: React.FC = () => {
  const { showTerminal, setShowTerminal, chats, draftChats, currentChatId, folders } = useChatStore();
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState('');
  const currentChat = chatFromVisibleOrDraft(chats, draftChats, currentChatId);
  const currentFolder = folders.find((folder) => folder.id === currentChat?.folderId);
  const effectiveProjectPath =
    currentFolder?.projectPath || currentChat?.projectPath || defaultWorkspacePath || '';
  const [shells, setShells] = useState<ShellOption[]>([
    { id: 'powershell', label: 'PowerShell', available: true },
    { id: 'cmd', label: 'Cmd', available: true },
    { id: 'pwsh', label: 'PowerShell 7', available: false },
  ]);
  const [selectedShell, setSelectedShell] = useState<AgentShell>('powershell');
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const creatingSessionRef = useRef(false);
  const buffersRef = useRef<Map<string, string>>(new Map());

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeId) || null, [sessions, activeId]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    window.electronAPI?.files?.getDefaultWorkspace?.()
      .then((workspace: string) => setDefaultWorkspacePath(workspace || ''))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.terminal?.listShells) return;
    window.electronAPI.terminal.listShells().then((available: ShellOption[]) => {
      if (Array.isArray(available) && available.length) {
        setShells(available);
        const first = available.find((shell) => shell.available)?.id || 'powershell';
        setSelectedShell(first);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (termRef.current || !containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace',
      fontSize: 12,
      convertEol: true,
      theme: {
        background: '#070b13',
        foreground: '#d7e1f4',
        cursor: '#7dd3fc',
        selectionBackground: '#24435d',
        black: '#0b1220',
        red: '#fb7185',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#a78bfa',
        cyan: '#22d3ee',
        white: '#e5eefc',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dataDisposable = term.onData((data) => {
      const id = activeIdRef.current;
      if (id) window.electronAPI?.terminal.write(id, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const id = activeIdRef.current;
      if (id) window.electronAPI?.terminal.resize(id, cols, rows);
    });
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.terminal) return;
    const offData = window.electronAPI.terminal.onData(({ id, data }: { id: string; data: string }) => {
      buffersRef.current.set(id, (buffersRef.current.get(id) || '') + data);
      if (id === activeIdRef.current) termRef.current?.write(data);
    });
    const offExit = window.electronAPI.terminal.onExit(({ id, exitCode }: { id: string; exitCode: number }) => {
      const line = `\r\n[process exited ${exitCode}]\r\n`;
      buffersRef.current.set(id, (buffersRef.current.get(id) || '') + line);
      setSessions((prev) => prev.map((session) => session.id === id ? { ...session, exited: true } : session));
      if (id === activeIdRef.current) termRef.current?.write(line);
    });
    return () => {
      offData?.();
      offExit?.();
    };
  }, []);

  const createSession = useCallback(async (shell: AgentShell = selectedShell) => {
    const terminalApi = window.electronAPI?.terminal;
    if (!terminalApi || !termRef.current || !fitRef.current || creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    try {
      fitRef.current.fit();
      const created = await terminalApi.create({
        shell,
        cwd: effectiveProjectPath || undefined,
        cols: termRef.current.cols,
        rows: termRef.current.rows,
      });
      // Bij het afsluiten van de app kan de IPC-aanvraag terugkomen nadat xterm al weg is.
      // Ruim die sessie meteen op in plaats van een onzichtbaar proces achter te laten.
      if (!termRef.current) {
        await terminalApi.kill(created.id).catch(() => {});
        return;
      }
      buffersRef.current.set(created.id, '');
      setSessions((prev) => {
        const label = `${SHELL_LABELS[shell]} ${prev.filter((session) => session.shell === shell).length + 1}`;
        return [...prev, { id: created.id, shell, label, cwd: created.cwd }];
      });
      setActiveId(created.id);
      termRef.current.reset();
      termRef.current.focus();
    } finally {
      creatingSessionRef.current = false;
    }
  }, [selectedShell, effectiveProjectPath]);

  useEffect(() => {
    if (showTerminal && sessions.length === 0 && termRef.current) {
      void createSession(selectedShell);
    }
  }, [showTerminal, sessions.length, selectedShell, createSession]);

  const switchSession = (id: string) => {
    setActiveId(id);
    termRef.current?.reset();
    const buffered = buffersRef.current.get(id) || '';
    if (buffered) termRef.current?.write(buffered);
    termRef.current?.focus();
  };

  const killSession = async (id: string) => {
    await window.electronAPI?.terminal.kill(id);
    buffersRef.current.delete(id);
    setSessions((prev) => {
      const nextSessions = prev.filter((session) => session.id !== id);
      if (id === activeIdRef.current) {
        const currentIndex = prev.findIndex((session) => session.id === id);
        const next = nextSessions[Math.max(0, currentIndex - 1)] || nextSessions[0] || null;
        activeIdRef.current = next?.id || null;
        setActiveId(next?.id || null);
        termRef.current?.reset();
        if (next) {
          const buffered = buffersRef.current.get(next.id) || '';
          if (buffered) termRef.current?.write(buffered);
        }
      }
      return nextSessions;
    });
  };

  return (
    <aside className="terminal-panel">
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">
          <TerminalIcon size={14} /> Terminal
        </span>
        <div className="terminal-panel-actions">
          <select
            className="terminal-shell-select"
            value={selectedShell}
            onChange={(event) => setSelectedShell(event.target.value as AgentShell)}
            title="Shell kiezen"
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id} disabled={!shell.available}>
                {shell.label}{shell.available ? '' : ' (niet gevonden)'}
              </option>
            ))}
          </select>
          <button type="button" className="btn-icon" title="Nieuwe terminal" aria-label="Nieuwe terminal" onClick={() => createSession(selectedShell)}>
            <Plus size={14} />
          </button>
          {activeSession && (
            <button type="button" className="btn-icon" title="Stop sessie" aria-label="Stop sessie" onClick={() => killSession(activeSession.id)}>
              <Square size={13} />
            </button>
          )}
          <button type="button" className="btn-icon" title="Sluiten" aria-label="Sluiten" onClick={() => setShowTerminal(false)}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-tabs">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`terminal-tab ${session.id === activeId ? 'active' : ''} ${session.exited ? 'exited' : ''}`}
            onClick={() => switchSession(session.id)}
            title={`${SHELL_LABELS[session.shell]} - ${session.cwd}`}
          >
            <span className="terminal-tab-label">{session.label}</span>
            <span
              role="button"
              tabIndex={-1}
              className="terminal-tab-close"
              title="Terminal sluiten"
              aria-label={`${session.label} sluiten`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void killSession(session.id);
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
      </div>
      <div className="terminal-xterm" ref={containerRef} />
    </aside>
  );
};

export default TerminalPanel;
