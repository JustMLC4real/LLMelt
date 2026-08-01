import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, FileText, RefreshCw } from 'lucide-react';
import type { AttachmentRef, Message } from '../providers/types';
import { useProviderStore } from '../stores/provider-store';
import type { ProviderType } from '../providers/types';
import { useProfileStore } from '../stores/profile-store';
import CommandRunActivity from './CommandRunActivity';
import { ProviderAvatarIcon } from './ProviderAvatarIcon';
import { isToolIntentMessage, isToolOutputMessage, parseCommandRun } from './command-run-utils';
import { requestComposerFocus } from './composer-focus';
import { copyTextToClipboard } from './clipboard-utils';
import { hasUnparsedToolMarkup, stripAgentToolMarkup } from './agent-commands';
import { formatModelBadge } from './message-model-badge';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  // Een nog actieve beurt mag nog geen kopieeracties tonen. Dit geldt ook voor
  // reeds afgeronde segmenten binnen een native tool-loop.
  actionsDisabled?: boolean;
  // Verberg de kopieer-knop-regel — gebruikt als er direct een tool-kaart onder dit
  // bericht hangt, zodat die kaart strak aansluit (net als GPT's tool-intent bericht).
  hideActions?: boolean;
  // Vervolgsegment van dezelfde beurt: verberg avatar + kop, sluit strak aan.
  continuation?: boolean;
  // Live-status in de kop (shimmer) i.p.v. de tijd, terwijl deze beurt streamt —
  // zoals GPT's "model - Antwoord streamt · 5s". Leeg/undefined = gewoon de tijd.
  liveStatus?: string;
}

