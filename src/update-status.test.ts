import { describe, expect, it } from 'vitest'
import {
  downloadingStatus,
  formatUpdateBytes,
  updateProgressDetails,
  updateStatusLabel,
} from './update-status'

describe('app-updatestatus', () => {
  it('meldt dat een beschikbare update automatisch wordt gedownload', () => {
    expect(updateStatusLabel({ state: 'available', version: '1.0.22' }, '1.0.21'))
      .toBe('Update 1.0.22 gevonden. Downloaden start automatisch…')
  })

  it('normaliseert downloadvoortgang en bewaart alle zichtbare meetwaarden', () => {
    expect(downloadingStatus({
      percent: 42.4,
      transferred: 58_000_000,
      total: 138_000_000,
      bytesPerSecond: 4_000_000,
    }, '1.0.22')).toEqual({
      state: 'downloading',
      version: '1.0.22',
      percent: 42,
      transferred: 58_000_000,
      total: 138_000_000,
      bytesPerSecond: 4_000_000,
    })
  })

  it('toont hoeveelheid en snelheid naast het percentage', () => {
    const status = downloadingStatus({
      percent: 50,
      transferred: 50 * 1024 * 1024,
      total: 100 * 1024 * 1024,
      bytesPerSecond: 2.5 * 1024 * 1024,
    })
    expect(updateProgressDetails(status)).toBe('50,0 MB van 100 MB · 2,50 MB/s')
    expect(updateStatusLabel(status, '1.0.21')).toBe('Update downloaden… 50%')
  })

  it('formatteert kleine en ongeldige waarden veilig', () => {
    expect(formatUpdateBytes(1_024)).toBe('1,00 KB')
    expect(formatUpdateBytes(Number.NaN)).toBe('0 B')
    expect(downloadingStatus({ percent: 170 }).percent).toBe(100)
    expect(downloadingStatus({ percent: -10 }).percent).toBe(0)
  })
})
