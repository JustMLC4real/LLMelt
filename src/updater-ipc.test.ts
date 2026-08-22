import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (payload: Record<string, unknown>) => void
type IpcHandler = (...args: unknown[]) => Promise<unknown>

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: false,
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener)
      }),
      cancelled: false,
      checkForUpdates: vi.fn(async function (this: void) {
        return {
          updateInfo: { version: '1.0.22' },
          cancellationToken: { cancel: () => { updaterMock.autoUpdater.cancelled = true } },
        }
      }),
      downloadUpdate: vi.fn(async () => {
        listeners.get('download-progress')?.({
          percent: 37.8,
          transferred: 52_000_000,
          total: 138_000_000,
          bytesPerSecond: 4_000_000,
        })
        listeners.get('update-downloaded')?.({ version: '1.0.22' })
        return []
      }),
      quitAndInstall: vi.fn(),
    },
  }
})

const appMock = vi.hoisted(() => ({ appPath: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.21',
    getAppPath: () => appMock.appPath,
  },
}))

const storeMock = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => { values.set(key, value) },
    },
  }
})

vi.mock('../electron/settings-store', () => ({ getStore: async () => storeMock.store }))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: updaterMock.autoUpdater },
}))

import { registerUpdater } from '../electron/updater'

beforeEach(() => {
  storeMock.values.clear()
  // Zonder eigen app-map zou de updater de package.json van dit project lezen;
  // elke test kiest hieronder expliciet het kanaal van zijn build.
  buildWithChannel()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Een tijdelijke app-map met de package.json die de updater uitleest. */
function buildWithChannel(channel?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'llmelt-updater-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(channel ? { updateChannel: channel } : {}))
  appMock.appPath = dir
}

describe('updater-IPC', () => {
  it('downloadt automatisch en stuurt volledige downloadvoortgang naar de renderer', async () => {
    vi.useFakeTimers()
    const handlers = new Map<string, IpcHandler>()
    const statuses: Record<string, unknown>[] = []
    const ipcMain = {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    }
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, status: Record<string, unknown>) => statuses.push(status),
      },
    }

    registerUpdater(ipcMain as never, () => window as never)
    expect(updaterMock.autoUpdater.autoDownload).toBe(true)
    expect(updaterMock.autoUpdater.autoInstallOnAppQuit).toBe(false)

    updaterMock.listeners.get('update-available')?.({ version: '1.0.22' })
    expect(statuses.at(-1)).toEqual({
      state: 'downloading',
      version: '1.0.22',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    })
    updaterMock.listeners.get('download-progress')?.({
      percent: 37.8,
      transferred: 52_000_000,
      total: 138_000_000,
      bytesPerSecond: 4_000_000,
    })
    expect(statuses).toContainEqual({
      state: 'downloading',
      version: '1.0.22',
      percent: 38,
      transferred: 52_000_000,
      total: 138_000_000,
      bytesPerSecond: 4_000_000,
    })
    updaterMock.listeners.get('update-downloaded')?.({ version: '1.0.22' })
    expect(statuses.at(-1)).toEqual({ state: 'downloaded', version: '1.0.22' })

    const status = await handlers.get('updater:getStatus')?.()
    expect(status).toEqual({
      status: { state: 'downloaded', version: '1.0.22' },
      currentVersion: '1.0.21',
      supported: true,
      channel: 'stable',
      buildChannel: 'stable',
    })

    const installResult = await handlers.get('updater:install')?.()
    expect(installResult).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('volgt standaard het kanaal waarop deze build is uitgebracht', async () => {
    buildWithChannel('prerelease')
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)

    const status = await handlers.get('updater:getStatus')?.() as Record<string, unknown>
    expect(status.buildChannel).toBe('prerelease')
    expect(status.channel).toBe('prerelease')
    // Alleen deze vlag laat de GitHub-provider prereleases meenemen.
    expect(updaterMock.autoUpdater.allowPrerelease).toBe(true)
  })

  it('laat een opgeslagen keuze zwaarder wegen dan het buildkanaal', async () => {
    buildWithChannel('prerelease')
    storeMock.values.set('updates.channel', 'stable')
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)

    const status = await handlers.get('updater:getStatus')?.() as Record<string, unknown>
    expect(status).toMatchObject({ channel: 'stable', buildChannel: 'prerelease' })
    expect(updaterMock.autoUpdater.allowPrerelease).toBe(false)
  })

  it('bewaart een kanaalwissel en zoekt meteen opnieuw', async () => {
    buildWithChannel('stable')
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)
    updaterMock.autoUpdater.checkForUpdates.mockClear()

    const result = await handlers.get('updater:setChannel')?.(null, 'prerelease')
    expect(result).toMatchObject({ ok: true, channel: 'prerelease' })
    expect(storeMock.values.get('updates.channel')).toBe('prerelease')
    expect(updaterMock.autoUpdater.allowPrerelease).toBe(true)
    expect(updaterMock.autoUpdater.checkForUpdates).toHaveBeenCalled()
  })

  it('weigert een onbekend kanaal zonder iets te bewaren', async () => {
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)

    const result = await handlers.get('updater:setChannel')?.(null, 'nightly') as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(storeMock.values.has('updates.channel')).toBe(false)
  })

  it('laat voortgang van het verlaten kanaal niet meer in beeld komen', async () => {
    buildWithChannel('prerelease')
    const handlers = new Map<string, IpcHandler>()
    const statuses: Record<string, unknown>[] = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (_c: string, status: Record<string, unknown>) => statuses.push(status) },
    }
    registerUpdater({ handle: (c: string, h: IpcHandler) => handlers.set(c, h) } as never, () => window as never)

    // Een check op het prereleasekanaal levert een download op die onderweg is.
    await handlers.get('updater:check')?.()
    updaterMock.listeners.get('update-available')?.({ version: '1.0.22' })
    expect(statuses.at(-1)).toMatchObject({ state: 'downloading' })

    await handlers.get('updater:setChannel')?.(null, 'stable')
    expect(updaterMock.autoUpdater.cancelled).toBe(true)
    const afterSwitch = statuses.length

    // Late voortgang van die geannuleerde download hoort genegeerd te worden.
    updaterMock.listeners.get('download-progress')?.({ percent: 62, transferred: 1, total: 2 })
    updaterMock.listeners.get('update-downloaded')?.({ version: '1.0.22' })
    expect(statuses.slice(afterSwitch).filter((s) => s.state === 'downloading')).toEqual([])
    expect(statuses.at(-1)).not.toMatchObject({ state: 'downloaded' })
  })

  it('meldt een leeg kanaal als toestand, niet als storing', async () => {
    buildWithChannel('stable')
    const handlers = new Map<string, IpcHandler>()
    const statuses: Record<string, unknown>[] = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (_c: string, status: Record<string, unknown>) => statuses.push(status) },
    }
    registerUpdater({ handle: (c: string, h: IpcHandler) => handlers.set(c, h) } as never, () => window as never)

    updaterMock.listeners.get('error')?.(new Error(
      'Cannot parse releases feed: Error: Unable to find latest version on GitHub'
      + ' (https://github.com/JustMLC4real/LLMelt/releases/latest), please ensure a production release exists',
    ) as never)

    expect(statuses.at(-1)).toEqual({ state: 'no-release', channel: 'stable' })
  })

  it('houdt de oude download-handler alleen als retrycompatibiliteit', async () => {
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)

    const result = await handlers.get('updater:download')?.()
    expect(result).toMatchObject({ ok: false })
  })
})
