import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ExternalLink,
  FileCode2,
  HelpCircle,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { useProviderStore } from '../stores/provider-store';
import type {
  CredentialStatus,
  ProviderType,
  RuntimeSetupProgress,
  RuntimeStatus,
} from '../providers/types';
import { ProviderAvatarIcon } from './ProviderAvatarIcon';
import { ONBOARDING_DONE_KEY, ONBOARDING_SERVICES_KEY, type ServiceAnswer } from './onboarding-launch';
import {
  answerOnboardingServices,
  detectOnboardingService,
  ONBOARDING_SERVICES,
  selectedOnboardingServices,
  showOnboardingSetupProgress,
  type OnboardingDetection,
  type OnboardingProviderSnapshot,
  type OnboardingService,
  type OnboardingServiceId,
} from './onboarding-utils';

type Step = 'welcome' | 'what' | 'scanning' | 'confirm' | 'missing' | 'setup' | 'runtime' | 'ready' | 'done';
type SetupState = 'idle' | 'working' | 'waiting' | 'success' | 'error';

const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const OnboardingGuide: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [step, setStep] = useState<Step>('welcome');
  const [answers, setAnswers] = useState<Record<string, ServiceAnswer>>({});
  const [gaveUp, setGaveUp] = useState(false);
  const [setupIndex, setSetupIndex] = useState(0);
  const [setupState, setSetupState] = useState<SetupState>('idle');
  const [setupMessage, setSetupMessage] = useState('');
  const [setupProgress, setSetupProgress] = useState<RuntimeSetupProgress | null>(null);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiProjectId, setGeminiProjectId] = useState('');
  const [geminiOauthClientId, setGeminiOauthClientId] = useState('');
  const [pythonStatus, setPythonStatus] = useState<RuntimeStatus | null>(null);
  const [pythonState, setPythonState] = useState<SetupState>('idle');
  const [pythonMessage, setPythonMessage] = useState('');
  const [pythonProgress, setPythonProgress] = useState<RuntimeSetupProgress | null>(null);
  const cancelled = useRef(false);
  const setupActionRun = useRef(0);

  const store = useProviderStore();
  const snapshot = store as OnboardingProviderSnapshot;
  const detected = Object.fromEntries(
    ONBOARDING_SERVICES.map((service) => [service.provider, detectOnboardingService(service.provider, snapshot)]),
  ) as Record<OnboardingServiceId, OnboardingDetection>;

  const stillLooking = !gaveUp && (
    store.isRefreshingModels || ONBOARDING_SERVICES.some((service) => detected[service.provider].state === 'unknown')
  );
  const selectedServices = selectedOnboardingServices(answers);
  const currentSetup = selectedServices[setupIndex];
  const currentDetection = currentSetup ? detected[currentSetup.provider] : undefined;

  const refreshProviderState = useCallback(async (provider?: OnboardingServiceId) => {
    const api = window.electronAPI;
    if (!api) return;
    const providerStore = useProviderStore.getState();
    providerStore.setRefreshingModels(true);
    try {
      const [authResult, accountResult, sessionResult, modelResult, versionsResult] = await Promise.allSettled([
        api.auth.getStatus(),
        api.providers.getAccountStatuses(),
        api.auth.chatgptSessionStatus(),
        api.providers.refreshModels(provider),
        provider === 'openai' || !provider
          ? api.providers.chatgptVersions()
          : Promise.resolve([]),
      ]);
      if (cancelled.current) return;
      if (authResult.status === 'fulfilled') {
        Object.entries(authResult.value).forEach(([id, status]) => {
          useProviderStore.getState().setAuthStatus(id as ProviderType, status as CredentialStatus);
        });
      }
      if (accountResult.status === 'fulfilled') {
        useProviderStore.getState().setAccountStatuses(accountResult.value);
      }
      if (sessionResult.status === 'fulfilled' && typeof sessionResult.value?.active === 'boolean') {
        useProviderStore.getState().setChatgptSessionActive(sessionResult.value.active);
      }
      if (modelResult.status === 'fulfilled' && Array.isArray(modelResult.value)) {
        if (provider) useProviderStore.getState().setProviderModels(provider, modelResult.value);
        else useProviderStore.getState().setModels(modelResult.value);
      }
      if (versionsResult.status === 'fulfilled' && Array.isArray(versionsResult.value)) {
        useProviderStore.getState().setChatgptVersions(versionsResult.value);
      }
    } finally {
      if (!cancelled.current) useProviderStore.getState().setRefreshingModels(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.runtime) return undefined;
    return api.runtime.onSetupProgress((progress: RuntimeSetupProgress) => {
      if (currentSetup && progress.runtime === setupProgressTarget(currentSetup.provider)) {
        setSetupProgress(progress);
        setSetupMessage(progress.status);
        setSetupState(
          progress.phase === 'ready'
            ? 'success'
            : progress.phase === 'error'
              ? 'error'
              : progress.phase === 'awaiting-login'
                ? 'waiting'
                : 'working',
        );
      }
      if (progress.runtime === 'python') {
        setPythonProgress(progress);
        setPythonMessage(progress.status);
        setPythonState(progress.phase === 'ready' ? 'success' : progress.phase === 'error' ? 'error' : 'working');
      }
    });
  }, [currentSetup]);

  useEffect(() => {
    if (step !== 'scanning') return;
    setGaveUp(false);
    void refreshProviderState();
    const timer = window.setTimeout(() => setGaveUp(true), 30000);
    return () => clearTimeout(timer);
  }, [refreshProviderState, step]);

  useEffect(() => {
    if (step !== 'scanning' || stillLooking) return;
    setAnswers((previous) => {
      const next = { ...previous };
      for (const service of ONBOARDING_SERVICES) {
        if (detected[service.provider].state === 'found') next[service.provider] = 'yes';
      }
      return next;
    });
    const timer = window.setTimeout(() => { if (!cancelled.current) setStep('confirm'); }, 700);
    return () => clearTimeout(timer);
    // De gedetailleerde detectie verandert tijdens de scan; `stillLooking` is de
    // stabiele overgangsvoorwaarde die voorkomt dat de timer steeds wordt vervangen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stillLooking]);

  const finish = async () => {
    setStep('ready');
    await window.electronAPI?.settings.set(ONBOARDING_SERVICES_KEY, answers).catch(() => { });
    await window.electronAPI?.settings.set(ONBOARDING_DONE_KEY, new Date().toISOString()).catch(() => { });
    await delay(700);
    if (cancelled.current) return;
    setStep('done');
    await delay(1200);
    if (!cancelled.current) onClose();
  };

  const openRuntimeStep = async () => {
    setStep('runtime');
    setPythonState('working');
    setPythonMessage('Python-runtime controleren...');
    try {
      const status = await window.electronAPI?.runtime?.getStatus('python');
      if (cancelled.current || !status) return;
      setPythonStatus(status);
      setPythonState(status.ready ? 'success' : 'idle');
      setPythonMessage(status.detail);
    } catch (error) {
      if (cancelled.current) return;
      setPythonState('error');
      setPythonMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const beginSetup = () => {
    if (!selectedServices.length) {
      void openRuntimeStep();
      return;
    }
    setSetupIndex(0);
    setSetupState('idle');
    setSetupMessage('');
    setSetupProgress(null);
    setStep('setup');
  };

  const waitUntilReady = async (provider: OnboardingServiceId, runId: number) => {
    for (
      let attempt = 0;
      attempt < 40 && !cancelled.current && setupActionRun.current === runId;
      attempt += 1
    ) {
      await delay(attempt === 0 ? 1000 : 3000);
      if (cancelled.current || setupActionRun.current !== runId) return false;
      if (provider !== 'openai') {
        await window.electronAPI?.auth.testCredential(provider).catch(() => null);
      }
      await refreshProviderState(provider);
      const latest = useProviderStore.getState();
      if (detectOnboardingService(provider, latest).ready) return true;
    }
    return false;
  };

  const runSetupAction = async () => {
    if (!currentSetup || !window.electronAPI) return;
    const runId = setupActionRun.current + 1;
    setupActionRun.current = runId;
    const provider = currentSetup.provider;
    setSetupState('working');
    setSetupMessage('');
    setSetupProgress(null);

    try {
      let result: { success?: boolean; error?: string; message?: string } | undefined;
      if (provider === 'openai') {
        result = await window.electronAPI.auth.chatgptBrowserLogin();
        setSetupMessage('Log in in het geopende ChatGPT-venster. De gids controleert je sessie automatisch.');
      } else if (provider === 'codex') {
        result = await window.electronAPI.auth.codexCliLogin();
        setSetupMessage(result?.message || 'Rond de ChatGPT-login af in het geopende terminalvenster.');
      } else if (provider === 'anthropic') {
        result = await window.electronAPI.auth.claudeCliLogin();
        setSetupMessage(result?.message || 'Rond de Claude-login af in het geopende terminalvenster.');
      } else if (provider === 'antigravity') {
        result = await window.electronAPI.auth.antigravityCliLogin();
        setSetupMessage(result?.message || 'Rond de Google-login af in het geopende terminalvenster.');
      } else if (provider === 'google') {
        if (!geminiApiKey.trim()) throw new Error('Plak eerst je Gemini API-sleutel.');
        if (!geminiProjectId.trim() || !geminiOauthClientId.trim()) throw new Error('Vul ook het Google Cloud-project en de OAuth desktop-client-ID in.');
        const validation = await window.electronAPI.auth.saveCredential('google', geminiApiKey.trim(), 'apikey');
        if (validation.status !== 'valid') throw new Error(validation.error || 'De Gemini API-sleutel is niet geldig.');
        await window.electronAPI.geminiQuota.configure(geminiProjectId.trim(), geminiOauthClientId.trim());
        const quotaStatus = await window.electronAPI.geminiQuota.connect();
        if (!quotaStatus.connected) throw new Error(quotaStatus.error || 'Google Cloud-quota koppelen is niet gelukt.');
        setGeminiApiKey('');
        result = { success: true, message: 'Gemini API-key en Google Cloud-quota zijn gekoppeld.' };
        setSetupMessage(result.message || 'Gemini API-key en Google Cloud-quota zijn gekoppeld.');
      } else {
        const status = await window.electronAPI.runtime.install('ollama');
        result = {
          success: status.ready,
          error: status.ready ? undefined : status.detail,
          message: status.detail,
        };
        setSetupMessage(status.detail);
      }

      if (result && result.success === false) throw new Error(result.error || 'De configuratiestap kon niet worden gestart.');
      if (provider === 'codex' || provider === 'anthropic' || provider === 'antigravity') {
        setSetupState('waiting');
      }
      const ready = await waitUntilReady(provider, runId);
      if (cancelled.current || setupActionRun.current !== runId) return;
      if (ready) {
        setSetupState('success');
        setSetupMessage(`${currentSetup.name} is gecontroleerd en gebruiksklaar.`);
      } else {
        setSetupState(
          provider === 'codex' || provider === 'anthropic' || provider === 'antigravity'
            ? 'waiting'
            : 'idle',
        );
        setSetupMessage('De stap is nog niet afgerond. Rond de installatie/login af en kies daarna “Controleer opnieuw”.');
      }
    } catch (error) {
      if (cancelled.current) return;
      setSetupState('error');
      setSetupMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const recheckCurrent = async () => {
    if (!currentSetup) return;
    setupActionRun.current += 1;
    setSetupState('working');
    setSetupMessage('Status controleren…');
    if (currentSetup.provider !== 'openai') {
      await window.electronAPI?.auth.testCredential(currentSetup.provider).catch(() => null);
    }
    await refreshProviderState(currentSetup.provider);
    const ready = detectOnboardingService(currentSetup.provider, useProviderStore.getState()).ready;
    setSetupState(ready ? 'success' : 'idle');
    setSetupMessage(ready
      ? `${currentSetup.name} is gebruiksklaar.`
      : 'Nog niet klaar. Rond de zichtbare installatie- of login-stap eerst af.');
  };

  const nextSetup = () => {
    setupActionRun.current += 1;
    if (setupIndex + 1 >= selectedServices.length) {
      void openRuntimeStep();
      return;
    }
    setSetupIndex((index) => index + 1);
    setSetupState('idle');
    setSetupMessage('');
    setSetupProgress(null);
    setGeminiApiKey('');
  };

  const installPython = async () => {
    if (!window.electronAPI?.runtime || pythonState === 'working') return;
    setPythonState('working');
    setPythonMessage('Officiële Python-installatie starten...');
    setPythonProgress(null);
    try {
      const status = await window.electronAPI.runtime.install('python');
      if (cancelled.current) return;
      setPythonStatus(status);
      setPythonState(status.ready ? 'success' : 'error');
      setPythonMessage(status.detail);
    } catch (error) {
      if (cancelled.current) return;
      setPythonState('error');
      setPythonMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const scanned = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state !== 'unknown').length;
  const foundServices = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state === 'found');
  const missingServices = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state !== 'found');

  return (
    <div className={`onboarding-screen ${step === 'done' ? 'leaving' : ''}`}>
      <button className="onboarding-close btn-icon" onClick={onClose} title="Overslaan" aria-label="Overslaan">
        <X size={18} />
      </button>

      <div className="onboarding-content">
        {step === 'welcome' && (
          <div key="welcome" className="onboarding-step onboarding-center">
            <img className="onboarding-logo" src="./icon.png" alt="" />
            <h1 className="onboarding-title">Hallo, welkom bij LLMelt</h1>
            <p className="onboarding-text">We controleren eerst wat al werkt en stellen daarna alleen jouw gekozen diensten in.</p>
            <button className="btn btn-primary onboarding-next" onClick={() => setStep('what')}>
              Beginnen <ArrowRight size={16} />
            </button>
          </div>
        )}

        {step === 'what' && (
          <div key="what" className="onboarding-step onboarding-center">
            <h1 className="onboarding-title">Al je LLM's op één plek</h1>
            <p className="onboarding-text">
              Installaties starten nooit stil. Jij kiest een provider, de gids opent de officiële installer of login,
              en controleert daarna of de koppeling echt werkt.
            </p>
            <div className="onboarding-logos">
              {ONBOARDING_SERVICES.map((service) => (
                <span key={service.provider} className={`onboarding-logo-chip ${service.provider}`} title={service.name}>
                  <ProviderAvatarIcon provider={service.provider} />
                </span>
              ))}
            </div>
            <button className="btn btn-primary onboarding-next" onClick={() => setStep('scanning')}>
              Controleer deze pc <ArrowRight size={16} />
            </button>
          </div>
        )}

        {step === 'scanning' && (
          <div key="scanning" className="onboarding-step onboarding-center">
            <Loader2 size={30} className="spin onboarding-spinner" />
            <h1 className="onboarding-title">Diensten en accounts controleren</h1>
            <p className="onboarding-text">
              We lezen alleen providerstatussen. Je gesprekken, bestanden en bestaande instellingen worden niet gewist.
            </p>
            <div className="onboarding-scanlist">
              {ONBOARDING_SERVICES.map((service) => {
                const hit = detected[service.provider];
                return (
                  <div key={service.provider} className={`onboarding-scanrow ${hit.state}`}>
                    <span className={`onboarding-logo-chip small ${service.provider}`}><ProviderAvatarIcon provider={service.provider} /></span>
                    <span className="onboarding-scanname">{service.name}</span>
                    <span className="onboarding-scandetail">{hit.detail || service.looksAt}</span>
                    <span className="onboarding-scanstate">
                      {hit.state === 'unknown'
                        ? <Loader2 size={13} className="spin" />
                        : hit.state === 'found' ? <Check size={15} /> : <X size={15} />}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="onboarding-progress">{scanned} van {ONBOARDING_SERVICES.length} gecontroleerd</p>
          </div>
        )}

        {step === 'confirm' && (
          <div key="confirm" className="onboarding-step">
            <h1 className="onboarding-title">Dit is al gevonden</h1>
            <p className="onboarding-text">
              “Gevonden” kan ook betekenen dat een CLI nog login nodig heeft; dat lossen we in de volgende stappen op.
            </p>
            <div className="onboarding-list">
              {foundServices.length > 0 && (
                <BulkServiceAnswers
                  onSelectAll={() => setAnswers((previous) =>
                    answerOnboardingServices(previous, foundServices, 'yes'))}
                  onDeselectAll={() => setAnswers((previous) =>
                    answerOnboardingServices(previous, foundServices, 'no'))}
                />
              )}
              {foundServices.length
                ? foundServices.map((service) => (
                  <ServiceRow
                    key={service.provider}
                    service={service}
                    detection={detected[service.provider]}
                    answer={answers[service.provider]}
                    options={['yes', 'no']}
                    onAnswer={(answer) => setAnswers((previous) => ({ ...previous, [service.provider]: answer }))}
                  />
                ))
                : <p className="onboarding-text">Nog niets gevonden. Geen probleem: kies hierna wat je wilt installeren of koppelen.</p>}
            </div>
            <div className="onboarding-actions">
              <button className="btn btn-primary" onClick={() => setStep('missing')}>
                Volgende <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'missing' && (
          <div key="missing" className="onboarding-step">
            <h1 className="onboarding-title">Wat wil je nog instellen?</h1>
            <p className="onboarding-text">Kies “Ja” om nu samen de installatie of login te doorlopen.</p>
            <div className="onboarding-list">
              {missingServices.length > 0 && (
                <BulkServiceAnswers
                  onSelectAll={() => setAnswers((previous) =>
                    answerOnboardingServices(previous, missingServices, 'yes'))}
                  onDeselectAll={() => setAnswers((previous) =>
                    answerOnboardingServices(previous, missingServices, 'no'))}
                />
              )}
              {missingServices.length
                ? missingServices.map((service) => (
                  <ServiceRow
                    key={service.provider}
                    service={service}
                    detection={detected[service.provider]}
                    answer={answers[service.provider]}
                    options={['yes', 'maybe', 'no']}
                    onAnswer={(answer) => setAnswers((previous) => ({ ...previous, [service.provider]: answer }))}
                  />
                ))
                : <p className="onboarding-text">Alle diensten zijn gevonden.</p>}
            </div>
            <div className="onboarding-actions">
              <button className="btn btn-secondary" onClick={() => setStep('confirm')}>Terug</button>
              <button className="btn btn-primary" onClick={beginSetup}>
                Instellen met mij <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'setup' && currentSetup && currentDetection && (
          <ProviderSetupStep
            key={`setup-${currentSetup.provider}-${setupIndex}`}
            service={currentSetup}
            detection={currentDetection}
            index={setupIndex}
            total={selectedServices.length + 1}
            state={currentDetection.ready ? 'success' : setupState}
            message={currentDetection.ready ? `${currentSetup.name} is al gebruiksklaar.` : setupMessage}
            progress={setupProgress}
            geminiApiKey={geminiApiKey}
            onGeminiApiKeyChange={setGeminiApiKey}
            geminiProjectId={geminiProjectId}
            geminiOauthClientId={geminiOauthClientId}
            onGeminiProjectIdChange={setGeminiProjectId}
            onGeminiOauthClientIdChange={setGeminiOauthClientId}
            onAction={runSetupAction}
            onRecheck={recheckCurrent}
            onBack={() => {
              if (setupIndex === 0) setStep('missing');
              else {
                setSetupIndex((index) => index - 1);
                setSetupState('idle');
                setSetupMessage('');
              }
            }}
            onNext={nextSetup}
          />
        )}

        {step === 'runtime' && (
          <div key="runtime" className="onboarding-step">
            <div className="onboarding-setup-progress">
              Stap {selectedServices.length + 1} van {selectedServices.length + 1}
            </div>
            <div className="onboarding-setup-heading">
              <span className="onboarding-logo-chip python"><FileCode2 size={22} /></span>
              <div>
                <h1 className="onboarding-title">Python voor code-opdrachten</h1>
                <p className="onboarding-text">
                  Python is optioneel voor chat, maar nodig wanneer een model Python-scripts moet bouwen en uitvoeren.
                </p>
              </div>
            </div>

            <ol className="onboarding-setup-list">
              <li>De app accepteert alleen een executable die echt een Python-versie retourneert.</li>
              <li>Installeren gebeurt pas na jouw klik via de officiële Python Install Manager.</li>
              <li>Na installatie wordt het executablepad opnieuw gecontroleerd en voor toolcommando’s bewaard.</li>
            </ol>

            {pythonStatus?.executablePath && (
              <div>
                <div className="settings-row-label mb-2">Gedetecteerd Python-pad</div>
                <div className="cli-path-display" title={pythonStatus.executablePath}>{pythonStatus.executablePath}</div>
              </div>
            )}

            <div className={`onboarding-setup-status ${pythonStatus?.ready ? 'success' : pythonState}`}>
              {pythonState === 'working'
                ? <Loader2 size={16} className="spin" />
                : pythonStatus?.ready ? <Check size={16} /> : pythonState === 'error' ? <X size={16} /> : <HelpCircle size={16} />}
              <span>{pythonMessage || pythonStatus?.detail || 'Python is nog niet gecontroleerd.'}</span>
            </div>
            <SetupProgressBar progress={pythonProgress} />

            {!pythonStatus?.ready && (
              <div className="onboarding-setup-buttons">
                <button className="btn btn-primary" onClick={installPython} disabled={pythonState === 'working'}>
                  {pythonState === 'working' ? <Loader2 size={15} className="spin" /> : <FileCode2 size={15} />}
                  {pythonState === 'working' ? 'Bezig…' : 'Installeer officiële Python'}
                </button>
                <button className="btn btn-secondary" onClick={() => void openRuntimeStep()} disabled={pythonState === 'working'}>
                  <RefreshCw size={14} /> Controleer opnieuw
                </button>
              </div>
            )}

            <div className="onboarding-actions">
              <button className="btn btn-secondary" onClick={() => setStep(selectedServices.length ? 'setup' : 'missing')} disabled={pythonState === 'working'}>
                Terug
              </button>
              <button className="btn btn-primary" onClick={() => void finish()} disabled={pythonState === 'working'}>
                {pythonStatus?.ready ? 'Afronden' : 'Zonder Python doorgaan'} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'ready' && (
          <div key="ready" className="onboarding-step onboarding-center">
            <Loader2 size={30} className="spin onboarding-spinner" />
            <h1 className="onboarding-title">Keuzes opslaan…</h1>
          </div>
        )}

        {step === 'done' && (
          <div key="done" className="onboarding-step onboarding-center">
            <Sparkles size={36} className="onboarding-sparkle" />
            <h1 className="onboarding-title">LLMelt staat klaar</h1>
            <p className="onboarding-text">Je kunt providerinstellingen en deze gids later altijd opnieuw openen.</p>
          </div>
        )}
      </div>
    </div>
  );
};

function ProviderSetupStep({
  service,
  detection,
  index,
  total,
  state,
  message,
  progress,
  geminiApiKey,
  onGeminiApiKeyChange,
  geminiProjectId,
  geminiOauthClientId,
  onGeminiProjectIdChange,
  onGeminiOauthClientIdChange,
  onAction,
  onRecheck,
  onBack,
  onNext,
}: {
  service: OnboardingService;
  detection: OnboardingDetection;
  index: number;
  total: number;
  state: SetupState;
  message: string;
  progress: RuntimeSetupProgress | null;
  geminiApiKey: string;
  onGeminiApiKeyChange: (value: string) => void;
  geminiProjectId: string;
  geminiOauthClientId: string;
  onGeminiProjectIdChange: (value: string) => void;
  onGeminiOauthClientIdChange: (value: string) => void;
  onAction: () => void;
  onRecheck: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const working = state === 'working';
  const ready = detection.ready || state === 'success';
  const info = setupInfo(service.provider, detection);

  return (
    <div className="onboarding-step">
      <div className="onboarding-setup-progress">Stap {index + 1} van {total}</div>
      <div className="onboarding-setup-heading">
        <span className={`onboarding-logo-chip ${service.provider}`}><ProviderAvatarIcon provider={service.provider} /></span>
        <div>
          <h1 className="onboarding-title">{service.name} instellen</h1>
          <p className="onboarding-text">{info.description}</p>
        </div>
      </div>

      <ol className="onboarding-setup-list">
        {info.steps.map((item) => <li key={item}>{item}</li>)}
      </ol>

      {detection.executablePath && (
        <div>
          <div className="settings-row-label mb-2">Gedetecteerd CLI-pad</div>
          <div className="cli-path-display" title={detection.executablePath}>{detection.executablePath}</div>
        </div>
      )}

      {service.provider === 'google' && !ready && (
        <div className="onboarding-key-field">
          <label>
            <span><KeyRound size={14} /> Gemini API-sleutel</span>
            <input className="input" type="password" autoComplete="off" placeholder="AI..." value={geminiApiKey} onChange={(event) => onGeminiApiKeyChange(event.target.value)} />
          </label>
          <label>
            <span>Google Cloud-project-ID</span>
            <input className="input" placeholder="mijn-gemini-project" value={geminiProjectId} onChange={(event) => onGeminiProjectIdChange(event.target.value)} />
          </label>
          <label>
            <span>OAuth desktop-client-ID</span>
            <input className="input" placeholder="...apps.googleusercontent.com" value={geminiOauthClientId} onChange={(event) => onGeminiOauthClientIdChange(event.target.value)} />
          </label>
        </div>
      )}

      <div className={`onboarding-setup-status ${ready ? 'success' : state}`}>
        {working
          ? <Loader2 size={16} className="spin" />
          : ready
            ? <Check size={16} />
            : state === 'error'
              ? <X size={16} />
              : state === 'waiting'
                ? <Terminal size={16} />
                : <HelpCircle size={16} />}
        <span>{message || detection.detail || 'Nog niet ingesteld'}</span>
      </div>
      <SetupProgressBar progress={progress} ready={ready} />

      {!ready && (
        <div className="onboarding-setup-buttons">
          <button className="btn btn-primary" onClick={onAction} disabled={working || (service.provider === 'google' && (!geminiApiKey.trim() || !geminiProjectId.trim() || !geminiOauthClientId.trim()))}>
            {working ? <Loader2 size={15} className="spin" /> : info.icon}
            {working ? 'Bezig…' : info.action}
          </button>
          <button className="btn btn-secondary" onClick={onRecheck} disabled={working}>
            <RefreshCw size={14} /> Controleer opnieuw
          </button>
        </div>
      )}

      <div className="onboarding-actions">
        <button className="btn btn-secondary" onClick={onBack} disabled={working}>Terug</button>
        <button className="btn btn-primary" onClick={onNext} disabled={working}>
          {ready ? 'Volgende' : 'Later afronden'} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

function setupProgressTarget(
  provider: OnboardingServiceId,
): RuntimeSetupProgress['runtime'] | null {
  if (provider === 'anthropic') return 'claude';
  if (provider === 'codex' || provider === 'antigravity' || provider === 'ollama') return provider;
  return null;
}

function SetupProgressBar({
  progress,
  ready = false,
}: {
  progress: RuntimeSetupProgress | null;
  ready?: boolean;
}) {
  if (!showOnboardingSetupProgress(ready, progress)) {
    return null;
  }
  const activeProgress = progress!;
  const percent = typeof activeProgress.percent === 'number' && Number.isFinite(activeProgress.percent)
    ? Math.min(100, Math.max(0, Math.round(activeProgress.percent)))
    : null;
  return (
    <div className="onboarding-runtime-progress">
      <div
        className={`onboarding-runtime-progress-track ${percent === null ? 'indeterminate' : ''}`}
        role="progressbar"
        aria-label={activeProgress.status}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { 'aria-valuenow': percent })}
      >
        <div style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      <span>
        {activeProgress.phase === 'awaiting-login'
          ? 'Wacht op afronden van de login'
          : percent === null
            ? 'Voortgang wordt live gevolgd'
            : `${percent}%`}
      </span>
    </div>
  );
}

function setupInfo(provider: OnboardingServiceId, detection: OnboardingDetection) {
  switch (provider) {
    case 'openai':
      return {
        description: 'ChatGPT Subscription gebruikt een aparte beveiligde websessie in LLMelt; er is geen API-key nodig.',
        steps: ['Open het ChatGPT-loginvenster.', 'Log in en kies zo nodig je workspace.', 'Keer terug; de gids controleert de sessie automatisch.'],
        action: 'Open ChatGPT-login',
        icon: <ExternalLink size={15} />,
      };
    case 'codex':
      return cliSetupInfo('Codex CLI', detection, 'ChatGPT', 'Installeer Codex CLI', 'Open Codex-login');
    case 'anthropic':
      return cliSetupInfo('Claude Code CLI', detection, 'Claude', 'Installeer Claude CLI', 'Open Claude-login');
    case 'antigravity':
      return cliSetupInfo('Antigravity CLI', detection, 'Google', 'Installeer Antigravity', 'Open Antigravity-login');
    case 'google':
      return {
        description: 'Gemini gebruikt de Developer API. De API-key en read-only Google Cloud-quota moeten verplicht aan hetzelfde project zijn gekoppeld.',
        steps: ['Maak een API-sleutel in Google AI Studio.', 'Activeer API Keys API, Cloud Resource Manager API, Service Usage API en Cloud Monitoring API in hetzelfde Cloud-project.', 'Maak in dat project een OAuth desktop-client.', 'LLMelt valideert alles en leest daarna alleen project-, quota- en verbruiksgegevens.'],
        action: 'Valideer en koppel Google Cloud',
        icon: <KeyRound size={15} />,
      };
    case 'ollama':
      return {
        description: 'Ollama draait volledig lokaal en moet als lokale server actief zijn.',
        steps: ['Start na jouw klik de officiële Windows-installatie.', 'Start de lokale Ollama-server.', 'Download bij een lege installatie het lichte basismodel en controleer de live catalogus.'],
        action: 'Installeer en controleer Ollama',
        icon: <Terminal size={15} />,
      };
  }
}

function cliSetupInfo(name: string, detection: OnboardingDetection, account: string, installLabel: string, openLabel: string) {
  return {
    description: `${name} gebruikt je ${account}-account rechtstreeks; LLMelt bewaart het accountwachtwoord niet.`,
    steps: [
      detection.state === 'found' ? 'De CLI is al gevonden.' : 'Start de officiële Windows-installer.',
      `Rond de ${account}-login af in het zichtbare terminal- of browservenster.`,
      'Keer terug; de gids controleert installatie en login automatisch.',
    ],
    action: detection.state === 'found' ? openLabel : installLabel,
    icon: <Terminal size={15} />,
  };
}

function BulkServiceAnswers({
  onSelectAll,
  onDeselectAll,
}: {
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  return (
    <div className="onboarding-bulk-actions" role="group" aria-label="Alle diensten kiezen">
      <button type="button" className="btn btn-secondary onboarding-yesall" onClick={onSelectAll}>
        <Check size={15} /> Alles selecteren
      </button>
      <button type="button" className="btn btn-secondary onboarding-yesall" onClick={onDeselectAll}>
        <X size={15} /> Alles deselecteren
      </button>
    </div>
  );
}

function ServiceRow({
  service,
  detection,
  answer,
  options,
  onAnswer,
}: {
  service: OnboardingService;
  detection?: OnboardingDetection;
  answer?: ServiceAnswer;
  options: ServiceAnswer[];
  onAnswer: (answer: ServiceAnswer) => void;
}) {
  const labels: Record<ServiceAnswer, string> = { yes: 'Ja', maybe: 'Later', no: 'Nee' };
  const icons: Record<ServiceAnswer, React.ReactNode> = {
    yes: <Check size={14} />,
    maybe: <HelpCircle size={14} />,
    no: <X size={14} />,
  };

  return (
    <div className="onboarding-service">
      <span className={`onboarding-logo-chip small ${service.provider}`}>
        <ProviderAvatarIcon provider={service.provider} />
      </span>
      <div className="onboarding-service-text">
        <div className="onboarding-service-name">
          {service.name}
          {detection?.source && <span className={`onboarding-source ${detection.source}`}>{detection.source}</span>}
        </div>
        <div className="onboarding-service-detail">
          {detection?.state === 'unknown' ? 'kon niet controleren' : (detection?.detail || service.looksAt)}
        </div>
      </div>
      <div className="onboarding-choices">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`onboarding-choice ${option} ${answer === option ? 'selected' : ''}`}
            onClick={() => onAnswer(option)}
          >
            {icons[option]} {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

export default OnboardingGuide;
