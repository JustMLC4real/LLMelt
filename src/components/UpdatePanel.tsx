import React, { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import type { UpdateStatus } from '../update-status'
import { updateProgressDetails, updateStatusLabel } from '../update-status'

type BusyAction = 'check' | 'install' | null
type UpdaterResult = { ok?: boolean; error?: string }

const UpdatePanel: React.FC = () => {
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
        setStatus({ state: 'error', error: result.error || 'Onbekende updatefout.' })
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
  const progressDetails = updateProgressDetails(status)
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
        <span className="font-semibold">App-updates</span>
        <div style={{ flex: 1 }} />
        <span className="text-xs text-muted">v{currentVersion || '—'}</span>
      </div>

      {!supported ? (
        <div className="text-sm text-muted">Updates werken alleen in de geïnstalleerde app (niet in dev-modus).</div>
      ) : (
        <>
          <div className="text-sm mb-3" style={{ color: tone }}>
            {updateStatusLabel(status, currentVersion)}
          </div>

          {isDownloading && (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <div
                role="progressbar"
                aria-label="Downloadvoortgang van app-update"
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
                {progressDetails || 'Download voorbereiden…'}
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
              {busyAction === 'check' ? 'Zoeken…' : status.state === 'error' ? 'Opnieuw proberen' : 'Zoek naar updates'}
            </button>
            {status.state === 'downloaded' && (
              <button
                className="btn btn-primary"
                onClick={install}
                disabled={busyAction !== null}
              >
                <RotateCcw size={15} />
                {busyAction === 'install' ? 'Installeren…' : 'Nu installeren & herstarten'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default UpdatePanel
