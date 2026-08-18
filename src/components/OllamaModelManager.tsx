import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  PackageSearch,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import type {
  OllamaInstalledModel,
  OllamaLibraryModel,
  OllamaLibraryTag,
  OllamaModelManagerStatus,
  OllamaModelPullProgress,
} from '../providers/types';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { formatUpdateBytes } from '../update-status';
import { connectedModels } from './model-utils';
import { replacementAfterOllamaCatalogChange } from './ollama-model-manager-utils';

type OllamaModelManagerProps = {
  configuredUrl: string;
  onProviderChanged: () => Promise<void>;
};

const OllamaModelManager: React.FC<OllamaModelManagerProps> = ({
  configuredUrl,
  onProviderChanged,
}) => {
  const { t, i18n } = useTranslation();
  const numberLocale = i18n.resolvedLanguage?.startsWith('nl') ? 'nl-NL' : 'en-US';
  const configuredUrlRef = useRef(configuredUrl);
  const [status, setStatus] = useState<OllamaModelManagerStatus | null>(null);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installedQuery, setInstalledQuery] = useState('');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryResults, setLibraryResults] = useState<OllamaLibraryModel[]>([]);
  const [searchingLibrary, setSearchingLibrary] = useState(false);
  const [expandedLibraryPath, setExpandedLibraryPath] = useState<string | null>(null);
  const [tagsByLibraryPath, setTagsByLibraryPath] = useState<Record<string, OllamaLibraryTag[]>>({});
  const [loadingTagsPath, setLoadingTagsPath] = useState<string | null>(null);
  const [directModel, setDirectModel] = useState('');
  const [pullProgress, setPullProgress] = useState<OllamaModelPullProgress | null>(null);
  const [activePullModel, setActivePullModel] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [installingRuntime, setInstallingRuntime] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    configuredUrlRef.current = configuredUrl;
  }, [configuredUrl]);

  const refreshInstalled = useCallback(async () => {
    const api = window.electronAPI?.ollama;
    if (!api) return;
    setLoadingInstalled(true);
    setActionError('');
    try {
      setStatus(await api.listInstalled());
    } catch (error) {
      setStatus({
        online: false,
        baseUrl: configuredUrlRef.current,
        models: [],
        error: readableError(error, t),
      });
    } finally {
      setLoadingInstalled(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    const api = window.electronAPI?.ollama;
    if (!api) return undefined;
    return api.onPullProgress((progress) => {
      setPullProgress(progress);
      if (progress.phase === 'success' || progress.phase === 'cancelled' || progress.phase === 'error') {
        setActivePullModel(null);
      } else {
        setActivePullModel(progress.model);
      }
    });
  }, []);

  const visibleInstalledModels = useMemo(() => {
    const query = installedQuery.trim().toLocaleLowerCase();
    if (!query) return status?.models || [];
    return (status?.models || []).filter((model) => [
      model.name,
      model.family,
      model.parameterSize,
      model.quantizationLevel,
      ...model.capabilities,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  }, [installedQuery, status?.models]);

  const notifyProviderChanged = useCallback(async () => {
    try {
      await onProviderChanged();
      await repairRemovedActiveOllamaModel();
    } catch {
      // Het lokale modelbeheer is al geslaagd. Een catalogusrefresh mag die
      // geslaagde actie niet alsnog als fout tonen; de volgende apprefresh herstelt dit.
    }
  }, [onProviderChanged]);

  const installModel = async (requestedModel: string) => {
    const model = requestedModel.trim();
    if (!model || activePullModel) return;
    setActionError('');
    setActivePullModel(model);
    setPullProgress({
      model,
      phase: 'resolving',
      status: t('ollamaManager.preparingModel', { model }),
      percent: 0,
    });
    try {
      const models = await window.electronAPI.ollama.pullModel(model);
      setStatus((current) => ({
        online: true,
        baseUrl: current?.baseUrl || configuredUrlRef.current,
        models,
      }));
      setDirectModel('');
      await notifyProviderChanged();
    } catch (error) {
      const message = readableError(error, t);
      if (!/(geannuleerd|cancelled)/i.test(message)) setActionError(message);
    } finally {
      setActivePullModel(null);
    }
  };

  const cancelPull = async () => {
    if (!activePullModel) return;
    try {
      await window.electronAPI.ollama.cancelPull(activePullModel);
    } catch (error) {
      setActionError(readableError(error, t));
    }
  };

  const removeModel = async (model: OllamaInstalledModel) => {
    if (activePullModel || deletingModel) return;
    const confirmed = window.confirm(t('ollamaManager.removeConfirm', { model: model.name }));
    if (!confirmed) return;
    setDeletingModel(model.name);
    setActionError('');
    try {
      const models = await window.electronAPI.ollama.deleteModel(model.name);
      setStatus((current) => ({
        online: true,
        baseUrl: current?.baseUrl || configuredUrlRef.current,
        models,
      }));
      await notifyProviderChanged();
    } catch (error) {
      setActionError(readableError(error, t));
    } finally {
      setDeletingModel(null);
    }
  };

  const searchLibrary = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const query = libraryQuery.trim();
    if (query.length < 2 || searchingLibrary) {
      if (query.length < 2) setActionError(t('ollamaManager.searchMinimum'));
      return;
    }
    setSearchingLibrary(true);
    setActionError('');
    setExpandedLibraryPath(null);
    try {
      setLibraryResults(await window.electronAPI.ollama.searchLibrary(query));
    } catch (error) {
      setLibraryResults([]);
      setActionError(readableError(error, t));
    } finally {
      setSearchingLibrary(false);
    }
  };

  const toggleLibraryResult = async (result: OllamaLibraryModel) => {
    if (expandedLibraryPath === result.libraryPath) {
      setExpandedLibraryPath(null);
      return;
    }
    setExpandedLibraryPath(result.libraryPath);
    if (tagsByLibraryPath[result.libraryPath]) return;
    setLoadingTagsPath(result.libraryPath);
    setActionError('');
    try {
      const tags = await window.electronAPI.ollama.listLibraryTags(result.libraryPath);
      setTagsByLibraryPath((current) => ({ ...current, [result.libraryPath]: tags }));
    } catch (error) {
      setActionError(readableError(error, t));
    } finally {
      setLoadingTagsPath(null);
    }
  };

  const installRuntime = async () => {
    if (installingRuntime) return;
    setInstallingRuntime(true);
    setActionError('');
    try {
      await window.electronAPI.runtime.install('ollama');
      await refreshInstalled();
      await notifyProviderChanged();
    } catch (error) {
      setActionError(readableError(error, t));
    } finally {
      setInstallingRuntime(false);
    }
  };

  const installedNames = useMemo(
    () => new Set((status?.models || []).map((model) => model.name.toLocaleLowerCase())),
    [status?.models],
  );

  return (
    <section className="ollama-manager" aria-label={t('ollamaManager.aria')}>
      <div className="ollama-manager-heading">
        <div>
          <div className="settings-row-label">{t('ollamaManager.localModels')}</div>
          <p className="text-xs text-muted">
            {t('ollamaManager.manageAt', { url: status?.baseUrl || configuredUrl || 'http://localhost:11434' })}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost ollama-icon-button"
          onClick={() => void refreshInstalled()}
          disabled={loadingInstalled || !!activePullModel}
          aria-label={t('ollamaManager.refreshInstalledAria')}
          title={t('ollamaManager.refresh')}
        >
          <RefreshCw size={15} className={loadingInstalled ? 'spin' : ''} />
        </button>
      </div>

      {!loadingInstalled && status && !status.online ? (
        <div className="ollama-offline-card">
          <div>
            <strong>{t('ollamaManager.offline')}</strong>
            <p className="text-xs text-muted">
              {status.error
                ? t('ollamaManager.offlineDetail', { detail: status.error })
                : t('ollamaManager.offlineHelp')}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void installRuntime()}
            disabled={installingRuntime}
          >
            {installingRuntime ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
            {installingRuntime ? t('ollamaManager.installing') : t('ollamaManager.installOllama')}
          </button>
        </div>
      ) : (
        <>
          <div className="ollama-filter">
            <Search size={15} />
            <input
              value={installedQuery}
              onChange={(event) => setInstalledQuery(event.target.value)}
              placeholder={t('ollamaManager.filterPlaceholder')}
              aria-label={t('ollamaManager.filterAria')}
            />
            <span>{status?.models.length || 0}</span>
          </div>

          <div className="ollama-installed-list">
            {loadingInstalled && (
              <div className="ollama-empty-state">
                <Loader2 size={16} className="spin" />
                {t('ollamaManager.loadingModels')}
              </div>
            )}
            {!loadingInstalled && status?.models.length === 0 && (
              <div className="ollama-empty-state">
                <HardDrive size={17} />
                {t('ollamaManager.noLocalModel')}
              </div>
            )}
            {!loadingInstalled && status && status.models.length > 0 && visibleInstalledModels.length === 0 && (
              <div className="ollama-empty-state">{t('ollamaManager.noFilterMatch')}</div>
            )}
            {visibleInstalledModels.map((model) => (
              <div className="ollama-installed-row" key={model.name}>
                <div className="ollama-model-main">
                  <strong>{model.name}</strong>
                  <div className="ollama-model-meta">
                    {model.parameterSize && <span>{model.parameterSize}</span>}
                    {model.quantizationLevel && <span>{model.quantizationLevel}</span>}
                    {model.size > 0 && <span>{formatUpdateBytes(model.size, numberLocale)}</span>}
                    {model.contextWindow && <span>{t('ollamaManager.context', { value: formatContextWindow(model.contextWindow) })}</span>}
                  </div>
                  {model.capabilities.length > 0 && (
                    <div className="ollama-capabilities">
                      {model.capabilities.map((capability) => (
                        <span key={capability}>{capabilityLabel(capability, t)}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost ollama-delete-button"
                  onClick={() => void removeModel(model)}
                  disabled={!!activePullModel || !!deletingModel}
                  aria-label={t('ollamaManager.removeModelAria', { model: model.name })}
                  title={t('ollamaManager.removeModel')}
                >
                  {deletingModel === model.name
                    ? <Loader2 size={15} className="spin" />
                    : <Trash2 size={15} />}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {pullProgress && (
        <div className={`ollama-pull-card ${pullProgress.phase}`}>
          <div className="ollama-pull-line">
            <div>
              <strong>{pullProgress.model}</strong>
              <p className="text-xs text-muted">{pullProgress.status}</p>
            </div>
            {activePullModel && (
              <button type="button" className="btn btn-ghost" onClick={() => void cancelPull()}>
                <Square size={13} /> {t('ollamaManager.cancel')}
              </button>
            )}
          </div>
          {pullProgress.percent !== undefined && (
            <>
              <div className="ollama-progress-track">
                <div style={{ width: `${pullProgress.percent}%` }} />
              </div>
              <div className="ollama-progress-detail">
                <span>{pullProgress.percent}%</span>
                {Number(pullProgress.total) > 0 && (
                  <span>
                    {formatUpdateBytes(Number(pullProgress.transferred) || 0, numberLocale)}
                    {` ${t('ollamaManager.of')} `}
                    {formatUpdateBytes(Number(pullProgress.total), numberLocale)}
                  </span>
                )}
                {Number(pullProgress.bytesPerSecond) > 0 && (
                  <span>{formatUpdateBytes(Number(pullProgress.bytesPerSecond), numberLocale)}/s</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="ollama-library-section">
        <div className="ollama-manager-heading">
          <div>
            <div className="settings-row-label">{t('ollamaManager.searchNew')}</div>
            <p className="text-xs text-muted">
              {t('ollamaManager.searchHelp')}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost ollama-library-link"
            onClick={() => void window.electronAPI.ollama.openLibrary(libraryQuery)}
          >
            {t('ollamaManager.library')} <ExternalLink size={13} />
          </button>
        </div>
        <form className="ollama-library-search" onSubmit={(event) => void searchLibrary(event)}>
          <div className="ollama-filter">
            <PackageSearch size={15} />
            <input
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              placeholder={t('ollamaManager.searchPlaceholder')}
              aria-label={t('ollamaManager.searchAria')}
            />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={searchingLibrary}>
            {searchingLibrary ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
            {t('ollamaManager.search')}
          </button>
        </form>

        {libraryResults.length > 0 && (
          <div className="ollama-library-results">
            {libraryResults.map((result) => {
              const expanded = expandedLibraryPath === result.libraryPath;
              const tags = tagsByLibraryPath[result.libraryPath] || [];
              return (
                <div className="ollama-library-result" key={result.libraryPath}>
                  <button
                    type="button"
                    className="ollama-library-result-toggle"
                    onClick={() => void toggleLibraryResult(result)}
                    aria-expanded={expanded}
                  >
                    <div>
                      <strong>{result.name}</strong>
                      {result.description && <p>{result.description}</p>}
                      <div className="ollama-model-meta">
                        {result.pulls && <span>{t('ollamaManager.downloadCount', { count: result.pulls })}</span>}
                        {result.tagCount && <span>{t('ollamaManager.variantCount', { count: result.tagCount })}</span>}
                        {result.capabilities.map((capability) => (
                          <span key={capability}>{capabilityLabel(capability, t)}</span>
                        ))}
                      </div>
                    </div>
                    {loadingTagsPath === result.libraryPath
                      ? <Loader2 size={15} className="spin" />
                      : <ChevronDown size={15} className={expanded ? 'expanded' : ''} />}
                  </button>
                  {expanded && (
                    <div className="ollama-tag-list">
                      {loadingTagsPath === result.libraryPath && (
                        <div className="ollama-empty-state">{t('ollamaManager.loadingVariants')}</div>
                      )}
                      {loadingTagsPath !== result.libraryPath && tags.length === 0 && (
                        <div className="ollama-tag-row">
                          <div>
                            <strong>{result.name}</strong>
                            <span>{t('ollamaManager.defaultVariant')}</span>
                          </div>
                          <InstallModelButton
                            model={result.name}
                            installed={installedNames.has(result.name.toLocaleLowerCase())}
                            activePullModel={activePullModel}
                            onInstall={installModel}
                          />
                        </div>
                      )}
                      {tags.map((tag) => (
                        <div className="ollama-tag-row" key={tag.name}>
                          <div>
                            <strong>{tag.name}</strong>
                            <span>
                              {[tag.sizeLabel, tag.contextLabel, tag.inputLabel].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          <InstallModelButton
                            model={tag.name}
                            installed={installedNames.has(tag.name.toLocaleLowerCase())}
                            activePullModel={activePullModel}
                            onInstall={installModel}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="ollama-direct-install">
          <div>
            {/* De eerdere contracttekst "Exacte modelnaam" komt nu uit de actieve vertaalcatalogus. */}
            <strong>{t('ollamaManager.exactModelName')}</strong>
            <p className="text-xs text-muted">
              {t('ollamaManager.directInstallHelp')}
            </p>
          </div>
          <div className="ollama-direct-install-controls">
            <input
              className="input"
              value={directModel}
              onChange={(event) => setDirectModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void installModel(directModel);
                }
              }}
              placeholder="qwen3:8b"
              aria-label={t('ollamaManager.exactModelAria')}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void installModel(directModel)}
              disabled={!directModel.trim() || !!activePullModel || status?.online === false}
            >
              <Download size={15} /> {t('ollamaManager.download')}
            </button>
          </div>
        </div>
      </div>

      {actionError && <div className="ollama-manager-error" role="alert">{actionError}</div>}
    </section>
  );
};

const InstallModelButton: React.FC<{
  model: string;
  installed: boolean;
  activePullModel: string | null;
  onInstall: (model: string) => Promise<void>;
}> = ({ model, installed, activePullModel, onInstall }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={installed ? 'btn btn-ghost' : 'btn btn-secondary'}
      onClick={() => void onInstall(model)}
      disabled={installed || !!activePullModel}
    >
      {activePullModel === model
        ? <Loader2 size={14} className="spin" />
        : installed
          ? <HardDrive size={14} />
          : <Download size={14} />}
      {installed ? t('ollamaManager.installed') : t('ollamaManager.download')}
    </button>
  );
};

function formatContextWindow(value: number) {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(value);
}

function trimDecimal(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function capabilityLabel(value: string, t: TFunction) {
  return ({
    audio: t('ollamaManager.capabilities.audio'),
    cloud: t('ollamaManager.capabilities.cloud'),
    completion: t('ollamaManager.capabilities.completion'),
    embedding: t('ollamaManager.capabilities.embedding'),
    insert: t('ollamaManager.capabilities.insert'),
    thinking: t('ollamaManager.capabilities.thinking'),
    tools: t('ollamaManager.capabilities.tools'),
    vision: t('ollamaManager.capabilities.vision'),
  } as Record<string, string>)[value.toLocaleLowerCase()] || value;
}

function readableError(error: unknown, t: TFunction) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  return message
    ? t('ollamaManager.actionFailedDetail', { detail: message })
    : t('ollamaManager.actionFailed');
}

async function repairRemovedActiveOllamaModel() {
  const chatState = useChatStore.getState();
  if (chatState.activeProvider !== 'ollama') return;

  const providerState = useProviderStore.getState();
  const available = connectedModels(
    providerState.models,
    providerState.authStatus,
    providerState.chatgptSessionActive,
  );
  const replacement = replacementAfterOllamaCatalogChange({
    modelId: chatState.activeModelId,
    provider: chatState.activeProvider,
  }, available);
  if (!replacement) return;
  const { modelId, provider, runConfig } = replacement;
  chatState.setActiveModel(modelId, provider, runConfig);

  if (!chatState.currentChatId) return;
  const patch = {
    activeModelId: modelId,
    activeProvider: provider,
    activeRunConfig: runConfig || null,
  };
  chatState.updateChat(chatState.currentChatId, patch);
  if (chatState.chats.some((chat) => chat.id === chatState.currentChatId)) {
    await window.electronAPI.db.updateChat(chatState.currentChatId, patch);
  }
}

export default OllamaModelManager;
