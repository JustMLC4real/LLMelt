import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../stores/chat-store';

const Titlebar: React.FC = () => {
  const { t } = useTranslation();
  const currentView = useChatStore((state) => state.currentView);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const controls = window.electronAPI?.windowControls;
    if (!controls) return;
    controls.isMaximized().then(setMaximized).catch(() => {});
    return controls.onMaximizeChange(setMaximized);
  }, []);

  const sectionLabel =
    currentView === 'settings' ? t('settings.title')
    : currentView === 'tokens' ? t('tokens.dashboard')
    : currentView === 'keyChecker' ? t('keyChecker.title')
    : t('app.title');

  const minimize = () => window.electronAPI?.windowControls.minimize();
  const close = () => window.electronAPI?.windowControls.close();
  const maximizeToggle = async () => {
    const next = await window.electronAPI?.windowControls.maximizeToggle();
    if (typeof next === 'boolean') setMaximized(next);
  };

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-logo" aria-hidden>
          <img src="./icon.png" alt="" />
        </span>
        <span className="titlebar-title">{t('app.title')}</span>
        <span className="titlebar-divider" />
        <span className="titlebar-section">{sectionLabel}</span>
      </div>

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={minimize} aria-label="Minimize" title="Minimize">
          <svg width="11" height="11" viewBox="0 0 11 11"><line x1="1.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1.1" /></svg>
        </button>
        <button className="titlebar-btn" onClick={maximizeToggle} aria-label="Maximize" title={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1">
              <rect x="2" y="3.4" width="5.6" height="5.6" rx="0.6" />
              <path d="M4 3.4V2.2A0.6 0.6 0 0 1 4.6 1.6h4.2a0.6 0.6 0 0 1 0.6 0.6v4.2a0.6 0.6 0 0 1-0.6 0.6H8" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1"><rect x="1.8" y="1.8" width="7.4" height="7.4" rx="0.8" /></svg>
          )}
        </button>
        <button className="titlebar-btn titlebar-btn-close" onClick={close} aria-label="Close" title="Close">
          <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.1"><line x1="2" y1="2" x2="9" y2="9" /><line x1="9" y1="2" x2="2" y2="9" /></svg>
        </button>
      </div>
    </div>
  );
};

export default Titlebar;
