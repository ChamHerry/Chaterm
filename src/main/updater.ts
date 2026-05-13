import { ipcMain } from 'electron'

const logger = createLogger('updater')

const disabledUpdateResult = {
  disabled: true,
  isUpdateAvailable: false,
  updateInfo: null,
  versionInfo: null
}

export const registerUpdater = (_targetWindow, _setForceQuit: (value: boolean) => void) => {
  ipcMain.handle('update:checkUpdate', async () => {
    logger.info('Update check skipped because auto update is temporarily disabled')
    return disabledUpdateResult
  })

  ipcMain.handle('update:download', async () => {
    logger.info('Update download skipped because auto update is temporarily disabled')
    return disabledUpdateResult
  })

  ipcMain.handle('update:quitAndInstall', async () => {
    logger.info('Update install skipped because auto update is temporarily disabled')
    return disabledUpdateResult
  })
}
