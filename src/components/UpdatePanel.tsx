import React, { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UpdateStatus } from '../update-status'
import { updateProgressDetails, updateStatusLabel } from '../update-status'

type BusyAction = 'check' | 'install' | null
type UpdaterResult = {
  ok?: boolean
  error?: string
  reason?: 'installed-only' | 'no-failed-download' | 'download-first'
}

const UpdatePanel: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [currentVersion, setCurrentVersion] = useState('')
  const [supported, setSupported] = useState(true)
  const [busyAction, setBusyAction] = useState<BusyAction>(null)

  useEffect(() => {
    window.electronAPI?.updater?.getStatus?.()
      .then((result) => {
        if (result?.status) setStatus(result.status as UpdateStatus)
        setCurrentVersion(result?.currentVersion || '')
        setSupported(Boolean(result?.supported))
      })
      .catch(() => {})
    const off = window.electronAPI?.updater?.onStatus?.((next) => {
      setStatus(next as UpdateStatus)
      if (next?.state !== 'checking' && next?.state !== 'downloading') setBusyAction(null)
    })
    return () => { off?.() }
  }, [])

  const run = async (
    action: Exclude<BusyAction, null>,
    request: () => Promise<UpdaterResult | undefined>,
  ) => {
    setBusyAction(action)
    try {
      const result = await request()
      if (result && !result.ok) {
        const localizedError = result.reason
          ? t(`updates.errors.${result.reason}`)
          : result.error || t('updates.unknownError')
        setStatus({ state: 'error', error: localizedError })
      }
    } catch (error) {
      setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyAction(null)
    }
  }

  const check = () => run('check', () => window.electronAPI?.updater?.check?.())
  const install = () => run('install', () => window.electronAPI?.updater?.install?.())
  const locale = i18n.resolvedLanguage?.startsWith('nl') ? 'nl-NL' : 'en-US'
  const progressDetails = updateProgressDetails(status, locale, t('updates.of'))
  const isDownloading = status.state === 'downloading'
  const isInstalling = status.state === 'installing'

  const tone = status.state === 'error'
    ? 'var(--color-error)'
    : status.state === 'available' || status.state === 'downloaded'
      ? 'var(--color-warning)'
      : 'var(--text-secondary)'

  return (
    <div className="glass-card">
      <div className="flex items-center gap-2 mb-2">
        <RefreshCw size={18} />
        <span className="font-semibold">{t('updates.title')}</span>
        <div style={{ flex: 1 }} />
        <span className="text-xs text-muted">v{currentVersion || '—'}</span>
      </div>

      {!supported ? (
        <div className="text-sm text-muted">{t('updates.installedOnly')}</div>
      ) : (
        <>
          <div className="text-sm mb-3" style={{ color: tone }}>
            {updateStatusLabel(status, currentVersion, (key, options) => t(key, options))}
          </div>

          {isDownloading && (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <div
                role="progressbar"
                aria-label={t('updates.progressAria')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status.percent}
                style={{
                  height: 7,
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${status.percent}%`,
                    height: '100%',
                    background: 'var(--accent-cyan)',
                    transition: 'width var(--transition-fast)',
                  }}
                />
              </div>
              <div className="text-xs text-muted" style={{ marginTop: 'var(--space-2)' }}>
                {progressDetails || t('updates.preparing')}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              className="btn btn-secondary"
              onClick={check}
              disabled={busyAction !== null || isDownloading || isInstalling}
            >
              <RefreshCw size={15} className={busyAction === 'check' ? 'spin' : undefined} />
              {busyAction === 'check'
                ? t('updates.searching')
                : status.state === 'error'
                  ? t('updates.retry')
                  : t('updates.check')}
            </button>
            {status.state === 'downloaded' && (
              <button
                className="btn btn-primary"
                onClick={install}
                disabled={busyAction !== null}
              >
                <RotateCcw size={15} />
                {busyAction === 'install' ? t('updates.installing') : t('updates.installRestart')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default UpdatePanel
