import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerUpdater } from './updater'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const getHandler = (channel: string) => {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!call) throw new Error(`Missing IPC handler: ${channel}`)
  return call[1] as () => Promise<unknown>
}

describe('registerUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers disabled updater handlers that do not start update work', async () => {
    const setForceQuit = vi.fn()

    registerUpdater(null, setForceQuit)

    await expect(getHandler('update:checkUpdate')()).resolves.toMatchObject({
      disabled: true,
      isUpdateAvailable: false,
      updateInfo: null,
      versionInfo: null
    })
    await expect(getHandler('update:download')()).resolves.toMatchObject({
      disabled: true,
      isUpdateAvailable: false
    })
    await expect(getHandler('update:quitAndInstall')()).resolves.toMatchObject({
      disabled: true,
      isUpdateAvailable: false
    })
    expect(setForceQuit).not.toHaveBeenCalled()
  })
})
