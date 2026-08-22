import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, KeyRound, Loader2, ShieldCheck, UploadCloud } from 'lucide-react';
import type { ProviderType, ValidationResult } from '../providers/types';

interface KeyResult extends ValidationResult {
  key: string;
}

const ApiKeyChecker: React.FC = () => {
  const { t } = useTranslation();
  const [results, setResults] = useState<KeyResult[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [manualText, setManualText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.keys.onValidationResult((result) => {
      setResults((prev) => {
        const index = prev.findIndex((item) => item.keyMasked === result.keyMasked && item.provider === result.provider && item.status === 'checking');
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = { ...next[index], ...result };
        return next;
      });
    });
  }, []);

  const validateKeys = async (keys: string[]) => {
    const unique = Array.from(new Set(keys));
    if (!unique.length) return;

    const initial: KeyResult[] = unique.map((key) => ({
      id: crypto.randomUUID(),
      key,
      keyMasked: maskKey(key),
      provider: detectProvider(key),
      status: 'checking',
    }));

    setResults(initial);
    setIsValidating(true);

    if (window.electronAPI) {
      const finalResults = await window.electronAPI.keys.validateBatch(
        unique.map((key) => ({ key, provider: detectProvider(key) as ProviderType })),
      );
      setResults((prev) =>
        prev.map((item) => {
          const match = finalResults.find((result: ValidationResult) => result.keyMasked === item.keyMasked && result.provider === item.provider);
          return match ? { ...item, ...match } : item;
        }),
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 600));
      setResults((prev) => prev.map((item) => ({ ...item, status: item.provider === 'unknown' ? 'invalid' : 'valid' })));
    }

    setIsValidating(false);
  };

  const handleFile = async (file: File) => {
    const content = await file.text();
    await validateKeys(parseKeys(content, file.name));
  };

  const handleManualValidate = async () => {
    await validateKeys(parseKeys(manualText, 'manual.txt'));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleUseKey = async (result: KeyResult) => {
    if (!window.electronAPI || result.provider === 'unknown') return;
    await window.electronAPI.auth.saveCredential(result.provider as ProviderType, result.key, 'apikey');
  };

  const exportValidKeys = () => {
    const validKeys = results.filter((result) => result.status === 'valid').map((result) => result.key);
    const blob = new Blob([JSON.stringify(validKeys, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'valid_api_keys.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="settings-page api-key-checker-page">
      <div className="api-key-checker-inner">
        <header className="api-key-checker-header">
          <div className="api-key-checker-title-icon"><KeyRound size={22} /></div>
          <div className="api-key-checker-heading">
            <h2>{t('keyChecker.title')}</h2>
            <p>{t('keyChecker.description')}</p>
          </div>
          <span className="api-key-security-badge"><ShieldCheck size={14} /> {t('keyChecker.masked')}</span>
        </header>

        <div className="api-key-input-grid">
          <section className="glass-card api-key-input-card">
            <div className="api-key-card-heading">
              <span className="api-key-card-icon"><ClipboardPaste size={18} /></span>
              <div>
                <h3>{t('keyChecker.pasteLabel')}</h3>
                <p>{t('keyChecker.pasteDescription')}</p>
              </div>
            </div>
            <textarea
              className="textarea api-key-textarea"
              rows={6}
              value={manualText}
              onChange={(event) => setManualText(event.target.value)}
              placeholder={t('keyChecker.pastePlaceholder')}
            />
            <div className="api-key-card-actions">
              <span>{t('keyChecker.supportedProviders')}</span>
              <button className="btn btn-primary" onClick={handleManualValidate} disabled={isValidating || !parseKeys(manualText, 'manual.txt').length}>
                {isValidating && <Loader2 size={15} className="spinner" />}
                {isValidating ? t('keyChecker.validating') : t('keyChecker.testPasted')}
              </button>
            </div>
          </section>

          <button
            type="button"
            className={`file-drop-zone api-key-upload-card ${dragActive ? 'active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="api-key-upload-icon"><UploadCloud size={25} /></span>
            <strong>{t('keyChecker.upload')}</strong>
            <span>{t('keyChecker.uploadDescription')}</span>
            <span className="api-key-file-types"><span>JSON</span><span>TXT</span><span>ENV</span></span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.txt,.env"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) handleFile(file);
            }}
            style={{ display: 'none' }}
          />
        </div>

        <div className="api-key-smoke-test-note">
          <ShieldCheck size={16} />
          <span>{t('keyChecker.smokeTestHelp')}</span>
        </div>

        {results.length > 0 && (
          <section className="key-checker-results">
            <div className="api-key-results-header">
            <span className="font-semibold text-sm">
              {results.filter((result) => result.status === 'valid').length}/{results.length} {t('keyChecker.valid')}
              {results.some((result) => result.status === 'limited') &&
                <>{' · '}{t('keyChecker.limitedCount', { count: results.filter((result) => result.status === 'limited').length })}</>}
            </span>
            <button className="btn btn-secondary" onClick={exportValidKeys} disabled={!results.some((result) => result.status === 'valid')}>
              {t('keyChecker.exportValid')}
            </button>
          </div>

          <div className="glass-card api-key-results-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('keyChecker.key')}</th>
                  <th>{t('keyChecker.provider')}</th>
                  <th>{t('keyChecker.status')}</th>
                  <th>{t('keyChecker.models')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.id}>
                    <td>
                      <span className="key-masked">{result.keyMasked}</span>
                    </td>
                    <td>{result.provider}</td>
                    <td>
                      {result.status === 'checking' || isValidating ? (
                        <span className="text-muted">{t('keyChecker.validating')}</span>
                      ) : (
                        <span className={`status-badge ${statusBadgeClass(result.status)}`}>
                          {statusLabel(result.status, t)}
                        </span>
                      )}
                    </td>
                    <td className="text-xs text-muted">
                      {result.error && (
                        <div style={{ color: result.status === 'limited' ? 'var(--color-warning)' : 'var(--color-error)' }}>{result.error}</div>
                      )}
                      {result.checkedModel && (
                        <div style={{ color: 'var(--text-primary)' }}>{t('keyChecker.testedModel', { model: result.checkedModel })}</div>
                      )}
                      {result.details && <div>{result.details}</div>}
                      <div>{result.models?.join(', ') || '-'}</div>
                    </td>
                    <td>
                      {(result.status === 'valid' || result.status === 'limited') && result.provider !== 'unknown' && (
                        <button className="btn btn-ghost text-xs" onClick={() => handleUseKey(result)}>
                          {t('keyChecker.useThis')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </section>
        )}
      </div>
    </div>
  );
};

function parseKeys(content: string, filename: string) {
  const candidates: string[] = [];
  if (filename.endsWith('.json')) {
    try {
      collectJsonValues(JSON.parse(content), candidates);
    } catch {
      candidates.push(...content.split(/\r?\n/));
    }
  } else {
    candidates.push(...content.split(/\r?\n/));
  }

  return candidates
    .flatMap((line) => line.split(/[,\s]+/))
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter((value) => /^(sk-ant-|sk-|AI)/.test(value));
}

function collectJsonValues(value: any, output: string[]) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectJsonValues(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectJsonValues(item, output));
}

function statusLabel(status: KeyResult['status'], t: (key: string) => string) {
  if (status === 'valid') return t('keyChecker.valid');
  if (status === 'limited') return t('keyChecker.limited');
  if (status === 'expired') return t('keyChecker.expired');
  return t('keyChecker.invalid');
}

function statusBadgeClass(status: KeyResult['status']) {
  if (status === 'valid') return 'online';
  if (status === 'limited') return 'limited';
  return 'offline';
}

function detectProvider(key: string): ProviderType | 'unknown' {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  if (key.startsWith('AI')) return 'google';
  return 'unknown';
}

function maskKey(key: string) {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export default ApiKeyChecker;
