import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
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
  AIModel,
  ChatgptVersion,
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
  const { t, i18n } = useTranslation();
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
        setSetupMessage(localizedRuntimeProgress(progress, i18n.resolvedLanguage));
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
        setPythonMessage(localizedRuntimeProgress(progress, i18n.resolvedLanguage));
        setPythonState(progress.phase === 'ready' ? 'success' : progress.phase === 'error' ? 'error' : 'working');
      }
    });
  }, [currentSetup, i18n.resolvedLanguage]);

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
    setPythonMessage(t('onboarding.status.pythonChecking'));
    try {
      const status = await window.electronAPI?.runtime?.getStatus('python');
      if (cancelled.current || !status) return;
      setPythonStatus(status);
      setPythonState(status.ready ? 'success' : 'idle');
      setPythonMessage(localizedRuntimeDetail(status, i18n.resolvedLanguage));
    } catch (error) {
      if (cancelled.current) return;
      setPythonState('error');
      setPythonMessage(localizedSetupError(error, t, i18n.resolvedLanguage));
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
        const loginSnapshot = result as typeof result & {
          models?: AIModel[];
          versions?: ChatgptVersion[];
          sessionStatus?: { active?: boolean };
        };
        const providerStore = useProviderStore.getState();
        if (Array.isArray(loginSnapshot.models)) providerStore.setProviderModels('openai', loginSnapshot.models);
        if (Array.isArray(loginSnapshot.versions)) providerStore.setChatgptVersions(loginSnapshot.versions);
        if (typeof loginSnapshot.sessionStatus?.active === 'boolean') {
          providerStore.setChatgptSessionActive(loginSnapshot.sessionStatus.active);
        }
        setSetupMessage(t('onboarding.status.chatgptLogin'));
      } else if (provider === 'codex') {
        result = await window.electronAPI.auth.codexCliLogin();
        setSetupMessage(t('onboarding.status.codexLogin'));
      } else if (provider === 'anthropic') {
        result = await window.electronAPI.auth.claudeCliLogin();
        setSetupMessage(t('onboarding.status.claudeLogin'));
      } else if (provider === 'antigravity') {
        result = await window.electronAPI.auth.antigravityCliLogin();
        setSetupMessage(t('onboarding.status.antigravityLogin'));
      } else if (provider === 'google') {
        if (!geminiApiKey.trim()) throw new Error(t('onboarding.status.geminiKeyMissing'));
        if (!geminiProjectId.trim() || !geminiOauthClientId.trim()) throw new Error(t('onboarding.status.geminiProjectMissing'));
        const validation = await window.electronAPI.auth.saveCredential('google', geminiApiKey.trim(), 'apikey');
        if (validation.status !== 'valid') throw new Error(validation.error || t('onboarding.status.geminiKeyInvalid'));
        await window.electronAPI.geminiQuota.configure(geminiProjectId.trim(), geminiOauthClientId.trim());
        const quotaStatus = await window.electronAPI.geminiQuota.connect();
        if (!quotaStatus.connected) throw new Error(quotaStatus.error || t('onboarding.status.geminiQuotaFailed'));
        setGeminiApiKey('');
        result = { success: true, message: t('onboarding.status.geminiConnected') };
        setSetupMessage(t('onboarding.status.geminiConnected'));
      } else {
        const status = await window.electronAPI.runtime.install('ollama');
        result = {
          success: status.ready,
          error: status.ready ? undefined : status.detail,
          message: status.detail,
        };
        setSetupMessage(localizedRuntimeDetail(status, i18n.resolvedLanguage));
      }

      if (result && result.success === false) throw new Error(result.error || t('onboarding.status.setupStartFailed'));
      if (provider === 'codex' || provider === 'anthropic' || provider === 'antigravity') {
        setSetupState('waiting');
      }
      const ready = await waitUntilReady(provider, runId);
      if (cancelled.current || setupActionRun.current !== runId) return;
      if (ready) {
        setSetupState('success');
        setSetupMessage(t('onboarding.status.providerReady', { provider: currentSetup.name }));
      } else {
        setSetupState(
          provider === 'codex' || provider === 'anthropic' || provider === 'antigravity'
            ? 'waiting'
            : 'idle',
        );
        setSetupMessage(t('onboarding.status.setupIncomplete'));
      }
    } catch (error) {
      if (cancelled.current) return;
      setSetupState('error');
      setSetupMessage(localizedSetupError(error, t, i18n.resolvedLanguage));
    }
  };

  const recheckCurrent = async () => {
    if (!currentSetup) return;
    setupActionRun.current += 1;
    setSetupState('working');
    setSetupMessage(t('onboarding.status.checking'));
    if (currentSetup.provider !== 'openai') {
      await window.electronAPI?.auth.testCredential(currentSetup.provider).catch(() => null);
    }
    await refreshProviderState(currentSetup.provider);
    const ready = detectOnboardingService(currentSetup.provider, useProviderStore.getState()).ready;
    setSetupState(ready ? 'success' : 'idle');
    setSetupMessage(ready
      ? t('onboarding.status.providerReady', { provider: currentSetup.name })
      : t('onboarding.status.notReady'));
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
    setPythonMessage(t('onboarding.status.pythonInstalling'));
    setPythonProgress(null);
    try {
      const status = await window.electronAPI.runtime.install('python');
      if (cancelled.current) return;
      setPythonStatus(status);
      setPythonState(status.ready ? 'success' : 'error');
      setPythonMessage(localizedRuntimeDetail(status, i18n.resolvedLanguage));
    } catch (error) {
      if (cancelled.current) return;
      setPythonState('error');
      setPythonMessage(localizedSetupError(error, t, i18n.resolvedLanguage));
    }
  };

  const scanned = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state !== 'unknown').length;
  const foundServices = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state === 'found');
  const missingServices = ONBOARDING_SERVICES.filter((service) => detected[service.provider].state !== 'found');

  return (
    <div className={`onboarding-screen ${step === 'done' ? 'leaving' : ''}`}>
      <button className="onboarding-close btn-icon" onClick={onClose} title={t('onboarding.skip')} aria-label={t('onboarding.skip')}>
        <X size={18} />
      </button>

      <div className="onboarding-content">
        {step === 'welcome' && (
          <div key="welcome" className="onboarding-step onboarding-center">
            <img className="onboarding-logo" src="./icon.png" alt="" />
            <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
            <p className="onboarding-text">{t('onboarding.welcome.text')}</p>
            <button className="btn btn-primary onboarding-next" onClick={() => setStep('what')}>
              {t('onboarding.welcome.start')} <ArrowRight size={16} />
            </button>
          </div>
        )}

        {step === 'what' && (
          <div key="what" className="onboarding-step onboarding-center">
            <h1 className="onboarding-title">{t('onboarding.intro.title')}</h1>
            <p className="onboarding-text">{t('onboarding.intro.text')}</p>
            <div className="onboarding-logos">
              {ONBOARDING_SERVICES.map((service) => (
                <span key={service.provider} className={`onboarding-logo-chip ${service.provider}`} title={service.name}>
                  <ProviderAvatarIcon provider={service.provider} />
                </span>
              ))}
            </div>
            <button className="btn btn-primary onboarding-next" onClick={() => setStep('scanning')}>
              {t('onboarding.intro.check')} <ArrowRight size={16} />
            </button>
          </div>
        )}

        {step === 'scanning' && (
          <div key="scanning" className="onboarding-step onboarding-center">
            <Loader2 size={30} className="spin onboarding-spinner" />
            <h1 className="onboarding-title">{t('onboarding.scanning.title')}</h1>
            <p className="onboarding-text">{t('onboarding.scanning.text')}</p>
            <div className="onboarding-scanlist">
              {ONBOARDING_SERVICES.map((service) => {
                const hit = detected[service.provider];
                return (
                  <div key={service.provider} className={`onboarding-scanrow ${hit.state}`}>
                    <span className={`onboarding-logo-chip small ${service.provider}`}><ProviderAvatarIcon provider={service.provider} /></span>
                    <span className="onboarding-scanname">{service.name}</span>
                    <span className="onboarding-scandetail">
                      {localizedDetectionDetail(service, hit, t, i18n.resolvedLanguage)}
                    </span>
                    <span className="onboarding-scanstate">
                      {hit.state === 'unknown'
                        ? <Loader2 size={13} className="spin" />
                        : hit.state === 'found' ? <Check size={15} /> : <X size={15} />}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="onboarding-progress">{t('onboarding.scanning.progress', { scanned, total: ONBOARDING_SERVICES.length })}</p>
          </div>
        )}

        {step === 'confirm' && (
          <div key="confirm" className="onboarding-step">
            <h1 className="onboarding-title">{t('onboarding.confirm.title')}</h1>
            <p className="onboarding-text">{t('onboarding.confirm.text')}</p>
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
                : <p className="onboarding-text">{t('onboarding.confirm.none')}</p>}
            </div>
            <div className="onboarding-actions">
              <button className="btn btn-primary" onClick={() => setStep('missing')}>
                {t('onboarding.next')} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'missing' && (
          <div key="missing" className="onboarding-step">
            <h1 className="onboarding-title">{t('onboarding.missing.title')}</h1>
            <p className="onboarding-text">{t('onboarding.missing.text')}</p>
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
                : <p className="onboarding-text">{t('onboarding.missing.allFound')}</p>}
            </div>
            <div className="onboarding-actions">
              <button className="btn btn-secondary" onClick={() => setStep('confirm')}>{t('onboarding.back')}</button>
              <button className="btn btn-primary" onClick={beginSetup}>
                {t('onboarding.setupWithMe')} <ArrowRight size={16} />
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
            message={currentDetection.ready
              ? t('onboarding.status.providerAlreadyReady', { provider: currentSetup.name })
              : setupMessage}
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
              {t('onboarding.step', { current: selectedServices.length + 1, total: selectedServices.length + 1 })}
            </div>
            <div className="onboarding-setup-heading">
              <span className="onboarding-logo-chip python"><FileCode2 size={22} /></span>
              <div>
                <h1 className="onboarding-title">{t('onboarding.python.title')}</h1>
                <p className="onboarding-text">{t('onboarding.python.description')}</p>
              </div>
            </div>

            <ol className="onboarding-setup-list">
              <li>{t('onboarding.python.steps.validate')}</li>
              <li>{t('onboarding.python.steps.install')}</li>
              <li>{t('onboarding.python.steps.save')}</li>
            </ol>

            {pythonStatus?.executablePath && (
              <div>
                <div className="settings-row-label mb-2">{t('onboarding.python.detectedPath')}</div>
                <div className="cli-path-display" title={pythonStatus.executablePath}>{pythonStatus.executablePath}</div>
              </div>
            )}

            <div className={`onboarding-setup-status ${pythonStatus?.ready ? 'success' : pythonState}`}>
              {pythonState === 'working'
                ? <Loader2 size={16} className="spin" />
                : pythonStatus?.ready ? <Check size={16} /> : pythonState === 'error' ? <X size={16} /> : <HelpCircle size={16} />}
              <span>{pythonMessage || pythonStatus?.detail || t('onboarding.python.notChecked')}</span>
            </div>
            <SetupProgressBar progress={pythonProgress} />

            {!pythonStatus?.ready && (
              <div className="onboarding-setup-buttons">
                <button className="btn btn-primary" onClick={installPython} disabled={pythonState === 'working'}>
                  {pythonState === 'working' ? <Loader2 size={15} className="spin" /> : <FileCode2 size={15} />}
                  {pythonState === 'working' ? t('onboarding.working') : t('onboarding.python.installOfficial')}
                </button>
                <button className="btn btn-secondary" onClick={() => void openRuntimeStep()} disabled={pythonState === 'working'}>
                  <RefreshCw size={14} /> {t('onboarding.recheck')}
                </button>
              </div>
            )}

            <div className="onboarding-actions">
              <button className="btn btn-secondary" onClick={() => setStep(selectedServices.length ? 'setup' : 'missing')} disabled={pythonState === 'working'}>
                {t('onboarding.back')}
              </button>
              <button className="btn btn-primary" onClick={() => void finish()} disabled={pythonState === 'working'}>
                {pythonStatus?.ready ? t('onboarding.finish') : t('onboarding.python.continueWithout')} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'ready' && (
          <div key="ready" className="onboarding-step onboarding-center">
            <Loader2 size={30} className="spin onboarding-spinner" />
            <h1 className="onboarding-title">{t('onboarding.saving')}</h1>
          </div>
        )}

        {step === 'done' && (
          <div key="done" className="onboarding-step onboarding-center">
            <Sparkles size={36} className="onboarding-sparkle" />
            <h1 className="onboarding-title">{t('onboarding.done.title')}</h1>
            <p className="onboarding-text">{t('onboarding.done.text')}</p>
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
  const { t, i18n } = useTranslation();
  const working = state === 'working';
  const ready = detection.ready || state === 'success';
  const info = setupInfo(service.provider, detection, t);

  return (
    <div className="onboarding-step">
      <div className="onboarding-setup-progress">{t('onboarding.step', { current: index + 1, total })}</div>
      <div className="onboarding-setup-heading">
        <span className={`onboarding-logo-chip ${service.provider}`}><ProviderAvatarIcon provider={service.provider} /></span>
        <div>
          <h1 className="onboarding-title">{t('onboarding.setup.providerTitle', { provider: service.name })}</h1>
          <p className="onboarding-text">{info.description}</p>
        </div>
      </div>

      <ol className="onboarding-setup-list">
        {info.steps.map((item) => <li key={item}>{item}</li>)}
      </ol>

      {detection.executablePath && (
        <div>
          <div className="settings-row-label mb-2">{t('onboarding.setup.detectedCliPath')}</div>
          <div className="cli-path-display" title={detection.executablePath}>{detection.executablePath}</div>
        </div>
      )}

      {service.provider === 'google' && !ready && (
        <div className="onboarding-key-field">
          <label>
            <span><KeyRound size={14} /> {t('onboarding.setup.geminiApiKey')}</span>
            <input className="input" type="password" autoComplete="off" placeholder="AI..." value={geminiApiKey} onChange={(event) => onGeminiApiKeyChange(event.target.value)} />
          </label>
          <label>
            <span>{t('onboarding.setup.googleProjectId')}</span>
            <input className="input" placeholder="mijn-gemini-project" value={geminiProjectId} onChange={(event) => onGeminiProjectIdChange(event.target.value)} />
          </label>
          <label>
            <span>{t('onboarding.setup.oauthClientId')}</span>
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
        <span>{message || localizedDetectionDetail(service, detection, t, i18n.resolvedLanguage)}</span>
      </div>
      <SetupProgressBar progress={progress} ready={ready} />

      {!ready && (
        <div className="onboarding-setup-buttons">
          <button className="btn btn-primary" onClick={onAction} disabled={working || (service.provider === 'google' && (!geminiApiKey.trim() || !geminiProjectId.trim() || !geminiOauthClientId.trim()))}>
            {working ? <Loader2 size={15} className="spin" /> : info.icon}
            {working ? t('onboarding.working') : info.action}
          </button>
          <button className="btn btn-secondary" onClick={onRecheck} disabled={working}>
            <RefreshCw size={14} /> {t('onboarding.recheck')}
          </button>
        </div>
      )}

      <div className="onboarding-actions">
        <button className="btn btn-secondary" onClick={onBack} disabled={working}>{t('onboarding.back')}</button>
        <button className="btn btn-primary" onClick={onNext} disabled={working}>
          {ready ? t('onboarding.next') : t('onboarding.finishLater')} <ArrowRight size={16} />
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
  const { t } = useTranslation();
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
          ? t('onboarding.progress.awaitingLogin')
          : percent === null
            ? t('onboarding.progress.live')
            : `${percent}%`}
      </span>
    </div>
  );
}

function setupInfo(provider: OnboardingServiceId, detection: OnboardingDetection, t: TFunction) {
  switch (provider) {
    case 'openai':
      return {
        description: t('onboarding.providers.openai.description'),
        steps: [
          t('onboarding.providers.openai.steps.open'),
          t('onboarding.providers.openai.steps.login'),
          t('onboarding.providers.openai.steps.return'),
        ],
        action: t('onboarding.providers.openai.action'),
        icon: <ExternalLink size={15} />,
      };
    case 'codex':
      return cliSetupInfo('Codex CLI', detection, 'ChatGPT', t('onboarding.providers.codex.install'), t('onboarding.providers.codex.open'), t);
    case 'anthropic':
      return cliSetupInfo('Claude Code CLI', detection, 'Claude', t('onboarding.providers.claude.install'), t('onboarding.providers.claude.open'), t);
    case 'antigravity':
      return cliSetupInfo('Antigravity CLI', detection, 'Google', t('onboarding.providers.antigravity.install'), t('onboarding.providers.antigravity.open'), t);
    case 'google':
      return {
        description: t('onboarding.providers.google.description'),
        steps: [
          t('onboarding.providers.google.steps.key'),
          t('onboarding.providers.google.steps.apis'),
          t('onboarding.providers.google.steps.oauth'),
          t('onboarding.providers.google.steps.validate'),
        ],
        action: t('onboarding.providers.google.action'),
        icon: <KeyRound size={15} />,
      };
    case 'ollama':
      return {
        description: t('onboarding.providers.ollama.description'),
        steps: [
          t('onboarding.providers.ollama.steps.install'),
          t('onboarding.providers.ollama.steps.start'),
          t('onboarding.providers.ollama.steps.model'),
        ],
        action: t('onboarding.providers.ollama.action'),
        icon: <Terminal size={15} />,
      };
  }
}

function cliSetupInfo(
  name: string,
  detection: OnboardingDetection,
  account: string,
  installLabel: string,
  openLabel: string,
  t: TFunction,
) {
  return {
    description: t('onboarding.providers.cli.description', { name, account }),
    steps: [
      detection.state === 'found'
        ? t('onboarding.providers.cli.steps.found')
        : t('onboarding.providers.cli.steps.install'),
      t('onboarding.providers.cli.steps.login', { account }),
      t('onboarding.providers.cli.steps.return'),
    ],
    action: detection.state === 'found' ? openLabel : installLabel,
    icon: <Terminal size={15} />,
  };
}

function localizedDetectionDetail(
  service: OnboardingService,
  detection: OnboardingDetection | undefined,
  t: TFunction,
  language?: string,
) {
  if (!detection) return t(`onboarding.looksAt.${service.provider}`);
  if (language?.startsWith('nl') && detection.detail) return detection.detail;
  if (detection.state === 'unknown') return t('onboarding.detection.checking');
  if (detection.state === 'absent') {
    return t('onboarding.detection.notFound', { provider: service.name });
  }
  if (detection.ready) return t('onboarding.detection.ready', { provider: service.name });
  return t('onboarding.detection.foundNeedsSetup', { provider: service.name });
}

function localizedRuntimeProgress(progress: RuntimeSetupProgress, language?: string) {
  if (language?.startsWith('nl')) return progress.status;
  const runtime = runtimeDisplayName(progress.runtime);
  switch (progress.phase) {
    case 'checking': return `Checking ${runtime}…`;
    case 'downloading': return `Downloading ${runtime}…`;
    case 'installing': return `Installing ${runtime}…`;
    case 'configuring': return `Configuring ${runtime}…`;
    case 'awaiting-login': return `Waiting for the ${runtime} login to be completed…`;
    case 'starting': return `Starting ${runtime}…`;
    case 'pulling-model': return 'Downloading the required Ollama model…';
    case 'ready': return `${runtime} is ready to use.`;
    case 'cancelled': return `${runtime} setup was cancelled.`;
    case 'error': return `${runtime} setup failed. Check the installer or login window and try again.`;
    default: return `Working on ${runtime}…`;
  }
}

function localizedRuntimeDetail(status: RuntimeStatus, language?: string) {
  if (language?.startsWith('nl')) return status.detail;
  const runtime = runtimeDisplayName(status.runtime);
  if (status.ready) {
    const suffix = status.model ? ` with ${status.model}` : status.version ? ` (${status.version})` : '';
    return `${runtime} is ready to use${suffix}.`;
  }
  return `${runtime} is not ready yet. Complete the installation and try again.`;
}

function localizedSetupError(error: unknown, t: TFunction, language?: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (language?.startsWith('nl')) return message;
  const technical = [...new Set(message.match(/\b(?:HTTP\s*)?\d{3}\b|\b[A-Z][A-Z0-9_]{3,}\b/g) || [])]
    .slice(0, 3)
    .join(', ');
  const generic = t('onboarding.status.setupStartFailed');
  return technical ? `${generic} (${technical})` : generic;
}

function runtimeDisplayName(runtime: RuntimeSetupProgress['runtime'] | RuntimeStatus['runtime']) {
  if (runtime === 'python') return 'Python';
  if (runtime === 'ollama') return 'Ollama';
  if (runtime === 'claude') return 'Claude CLI';
  if (runtime === 'codex') return 'Codex CLI';
  return 'Antigravity CLI';
}

function BulkServiceAnswers({
  onSelectAll,
  onDeselectAll,
}: {
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="onboarding-bulk-actions" role="group" aria-label={t('onboarding.bulk.aria')}>
      <button type="button" className="btn btn-secondary onboarding-yesall" onClick={onSelectAll}>
        <Check size={15} /> {t('onboarding.bulk.selectAll')}
      </button>
      <button type="button" className="btn btn-secondary onboarding-yesall" onClick={onDeselectAll}>
        <X size={15} /> {t('onboarding.bulk.deselectAll')}
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
  const { t, i18n } = useTranslation();
  const labels: Record<ServiceAnswer, string> = {
    yes: t('onboarding.answers.yes'),
    maybe: t('onboarding.answers.later'),
    no: t('onboarding.answers.no'),
  };
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
          {detection?.source && (
            <span className={`onboarding-source ${detection.source}`}>
              {t(`onboarding.sources.${detection.source}`)}
            </span>
          )}
        </div>
        <div className="onboarding-service-detail">
          {localizedDetectionDetail(service, detection, t, i18n.resolvedLanguage)}
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
