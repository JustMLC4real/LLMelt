import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Globe2, HardDrive, Loader2, RefreshCw, Rocket, Search, Sparkles } from 'lucide-react';
import { useChatStore } from '../stores/chat-store';
import { useProviderStore } from '../stores/provider-store';
import { type AIModel, type ProviderType, type ReasoningEffort, type ServiceTier } from '../providers/types';
import {
  antigravityModelFor,
  antigravityModelNamesFor,
  antigravityModels,
  antigravityModesFor,
  antigravityProviders,
  chatgptLevelKey,
  chatgptModels,
  chatgptPresetFor,
  chatgptWebSessionUsable,
  claudeCliFamilies,
  claudeCliModelFor,
  claudeCliModels,
  claudeCliVersionsFor,
  codexEffortForModel,
  codexEffortsForModel,
  codexModels,
  codexRunConfig,
  connectedModels,
  configuredModelRef,
  modelDisplayName,
  parseAntigravityModel,
  parseClaudeCliModel,
  parseCodexModel,
  parseGoogleModelChoice,
  reasoningEffortLabel,
  serviceTierLabel,
  serviceTiersForModel,
  surfaceLabel,
} from './model-utils';
import { isDraftChatId } from './new-chat';
import { ProviderBadge, QuotaBadge, SelectField } from './ui';

interface ModelSelectorProps {
  onClose: () => void;
}

const MODEL_SELECTOR_EXIT_MS = 180;

type ModelGroup = {
  key: string;
  title: string;
  models: AIModel[];
};

