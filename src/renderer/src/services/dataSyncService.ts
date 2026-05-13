const logger = createRendererLogger('service.dataSync')

export class DataSyncService {
  private static instance: DataSyncService | null = null
  private isInitialized = false

  static getInstance(): DataSyncService {
    if (!DataSyncService.instance) {
      DataSyncService.instance = new DataSyncService()
    }
    return DataSyncService.instance
  }

  async initialize(): Promise<void> {
    this.isInitialized = true
    logger.info('Data sync is disabled in YiXin-only local mode')
  }

  async enableDataSync(): Promise<boolean> {
    logger.info('Data sync enable ignored in YiXin-only local mode')
    this.isInitialized = true
    return false
  }

  async disableDataSync(): Promise<boolean> {
    logger.info('Data sync disable ignored in YiXin-only local mode')
    this.isInitialized = false
    return true
  }

  reset(): void {
    this.isInitialized = false
  }

  getInitializationStatus(): boolean {
    return this.isInitialized
  }
}

export const dataSyncService = DataSyncService.getInstance()
