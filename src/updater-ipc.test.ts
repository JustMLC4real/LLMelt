import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = (payload: Record<string, unknown>) => void
type IpcHandler = (...args: unknown[]) => Promise<unknown>

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener)
      }),
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '1.0.22' } })),
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

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.21',
  },
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: updaterMock.autoUpdater },
}))

import { registerUpdater } from '../electron/updater'

afterEach(() => {
  vi.useRealTimers()
})

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
    })

    const installResult = await handlers.get('updater:install')?.()
    expect(installResult).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('houdt de oude download-handler alleen als retrycompatibiliteit', async () => {
    const handlers = new Map<string, IpcHandler>()
    registerUpdater({ handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never, () => null)

    const result = await handlers.get('updater:download')?.()
    expect(result).toMatchObject({ ok: false })
  })
})