// Een niveau in de Intelligentie-lijst. `available: false` = grijs (zoals Pro bij
// een account zonder Pro), precies zoals ChatGPT het toont.
interface PickerLevel {
  key: string;
  modelId: string;
  effort?: string;
  label: string;
  available: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [closing, setClosing] = useState(false);
  const [chatgptCatalogRefreshing, setChatgptCatalogRefreshing] = useState(false);
  const chatgptCatalogRefreshInFlightRef = useRef(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const {
    activeModelId,
    activeProvider,
    activeRunConfig,
    currentChatId,
    lastChatgptRef,
    lastCodexRef,
    setActiveModel,
    updateChat,
  } = useChatStore();
  const { models: storeModels, authStatus, accountStatuses, chatgptVersions, chatgptSessionActive } = useProviderStore();
  const availableModels = useMemo(
    () => connectedModels(storeModels, authStatus, chatgptSessionActive),
    [storeModels, authStatus, chatgptSessionActive],
  );
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, MODEL_SELECTOR_EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  // Apply a selection: update the live store AND save it to the current chat right
  // away, so it sticks across chat switches even before you send anything.
  const applySelection = (modelId: string, provider: ProviderType, runConfig?: any) => {
    setActiveModel(modelId, provider, runConfig);
    if (currentChatId) {
      updateChat(currentChatId, {
        activeModelId: modelId,
        activeProvider: provider,
        activeRunConfig: runConfig ?? null,
      });
    }
    if (currentChatId && window.electronAPI && !isDraftChatId(currentChatId)) {
      window.electronAPI.db
        .updateChat(currentChatId, { activeModelId: modelId, activeProvider: provider, activeRunConfig: runConfig ?? null })
        .catch(() => {});
    }
  };

  // ── Codex composite ──
  // Each card remembers ITS OWN last pick (lastCodexRef), independent of which
  // provider is currently active — so choosing Codex doesn't reset the ChatGPT card.
  const codex = codexModels(availableModels);
  const codexActiveCfg = activeProvider === 'codex' ? activeRunConfig : lastCodexRef?.runConfig;
  const initialCodex = codex.find((model) => model.id === (lastCodexRef?.modelId || activeModelId))
    || codex.find((model) => model.isRecommended) || codex[0];
  const [codexModelId, setCodexModelId] = useState(initialCodex?.id || '');
  const [codexEffort, setCodexEffort] = useState<ReasoningEffort>(
    codexEffortForModel(initialCodex, codexActiveCfg?.reasoningEffort),
  );
  const [codexTier, setCodexTier] = useState<ServiceTier | ''>(codexActiveCfg?.serviceTier || '');

  // ── ChatGPT composite (Model → Intelligentie) ──
  // Eén "Intelligentie"-keuze i.p.v. Stand + Inspanning, net als ChatGPT's eigen UI.
  // De niveaus worden afgeleid uit de live modellenlijst + de per-model thinking_efforts,
  // dus je kunt nooit een combinatie kiezen die de backend niet kent.
  const chatgpt = chatgptModels(availableModels);
  const chatgptAccount = accountStatuses.chatgpt;
  // De modellenlijst blijft als laatst-bekend-goed bewaard en is dus GEEN bewijs dat
  // de websessie nog leeft: na uitloggen stond hier ten onrechte "web-sessie actief"
  // en bleef "Gebruik ChatGPT" klikbaar. Alleen de sessiecheck is gezaghebbend.
  // (accountStatuses.chatgpt gaat over de desktop-app, niet over de websessie.)
  const chatgptSessionKnown = typeof chatgptSessionActive === 'boolean';
  const chatgptUsable = chatgptWebSessionUsable(chatgptSessionActive, chatgpt.length);
  const chatgptCatalogReady = chatgpt.length > 0 && chatgptVersions.some((version) => version.enabled);
  const chatgptSelectable = chatgptUsable && chatgptCatalogReady;
  const chatgptStatusClass = chatgptSelectable ? 'online' : chatgptSessionActive ? 'limited' : chatgptAccount?.installed ? 'limited' : 'offline';
  const chatgptStatusLabel = chatgptSessionActive && !chatgptCatalogReady
    ? 'modelcatalogus niet geladen'
    : chatgptSelectable
      ? 'web-sessie actief'
    : chatgptSessionKnown
      ? 'web-sessie niet ingelogd'
      : chatgptAccount?.installed
        ? 'web-sessie niet bevestigd'
        : 'web-sessie niet ingelogd';
  const chatgptActiveCfg = (activeProvider === 'openai' && activeModelId.startsWith('chatgpt:')) ? activeRunConfig : lastChatgptRef?.runConfig;
  // Zoek het actieve model terug in ChatGPT's eigen lijst, zodat de dropdowns openen
  // op wat je laatst koos ("GPT-5.6 Sol" + "Hoog").
  const initialFromVersions = (() => {
    const enabled = chatgptVersions.filter((version) => version.enabled);
    if (!enabled.length) return null;
    const modelId = lastChatgptRef?.modelId || activeModelId;
    const hit = chatgptPresetFor(enabled, modelId, chatgptActiveCfg?.chatgptThinkingEffort);
    if (hit) {
      return { base: hit.version.title, level: chatgptLevelKey(`chatgpt:${hit.preset.modelSlug}`, hit.preset.thinkingEffort) };
    }
    const first = enabled[0];
    const preset = first.presets[0];
    return { base: first.title, level: preset ? chatgptLevelKey(`chatgpt:${preset.modelSlug}`, preset.thinkingEffort) : '' };
  })();

  const [chatgptBase, setChatgptBase] = useState(initialFromVersions?.base ?? '');
  const [chatgptLevel, setChatgptLevel] = useState(initialFromVersions?.level ?? '');

  // ── Antigravity composite (account-wide, één model kiezen) ──
  const antigravity = useMemo(() => antigravityModels(availableModels), [availableModels]);
  const initialAntigravity = antigravity.find((model) => model.id === activeModelId && activeProvider === 'antigravity') || antigravity[0];
  const initialAntigravityParsed = parseAntigravityModel(initialAntigravity);
  const [antigravityProvider, setAntigravityProvider] = useState(initialAntigravityParsed.provider);
  const [antigravityModelName, setAntigravityModelName] = useState(initialAntigravityParsed.model);
  const [antigravityMode, setAntigravityMode] = useState(initialAntigravityParsed.mode);

  // ── Claude CLI composite (account-wide, één model kiezen) ──
  const claudeCli = useMemo(() => claudeCliModels(availableModels), [availableModels]);
  const initialClaudeCli = claudeCli.find((model) => model.id === activeModelId && activeProvider === 'anthropic') || claudeCli[0];
  const initialClaudeParsed = parseClaudeCliModel(initialClaudeCli);
  const [claudeCliFamily, setClaudeCliFamily] = useState(initialClaudeParsed.family);
  const [claudeCliVersion, setClaudeCliVersion] = useState(initialClaudeParsed.version);
  const claudeCliActiveCfg = (activeProvider === 'anthropic' && activeModelId.startsWith('claude-cli:')) ? activeRunConfig : undefined;
  const [claudeCliEffort, setClaudeCliEffort] = useState<ReasoningEffort>(
    (claudeCliActiveCfg?.reasoningEffort as ReasoningEffort) || (initialClaudeCli?.defaultReasoningEffort as ReasoningEffort) || 'high',
  );

  // Gemini en Ollama gebruiken net als Codex/Claude één providerkaart met een
  // live dropdown. De catalogus blijft volledig provider-gestuurd.
  const gemini = useMemo(() => availableModels
    .filter((model) => model.provider === 'google')
    .sort((a, b) => (a.catalogPriority ?? Number.MAX_SAFE_INTEGER) - (b.catalogPriority ?? Number.MAX_SAFE_INTEGER)
      || modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { numeric: true })), [availableModels]);
  const initialGemini = gemini.find((model) => model.provider === activeProvider && model.id === activeModelId) || gemini[0];
  const [geminiModelId, setGeminiModelId] = useState(initialGemini?.id || '');
  const activeGemini = gemini.find((model) => model.id === geminiModelId) || gemini[0];
  const activeGeminiChoice = parseGoogleModelChoice(activeGemini);
  const geminiFamilies = Array.from(new Set(gemini.map((model) => parseGoogleModelChoice(model).family)));
  const geminiVersions = Array.from(new Set(gemini
    .filter((model) => parseGoogleModelChoice(model).family === activeGeminiChoice.family)
    .map((model) => parseGoogleModelChoice(model).version)));
  const geminiVariants = gemini.filter((model) => {
    const choice = parseGoogleModelChoice(model);
    return choice.family === activeGeminiChoice.family && choice.version === activeGeminiChoice.version;
  });
  const onGeminiFamilyChange = (family: string) => {
    const next = gemini.find((model) => parseGoogleModelChoice(model).family === family);
    if (next) setGeminiModelId(next.id);
  };
  const onGeminiVersionChange = (version: string) => {
    const next = gemini.find((model) => {
      const choice = parseGoogleModelChoice(model);
      return choice.family === activeGeminiChoice.family && choice.version === version;
    });
    if (next) setGeminiModelId(next.id);
  };

