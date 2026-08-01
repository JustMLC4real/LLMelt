import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { isDraftChatId } from './new-chat';

const SystemPromptEditor: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const { t } = useTranslation();
  const { systemPrompt, setSystemPrompt, setShowSystemPromptEditor, currentChatId, updateChat } = useChatStore();
  const [localPrompt, setLocalPrompt] = useState(systemPrompt);

  useEffect(() => {
    if (active) setLocalPrompt(systemPrompt);
  }, [active, systemPrompt]);

  const handleSave = async () => {
    setSystemPrompt(localPrompt);
    if (currentChatId) {
      updateChat(currentChatId, { systemPrompt: localPrompt || null });
      if (!isDraftChatId(currentChatId)) {
        const saved = await window.electronAPI?.db.updateChat(currentChatId, { systemPrompt: localPrompt || null });
        if (saved) updateChat(currentChatId, { systemPrompt: saved.systemPrompt || null });
      }
    }
    setShowSystemPromptEditor(false);
  };

  return (
    <div className="system-prompt-editor">
      <div className="panel-header-row mb-2">
        <span className="font-semibold text-sm">{t('chat.systemPrompt')}</span>
        <button className="btn-icon" onClick={() => setShowSystemPromptEditor(false)} title="Inklappen" aria-label="Systeemprompt inklappen">
          <X size={14} />
        </button>
      </div>
      <textarea
        className="textarea"
        value={localPrompt}
        onChange={(e) => setLocalPrompt(e.target.value)}
        placeholder={t('chat.noSystemPrompt')}
        rows={4}
      />
      <div className="flex gap-2 mt-2" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary" onClick={() => setShowSystemPromptEditor(false)}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" onClick={handleSave}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
};

export default SystemPromptEditor;