// Kopieer-knop met icoon dat kort een vinkje wordt na het kopiëren. Gedeeld door
// het bericht zelf en elk codeblok, zodat de feedback overal hetzelfde is.
function CopyButton({ text, title, size = 15 }: { text: string; title: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!await copyTextToClipboard(text)) return;
    setCopied(true);
    requestComposerFocus();
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`btn-icon message-copy-btn ${copied ? 'copied' : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={copy}
      title={copied ? 'Gekopieerd' : title}
      aria-label={copied ? 'Gekopieerd' : title}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
  actionsDisabled = false,
  hideActions,
  continuation,
  liveStatus,
}) => {
  const { t } = useTranslation();
  const userAvatarDataUrl = useProfileStore((state) => state.userAvatarDataUrl);

  const provider = (message.provider || 'openai') as ProviderType;
  const commandRun = parseCommandRun(message.toolRun);
  const messageRunConfig = parseRunConfig(message.runConfig);
  const isAutoModePrompt = message.role === 'user' && messageRunConfig?.autoModePrompt === true;
  // Tool output inserted by the agent loop belongs visually to the LLM turn.
  const isToolOutput = message.role === 'user' && isToolOutputMessage(message);
  const isUser = message.role === 'user' && !isToolOutput && !isAutoModePrompt;
  // Vervolgsegment van dezelfde beurt: geen avatar/kop, strak onder het vorige — zodat
  // tekst + tools als één samenhangende beurt lezen (voor álle providers).
  const isContinuation = !!continuation && !isUser && !isToolOutput;
  const isChatGptRecovery = message.provider === 'openai'
    && /ChatGPT (web-sessie|composer|verificatie|model|web-engine)|ChatGPT startte geen antwoord/i.test(message.content);
  const isToolIntent = isToolIntentMessage(message);
  const hasBrokenToolMarkup = !isUser && hasUnparsedToolMarkup(message.content);
  const displayContent = hasBrokenToolMarkup ? stripAgentToolMarkup(message.content) : message.content;
  const chatgptVersions = useProviderStore((state) => state.chatgptVersions);
  const modelBadge = formatModelBadge(message, chatgptVersions);
  const messageAttachments = parseMessageAttachments(message.attachments);

  const handleChatGptRecover = async () => {
    await window.electronAPI?.auth.chatgptEngineReset();
    await window.electronAPI?.auth.chatgptOpenWindow();
  };

  // Ook reeds opgeslagen kapotte tool-only antwoorden uit oudere beurten niet
  // opnieuw als chattekst tonen. Nieuwe beurten worden vóór uitvoering gerepareerd.
  if (hasBrokenToolMarkup && !displayContent) return null;

  return (
    <div className={`message ${isToolOutput ? 'tool-output-message' : isUser ? 'is-user' : 'is-assistant'}${isContinuation ? ' is-continuation' : ''}${isAutoModePrompt ? ' is-auto-mode-prompt' : ''}`}>
      {(isToolOutput || isContinuation) ? (
        <div className="message-avatar-spacer" />
      ) : (
        <div className={`message-avatar ${isUser ? `user ${userAvatarDataUrl ? 'has-image' : ''}` : `assistant ${provider}`}`}>
          {isUser
            ? userAvatarDataUrl
              ? <img className="message-avatar-user-image" src={userAvatarDataUrl} alt="Jij" draggable={false} />
              : 'YOU'
            : <ProviderAvatarIcon provider={provider} />}
        </div>
      )}

      <div className="message-body">
        {!isToolOutput && !isContinuation && (
          <div className="message-header">
            {!isUser && modelBadge && <span className="message-model-badge">{modelBadge}</span>}
            {isAutoModePrompt && <span className="status-badge limited">Auto Mode prompt</span>}
            {message.fallbackFrom && (
              <span className="status-badge limited" style={{ fontSize: '0.65rem' }}>
                {t('chat.switchedTo', { model: message.modelId })}
              </span>
            )}
            {liveStatus
              ? <span className="streaming-status shimmer" data-text={liveStatus} style={{ fontSize: 'var(--font-size-xs)' }}>{liveStatus}</span>
              : <span className="message-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            {isStreaming && <span className="message-spinner" aria-label="Streaming" />}
          </div>
        )}

        <div className={`message-content ${commandRun ? 'message-content-bare' : ''}`}>
          {isUser && messageAttachments.length > 0 && (
            <div className="message-attachments">
              {messageAttachments.map((attachment) => (
                <div key={attachment.id || attachment.name} className="message-attachment-chip" title={attachment.path || attachment.name}>
                  <FileText size={14} />
                  <span>{attachment.name}</span>
                  <small>{formatAttachmentSize(attachment.size)}</small>
                </div>
              ))}
            </div>
          )}
          {commandRun ? (
            <CommandRunActivity group={{ key: commandRun.id, runs: [{ key: commandRun.id, run: commandRun, live: false }] }} />
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a({ href, children, ...props }) {
                  return (
                    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  );
                },
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match;

                  if (isInline) {
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  }

                  return (
                    <div style={{ position: 'relative' }}>
                      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: '4px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{match[1]}</span>
                        {!actionsDisabled && <CopyButton text={String(children)} title={t('chat.copy')} size={13} />}
                      </div>
                      <code className={className} {...props}>
                        {children}
                      </code>
                    </div>
                  );
                },
              }}
            >
              {displayContent}
            </ReactMarkdown>
          )}
          {isChatGptRecovery && (
            <div className="mt-3">
              <button className="btn btn-secondary" onClick={handleChatGptRecover} style={{ fontSize: 'var(--font-size-xs)' }}>
                <RefreshCw size={15} />
                ChatGPT herstellen
              </button>
            </div>
          )}
        </div>

        {!isStreaming && !actionsDisabled && !isToolOutput && !isToolIntent && !hideActions && (
          <div className="message-actions">
            <CopyButton text={displayContent} title={t('chat.copy')} />
          </div>
        )}
      </div>
    </div>
  );
};

function parseRunConfig(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { reasoningEffort?: string; chatgptThinkingEffort?: string; autoModePrompt?: boolean };
  } catch {
    return null;
  }
}

function parseMessageAttachments(raw?: string | null): AttachmentRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => {
        if (typeof item === 'string') {
          return {
            id: item,
            name: `Bijlage ${index + 1}`,
            mimeType: 'application/octet-stream',
            kind: 'binary',
            size: 0,
            tokenEstimate: 0,
            createdAt: '',
          } as AttachmentRef;
        }
        if (item && typeof item === 'object') return item as AttachmentRef;
        return null;
      })
      .filter((item): item is AttachmentRef => !!item);
  } catch {
    return [];
  }
}

function formatAttachmentSize(size?: number) {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default MessageBubble;