  const ollama = useMemo(() => availableModels.filter((model) => model.provider === 'ollama'), [availableModels]);
  const initialOllama = ollama.find((model) => model.provider === activeProvider && model.id === activeModelId) || ollama[0];
  const [ollamaModelId, setOllamaModelId] = useState(initialOllama?.id || '');
  const activeOllama = ollama.find((model) => model.id === ollamaModelId) || ollama[0];
  const activeOllamaChoice = parseOllamaModel(activeOllama);
  const ollamaFamilies = Array.from(new Set(ollama.map((model) => parseOllamaModel(model).family)));
  const ollamaVariants = ollama
    .filter((model) => parseOllamaModel(model).family === activeOllamaChoice.family)
    .map((model) => ({ value: model.id, label: parseOllamaModel(model).variant }));
  const onOllamaFamilyChange = (family: string) => {
    const next = ollama.find((model) => parseOllamaModel(model).family === family);
    if (next) setOllamaModelId(next.id);
  };

  const groups = useMemo(() => {
    const models = availableModels.filter(
      (model) => model.provider !== 'codex'
        && model.provider !== 'google'
        && model.provider !== 'ollama'
        && !(model.provider === 'openai' && model.id.startsWith('chatgpt:')),
    );
    const q = search.trim().toLowerCase();
    const matches = (model: AIModel) => {
      if (!q) return true;
      return `${model.name} ${model.id} ${model.provider} ${surfaceLabel(model)}`.toLowerCase().includes(q);
    };
    const make = (key: string, title: string, predicate: (model: AIModel) => boolean): ModelGroup => ({
      key,
      title,
      models: models.filter((model) => predicate(model) && matches(model)).sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b))),
    });

    return [
      make('openai-api', 'OpenAI API', (model) => model.provider === 'openai' && !model.id.startsWith('chatgpt:')),
      make('claude', 'Claude', (model) => model.provider === 'anthropic' && !model.id.startsWith('claude-cli:')),
      make('remote', 'Remote', (model) => model.provider === 'remote'),
    ].filter((group) => group.models.length > 0);
  }, [availableModels, search]);

  const filteredCodex = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return codex;
    return codex.filter((model) => `${model.name} ${model.id} codex`.toLowerCase().includes(q));
  }, [codex, search]);

  const matchesChatgptSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chatgpt.length > 0 || chatgptSessionActive === true;
    return chatgpt.some((m) => `${m.name} ${m.id} chatgpt openai`.toLowerCase().includes(q))
      || (chatgptSessionActive === true && 'chatgpt subscription openai'.includes(q));
  }, [chatgpt, chatgptSessionActive, search]);

  const filteredAntigravity = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return antigravity;
    return antigravity.filter((model) => {
      const parsed = parseAntigravityModel(model);
      return `${model.name} ${model.id} antigravity ${parsed.provider} ${parsed.model} ${parsed.mode}`.toLowerCase().includes(q);
    });
  }, [antigravity, search]);
  const matchesAntigravitySearch = filteredAntigravity.length > 0;

  const filteredClaudeCli = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return claudeCli;
    return claudeCli.filter((model) => `${model.name} ${model.id} claude anthropic`.toLowerCase().includes(q));
  }, [claudeCli, search]);
  const matchesClaudeCliSearch = filteredClaudeCli.length > 0;

  const matchesGeminiSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return gemini.length > 0;
    return gemini.some((model) => `${model.name} ${model.id} gemini google ${surfaceLabel(model)}`.toLowerCase().includes(q));
  }, [gemini, search]);

  const matchesOllamaSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ollama.length > 0;
    return ollama.some((model) => `${model.name} ${model.id} ollama lokaal`.toLowerCase().includes(q));
  }, [ollama, search]);

  const selectModel = (model: AIModel) => {
    const ref = configuredModelRef(model);
    applySelection(ref.modelId, ref.provider, ref.runConfig);
    requestClose();
  };

  const selectCodex = () => {
    const model = codex.find((candidate) => candidate.id === codexModelId) || codex[0];
    if (!model) return;
    const runConfig = codexRunConfig(model, { reasoningEffort: codexEffort, ...(codexTier ? { serviceTier: codexTier } : {}) });
    applySelection(model.id, 'codex', runConfig);
    requestClose();
  };

  const activeCodex = codex.find((model) => model.id === codexModelId) || codex[0];
  const activeCodexChoice = parseCodexModel(activeCodex);
  const codexVersions = Array.from(new Set(codex.map((model) => parseCodexModel(model).version)));
  const codexVariants = codex.filter((model) => parseCodexModel(model).version === activeCodexChoice.version);
  const codexTierOptions = serviceTiersForModel(activeCodex);
  const codexEffortOptions = codexEffortsForModel(activeCodex)
    .map((effort) => ({ value: effort, label: reasoningEffortLabel(effort) }));
  const activeCodexEffort = codexEffortForModel(activeCodex, codexEffort);
  const onCodexModelChange = (modelId: string) => {
    const next = codex.find((model) => model.id === modelId) || codex[0];
    setCodexModelId(modelId);
    setCodexEffort(codexEffortForModel(next, activeCodexEffort));
    const tiers = serviceTiersForModel(next);
    if (!tiers.includes(codexTier)) setCodexTier(tiers[0] || '');
  };
  const onCodexVersionChange = (version: string) => {
    const next = codex.find((model) => parseCodexModel(model).version === version);
    if (next) onCodexModelChange(next.id);
  };
  const codexControlCount = 1
    + Number(codexVariants.length > 1)
    + Number(codexEffortOptions.length > 1)
    + Number(codexTierOptions.length > 1);

  // ── ChatGPT helpers ──
  // ChatGPT levert z'n modelkiezer zelf aan (versions + intelligence_presets). Die
  // gebruiken we 1-op-1: dezelfde modellen en niveaus als de website, inclusief de
  // "5.5" achter Direct en een grijze Pro.
  const versions = chatgptVersions.filter((version) => version.enabled);
  const activeVersion = versions.find((version) => version.title === chatgptBase) || versions[0];
  const chatgptLevelList: PickerLevel[] = (activeVersion?.presets || []).map((preset) => ({
    key: chatgptLevelKey(`chatgpt:${preset.modelSlug}`, preset.thinkingEffort),
    modelId: `chatgpt:${preset.modelSlug}`,
    effort: preset.thinkingEffort,
    // De subtitle is ChatGPT's hint dat dit niveau op een ánder model draait.
    label: preset.subtitle ? `${preset.title} · ${preset.subtitle}` : preset.title,
    available: preset.available,
  }));

  const activeLevel = chatgptLevelList.find((level) => level.key === chatgptLevel) || chatgptLevelList[0];
  const activeChatgpt = activeVersion
    ? chatgpt.find((m) => m.id === activeLevel?.modelId)
      || chatgpt.find((m) => m.id === `chatgpt:${activeVersion.slugs[0]}`)
    : undefined;
  const chatgptSummary = compactChoiceLabel(activeVersion?.title || '', activeLevel?.label || '');
  const chatgptBaseOptions = versions.map((version) => ({ value: version.title, label: version.title }));
  const chatgptBaseValue = activeVersion?.title || '';

  const onChatgptBaseChange = (base: string) => {
    setChatgptBase(base);
    const next = versions.find((version) => version.title === base);
    const presets = next?.presets || [];
    // Probeer hetzelfde niveau te behouden (bv. "Hoog"), anders het eerste.
    const keep = presets.find((preset) => preset.title === activeLevel?.label?.split(' · ')[0]) || presets[0];
    setChatgptLevel(keep ? chatgptLevelKey(`chatgpt:${keep.modelSlug}`, keep.thinkingEffort) : '');
  };

  const selectChatgpt = () => {
    if (!activeVersion || !chatgptCatalogReady) return;
    const level = activeLevel;
    const model = level ? chatgpt.find((m) => m.id === level.modelId) : activeChatgpt;
    if (!model) return;
    applySelection(model.id, 'openai', {
      ...(model.runConfig || {}),
      ...(level?.effort ? { chatgptThinkingEffort: level.effort } : {}),
    });
    requestClose();
  };

  const refreshChatgptCatalog = useCallback(async () => {
    if (!window.electronAPI || chatgptCatalogRefreshInFlightRef.current) return;
    chatgptCatalogRefreshInFlightRef.current = true;
    setChatgptCatalogRefreshing(true);
    try {
      // Eerst cachevrij de modellen ophalen; versions() leest daarna de presets
      // die bij dezelfde backend-snapshot horen.
      const models = await window.electronAPI.providers.refreshModels('openai');
      const [versions, session] = await Promise.all([
        window.electronAPI.providers.chatgptVersions(),
        window.electronAPI.auth.chatgptSessionStatus(),
      ]);
      if (Array.isArray(models)) useProviderStore.getState().setProviderModels('openai', models);
      if (Array.isArray(versions)) useProviderStore.getState().setChatgptVersions(versions);
      if (typeof session?.active === 'boolean') {
        useProviderStore.getState().setChatgptSessionActive(session.active);
      }
    } finally {
      chatgptCatalogRefreshInFlightRef.current = false;
      setChatgptCatalogRefreshing(false);
    }
  }, []);

  // Ook wanneer de globale achtergrondpoll al is afgelopen, doet elke nieuw
  // geopende modelkiezer zelf meteen één poging. De knop blijft alleen als
  // handmatige uitweg voor een langdurige netwerk- of sessiestoring staan.
  useEffect(() => {
    if (chatgptSessionActive === true && !chatgptCatalogReady) {
      void refreshChatgptCatalog();
    }
  }, [chatgptCatalogReady, chatgptSessionActive, refreshChatgptCatalog]);

  const claudeFamilyList = claudeCliFamilies(availableModels);
  const claudeVersionList = claudeCliVersionsFor(availableModels, claudeCliFamily);
  const activeClaudeCli = claudeCliModelFor(availableModels, claudeCliFamily, claudeCliVersion) || initialClaudeCli || claudeCli[0];
  const claudeEffortOptions = (activeClaudeCli?.supportedReasoningEfforts || ['low', 'medium', 'high', 'xhigh', 'max'])
    .map((effort) => ({ value: effort, label: reasoningEffortLabel(effort) }));
  const claudeSummary = compactChoiceLabel(claudeCliFamily, claudeCliVersion, claudeCliEffort);
  const claudeFamilyOptions = claudeFamilyList.map((family) => {
    const versions = claudeCliVersionsFor(availableModels, family);
    return {
      value: family,
      label: compactChoiceLabel(family, versions.length === 1 ? versions[0] : ''),
    };
  });
  const onClaudeFamilyChange = (family: string) => {
    setClaudeCliFamily(family);
    const versions = claudeCliVersionsFor(availableModels, family);
    setClaudeCliVersion(versions.includes(claudeCliVersion) ? claudeCliVersion : versions[0] || '');
  };

  const antigravityProviderList = antigravityProviders(availableModels);
  const antigravityModelList = antigravityModelNamesFor(availableModels, antigravityProvider);
  const antigravityModeList = antigravityModesFor(availableModels, antigravityProvider, antigravityModelName);
  const activeAntigravity = antigravityModelFor(availableModels, antigravityProvider, antigravityModelName, antigravityMode) || initialAntigravity || antigravity[0];
  const antigravitySummary = compactChoiceLabel(antigravityProvider, antigravityModelName, antigravityMode);
  const antigravityProviderOptions = antigravityProviderList.map((provider) => {
    const models = antigravityModelNamesFor(availableModels, provider);
    const singleModel = models.length === 1 ? models[0] : '';
    const modes = singleModel ? antigravityModesFor(availableModels, provider, singleModel) : [];
    return {
      value: provider,
      label: compactChoiceLabel(provider, singleModel, modes.length === 1 ? modes[0] : ''),
    };
  });
  const antigravityModelOptions = antigravityModelList.map((modelName) => {
    const modes = antigravityModesFor(availableModels, antigravityProvider, modelName);
    return {
      value: modelName,
      label: compactChoiceLabel(modelName, modes.length === 1 ? modes[0] : ''),
    };
  });
  const onAntigravityProviderChange = (provider: string) => {
    setAntigravityProvider(provider);
    const models = antigravityModelNamesFor(availableModels, provider);
    const nextModel = models.includes(antigravityModelName) ? antigravityModelName : models[0] || '';
    setAntigravityModelName(nextModel);
    const modes = antigravityModesFor(availableModels, provider, nextModel);
    setAntigravityMode(modes.includes(antigravityMode) ? antigravityMode : modes[0] || '');
  };
  const onAntigravityModelChange = (modelName: string) => {
    setAntigravityModelName(modelName);
    const modes = antigravityModesFor(availableModels, antigravityProvider, modelName);
    setAntigravityMode(modes.includes(antigravityMode) ? antigravityMode : modes[0] || '');
  };

  const selectAntigravity = () => {
    if (!activeAntigravity) return;
    applySelection(activeAntigravity.id, 'antigravity', activeAntigravity.runConfig || undefined);
    requestClose();
  };

  const selectClaudeCli = () => {
    if (!activeClaudeCli) return;
    applySelection(activeClaudeCli.id, 'anthropic', { ...(activeClaudeCli.runConfig || {}), reasoningEffort: claudeCliEffort });
    requestClose();
  };

  const selectGemini = () => {
    if (!activeGemini) return;
    applySelection(activeGemini.id, 'google', activeGemini.runConfig || undefined);
    requestClose();
  };

  const selectOllama = () => {
    if (!activeOllama) return;
    applySelection(activeOllama.id, 'ollama', activeOllama.runConfig || undefined);
    requestClose();
  };

  const selector = (
    <div className={`model-selector-overlay model-picker-overlay ${closing ? 'closing' : ''}`} onClick={requestClose}>
      <div className="model-selector-panel model-selector-panel-wide" onClick={(event) => event.stopPropagation()}>
        <div className="model-selector-search">
          <Search size={16} />
          <input type="text" placeholder={t('models.search')} value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
        </div>

        <div className="model-selector-list">
          {filteredCodex.length > 0 && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>Codex CLI</span>
                <span className={`status-badge ${authStatus.codex?.authenticated ? 'online' : 'offline'}`}>
                  {authStatus.codex?.statusLabel || 'CLI auth nodig'}
                </span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'codex' ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <Sparkles size={16} />
                      Codex CLI
                    </div>
                    <div className="model-option-context">Account-brede limiet, model en inspanning hieronder kiezen</div>
                  </div>
                  <QuotaBadge model={activeCodex} />
                </div>
                <div
                  className="codex-config-grid codex-model-config-grid"
                  style={{ '--codex-control-count': codexControlCount } as React.CSSProperties}
                >
                  <SelectField label="Model" value={activeCodexChoice.version} onChange={onCodexVersionChange} options={codexVersions.map((version) => ({ value: version, label: version }))} />
                  {codexVariants.length > 1 && (
                    <SelectField label="Variant" value={activeCodex?.id || ''} onChange={onCodexModelChange} options={codexVariants.map((model) => ({ value: model.id, label: parseCodexModel(model).variant }))} />
                  )}
                  {codexEffortOptions.length > 1 && (
                    <SelectField label="Inspanning" value={activeCodexEffort} onChange={(value) => setCodexEffort(value as ReasoningEffort)} options={codexEffortOptions} />
                  )}
                  {codexTierOptions.length > 1 && (
                    <SelectField label="Snelheid" value={codexTier} onChange={(value) => setCodexTier(value as ServiceTier)} options={codexTierOptions.map((tier) => ({ value: tier, label: serviceTierLabel(tier) }))} />
                  )}
                  <button type="button" className="btn btn-primary" onClick={selectCodex} disabled={!activeCodex}>
                    <Check size={16} />
                    Gebruik Codex
                  </button>
                </div>
              </div>
            </div>
          )}

          {matchesChatgptSearch && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>ChatGPT Subscription</span>
                <span className={`status-badge ${chatgptStatusClass}`}>{chatgptStatusLabel}</span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'openai' && activeModelId.startsWith('chatgpt:') ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <Globe2 size={16} />
                      ChatGPT Subscription
                    </div>
                    <div className="model-option-context">Geen API-key · {chatgptSummary || 'via je ingelogde ChatGPT-account'}</div>
                  </div>
                  <QuotaBadge model={activeChatgpt} />
                </div>
                <div className="codex-config-grid">
                  {!chatgptCatalogReady && chatgptSessionActive && (
                    <div className="chatgpt-catalog-notice">
                      <span>De sessie is gekoppeld, maar de live modelcatalogus ontbreekt. Er wordt geen standaardmodel gekozen.</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void refreshChatgptCatalog()}
                        disabled={chatgptCatalogRefreshing}
                      >
                        {chatgptCatalogRefreshing
                          ? <Loader2 size={14} className="spin" />
                          : <RefreshCw size={14} />}
                        Opnieuw laden
                      </button>
                    </div>
                  )}
                  {chatgptBaseOptions.length > 1 && (
                    <SelectField label="Model" value={chatgptBaseValue} onChange={onChatgptBaseChange} options={chatgptBaseOptions} />
                  )}
                  {chatgptLevelList.length > 1 && (
                    <SelectField
                      label="Intelligentie"
                      value={activeLevel?.key || ''}
                      onChange={setChatgptLevel}
                      options={chatgptLevelList.map((level) => ({ value: level.key, label: level.label, disabled: !level.available }))}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={selectChatgpt}
                    disabled={!activeChatgpt || !chatgptSelectable}
                    title={chatgptSelectable ? undefined : chatgptSessionActive ? 'Laad eerst de live ChatGPT-modelcatalogus' : 'Log eerst in op je ChatGPT-websessie'}
                  >
                    <Check size={16} />
                    Gebruik ChatGPT
                  </button>
                </div>
              </div>
            </div>
          )}

          {matchesClaudeCliSearch && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>Claude CLI</span>
                <span className={`status-badge ${claudeCli.length ? 'online' : 'offline'}`}>
                  {claudeCli.length ? 'CLI gevonden' : 'CLI nodig'}
                </span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'anthropic' && activeModelId.startsWith('claude-cli:') ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <Bot size={16} />
                      Claude Code CLI
                    </div>
                    <div className="model-option-context">Account-brede limiet · {claudeSummary || 'Claude CLI'}</div>
                  </div>
                  <QuotaBadge model={activeClaudeCli} />
                </div>
                <div className="codex-config-grid claude-config-grid">
                  {claudeFamilyOptions.length > 1 && (
                    <SelectField label="Familie" value={claudeCliFamily} onChange={onClaudeFamilyChange} options={claudeFamilyOptions} />
                  )}
                  {claudeVersionList.length > 1 && (
                    <SelectField label="Versie" value={claudeCliVersion} onChange={setClaudeCliVersion} options={claudeVersionList.map((version) => ({ value: version, label: version }))} />
                  )}
                  {claudeEffortOptions.length > 1 && (
                    <SelectField label="Effort" value={claudeCliEffort} onChange={(value) => setClaudeCliEffort(value as ReasoningEffort)} options={claudeEffortOptions} />
                  )}
                  <button type="button" className="btn btn-primary" onClick={selectClaudeCli} disabled={!activeClaudeCli}>
                    <Check size={16} />
                    Gebruik Claude
                  </button>
                </div>
              </div>
            </div>
          )}

          {matchesAntigravitySearch && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>Antigravity</span>
                <span className={`status-badge ${authStatus.antigravity?.authenticated ? 'online' : 'offline'}`}>
                  {authStatus.antigravity?.authenticated ? 'CLI gevonden' : 'CLI niet gevonden'}
                </span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'antigravity' ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <Rocket size={16} />
                      Antigravity CLI
                    </div>
                    <div className="model-option-context">Account-brede limiet · {antigravitySummary || 'Antigravity CLI'}</div>
                  </div>
                  <QuotaBadge model={activeAntigravity} />
                </div>
                <div className="codex-config-grid antigravity-config-grid">
                  {antigravityProviderOptions.length > 1 && (
                    <SelectField label="Provider" value={antigravityProvider} onChange={onAntigravityProviderChange} options={antigravityProviderOptions} />
                  )}
                  {antigravityModelOptions.length > 1 && (
                    <SelectField label="Model" value={antigravityModelName} onChange={onAntigravityModelChange} options={antigravityModelOptions} />
                  )}
                  {antigravityModeList.length > 1 && (
                    <SelectField label="Stand" value={antigravityMode} onChange={setAntigravityMode} options={antigravityModeList.map((mode) => ({ value: mode, label: mode }))} />
                  )}
                  <button type="button" className="btn btn-primary" onClick={selectAntigravity} disabled={!activeAntigravity}>
                    <Check size={16} />
                    Gebruik Antigravity
                  </button>
                </div>
              </div>
            </div>
          )}

          {matchesGeminiSearch && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>Gemini</span>
                <span className={`status-badge ${authStatus.google?.authenticated ? 'online' : 'offline'}`}>
                  {authStatus.google?.statusLabel || 'Niet verbonden'}
                </span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'google' ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <Sparkles size={16} />
                      Gemini
                    </div>
                    <div className="model-option-context">
                      {activeGemini ? `${surfaceLabel(activeGemini)} · ${formatContextSize(activeGemini.contextWindow)} context` : 'Google AI'}
                    </div>
                  </div>
                  <QuotaBadge model={activeGemini} />
                </div>
                <div className="codex-config-grid gemini-config-grid">
                  <SelectField
                    label="Familie"
                    value={activeGeminiChoice.family}
                    onChange={onGeminiFamilyChange}
                    options={geminiFamilies.map((family) => ({ value: family, label: family }))}
                  />
                  <SelectField
                    label="Versie"
                    value={activeGeminiChoice.version}
                    onChange={onGeminiVersionChange}
                    options={geminiVersions.map((version) => ({ value: version, label: version }))}
                  />
                  <SelectField
                    label="Variant"
                    value={activeGemini?.id || ''}
                    onChange={setGeminiModelId}
                    options={geminiVariants.map((model) => ({ value: model.id, label: parseGoogleModelChoice(model).variant }))}
                  />
                  <button type="button" className="btn btn-primary" onClick={selectGemini} disabled={!activeGemini}>
                    <Check size={16} />
                    Gebruik Gemini
                  </button>
                </div>
              </div>
            </div>
          )}

          {matchesOllamaSearch && (
            <div className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>Ollama lokaal</span>
                <span className={`status-badge ${authStatus.ollama?.authenticated ? 'online' : 'offline'}`}>
                  {authStatus.ollama?.statusLabel || 'Ollama offline'}
                </span>
              </div>
              <div className={`model-option model-option-composite ${activeProvider === 'ollama' ? 'active' : ''}`}>
                <div className="composite-model-header">
                  <div>
                    <div className="model-option-name">
                      <HardDrive size={16} />
                      Ollama
                    </div>
                    <div className="model-option-context">
                      Lokaal model · {activeOllama ? `${formatContextSize(activeOllama.contextWindow)} context` : 'Ollama'}
                    </div>
                  </div>
                  <QuotaBadge model={activeOllama} />
                </div>
                <div className="codex-config-grid ollama-config-grid">
                  <SelectField
                    label="Model"
                    value={activeOllamaChoice.family}
                    onChange={onOllamaFamilyChange}
                    options={ollamaFamilies.map((family) => ({ value: family, label: family }))}
                  />
                  <SelectField
                    label="Variant"
                    value={activeOllama?.id || ''}
                    onChange={setOllamaModelId}
                    options={ollamaVariants}
                  />
                  <button type="button" className="btn btn-primary" onClick={selectOllama} disabled={!activeOllama}>
                    <Check size={16} />
                    Gebruik Ollama
                  </button>
                </div>
              </div>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.key} className="model-provider-section">
              <div className="model-group-label provider-label">
                <span>{group.title}</span>
                <span className="status-badge neutral">{group.models.length} model(len)</span>
              </div>
              {group.models.map((model) => (
                <button
                  key={`${model.provider}:${model.id}`}
                  type="button"
                  className={`model-option model-option-button ${activeProvider === model.provider && activeModelId === model.id ? 'active' : ''}`}
                  onClick={() => selectModel(model)}
                >
                  <div>
                    <div className="model-option-name">{modelDisplayName(model)}</div>
                    <div className="model-option-context">
                      {formatContextSize(model.contextWindow)} context - {surfaceLabel(model)}
                    </div>
                  </div>
                  <div className="model-option-side">
                    <ProviderBadge provider={model.provider as ProviderType} label={model.sourceLabel || surfaceLabel(model)} />
                    <QuotaBadge model={model} />
                  </div>
                </button>
              ))}
            </div>
          ))}

          {!filteredCodex.length && !matchesChatgptSearch && !matchesClaudeCliSearch && !matchesAntigravitySearch && !matchesGeminiSearch && !matchesOllamaSearch && !groups.length && (
            <div className="model-empty-row">{emptyMessage(authStatus, accountStatuses)}</div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(selector, document.body);
};

function formatContextSize(tokens: number) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function parseOllamaModel(model?: AIModel) {
  const raw = (model?.id || '').replace(/^ollama:/, '');
  const separator = raw.lastIndexOf(':');
  if (separator < 0) return { family: raw || 'Ollama', variant: 'latest' };
  return {
    family: raw.slice(0, separator),
    variant: raw.slice(separator + 1) || 'latest',
  };
}

function compactChoiceLabel(...parts: Array<string | undefined | null | false>) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' · ');
}

function emptyMessage(authStatus: ReturnType<typeof useProviderStore.getState>['authStatus'], accountStatuses: ReturnType<typeof useProviderStore.getState>['accountStatuses']) {
  const labels = [authStatus.openai?.statusLabel, authStatus.codex?.statusLabel, accountStatuses.chatgpt?.statusLabel].filter(Boolean);
  return labels[0] || 'Geen chatmodellen gevonden. Log in of refresh modellen in Settings.';
}

export default ModelSelector;
