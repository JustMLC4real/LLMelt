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

export type UpdateTranslator = (
  key: string,
  options?: Record<string, string | number>,
) => string

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

export function formatUpdateBytes(bytes: number, locale = 'nl-NL') {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** unitIndex)
  const decimals = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
  return `${formatted} ${units[unitIndex]}`
}

export function updateProgressDetails(
  status: UpdateStatus,
  locale = 'nl-NL',
  ofLabel = 'van',
) {
  if (status.state !== 'downloading') return ''
  const details: string[] = []
  if (status.total > 0) {
    details.push(`${formatUpdateBytes(status.transferred, locale)} ${ofLabel} ${formatUpdateBytes(status.total, locale)}`)
  }
  if (status.bytesPerSecond > 0) {
    details.push(`${formatUpdateBytes(status.bytesPerSecond, locale)}/s`)
  }
  return details.join(' · ')
}

export function updateStatusLabel(
  status: UpdateStatus,
  currentVersion: string,
  translate: UpdateTranslator = defaultDutchUpdateTranslator,
) {
  switch (status.state) {
    case 'checking':
      return translate('updates.status.checking')
    case 'available':
      return translate('updates.status.available', { version: status.version })
    case 'downloading':
      return status.version
        ? translate('updates.status.downloadingVersion', { version: status.version, percent: status.percent })
        : translate('updates.status.downloading', { percent: status.percent })
    case 'downloaded':
      return translate('updates.status.downloaded', { version: status.version })
    case 'installing':
      return translate('updates.status.installing')
    case 'up-to-date':
      return status.version
        ? translate('updates.status.upToDateVersion', { version: status.version })
        : translate('updates.status.upToDate')
    case 'error':
      return translate('updates.status.error', { error: status.error })
    default:
      return translate('updates.status.current', { version: currentVersion || '—' })
  }
}

function defaultDutchUpdateTranslator(
  key: string,
  options: Record<string, string | number> = {},
) {
  const values: Record<string, string> = {
    'updates.status.checking': 'Zoeken naar updates…',
    'updates.status.available': 'Update {{version}} gevonden. Downloaden start automatisch…',
    'updates.status.downloadingVersion': 'Update {{version}} downloaden… {{percent}}%',
    'updates.status.downloading': 'Update downloaden… {{percent}}%',
    'updates.status.downloaded': 'Update {{version}} is gedownload en klaar om te installeren.',
    'updates.status.installing': 'Update wordt geïnstalleerd; de app herstart zo…',
    'updates.status.upToDateVersion': 'Je hebt de nieuwste versie ({{version}}).',
    'updates.status.upToDate': 'Je hebt de nieuwste versie.',
    'updates.status.error': 'Update mislukt: {{error}}',
    'updates.status.current': 'Huidige versie: {{version}}',
  }
  return (values[key] || key).replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
}
