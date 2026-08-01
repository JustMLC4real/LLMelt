export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'up-to-date'; version?: string }
  | {
    state: 'downloading'
    version?: string
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  }
  | { state: 'downloaded'; version: string }
  | { state: 'installing'; version?: string }
  | { state: 'error'; error: string; version?: string }

type DownloadProgress = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

function finitePositive(value: number | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0
}

export function downloadingStatus(
  progress: DownloadProgress = {},
  version?: string,
): Extract<UpdateStatus, { state: 'downloading' }> {
  const percent = Math.min(100, Math.max(0, Math.round(finitePositive(progress.percent))))
  return {
    state: 'downloading',
    version,
    percent,
    transferred: finitePositive(progress.transferred),
    total: finitePositive(progress.total),
    bytesPerSecond: finitePositive(progress.bytesPerSecond),
  }
}

export function formatUpdateBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** unitIndex)
  const decimals = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  const formatted = new Intl.NumberFormat('nl-NL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
  return `${formatted} ${units[unitIndex]}`
}

export function updateProgressDetails(status: UpdateStatus) {
  if (status.state !== 'downloading') return ''
  const details: string[] = []
  if (status.total > 0) {
    details.push(`${formatUpdateBytes(status.transferred)} van ${formatUpdateBytes(status.total)}`)
  }
  if (status.bytesPerSecond > 0) {
    details.push(`${formatUpdateBytes(status.bytesPerSecond)}/s`)
  }
  return details.join(' · ')
}

export function updateStatusLabel(status: UpdateStatus, currentVersion: string) {
  switch (status.state) {
    case 'checking':
      return 'Zoeken naar updates…'
    case 'available':
      return `Update ${status.version} gevonden. Downloaden start automatisch…`
    case 'downloading':
      return `Update${status.version ? ` ${status.version}` : ''} downloaden… ${status.percent}%`
    case 'downloaded':
      return `Update ${status.version} is gedownload en klaar om te installeren.`
    case 'installing':
      return 'Update wordt geïnstalleerd; de app herstart zo…'
    case 'up-to-date':
      return `Je hebt de nieuwste versie${status.version ? ` (${status.version})` : ''}.`
    case 'error':
      return `Update mislukt: ${status.error}`
    default:
      return `Huidige versie: ${currentVersion || '—'}`
  }
}
