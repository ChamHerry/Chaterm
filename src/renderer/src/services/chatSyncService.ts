const logger = createRendererLogger('service.chatSync')

export class ChatSyncService {
  private static instance: ChatSyncService | null = null
  private isInitialized = false

  static getInstance(): ChatSyncService {
    if (!ChatSyncService.instance) {
      ChatSyncService.instance = new ChatSyncService()
    }
    return ChatSyncService.instance
  }

  async initialize(): Promise<void> {
    this.isInitialized = true
    logger.info('Chat sync is disabled in YiXin-only local mode')
  }

  async enable(): Promise<boolean> {
    logger.info('Chat sync enable ignored in YiXin-only local mode')
    this.isInitialized = true
    return false
  }

  async disable(): Promise<boolean> {
    logger.info('Chat sync disable ignored in YiXin-only local mode')
    this.isInitialized = false
    return true
  }

  async getStatus(): Promise<{ enabled: boolean; lastSyncAt?: number } | null> {
    return { enabled: false }
  }

  async syncNow(): Promise<boolean> {
    logger.info('Chat sync manual trigger ignored in YiXin-only local mode')
    return false
  }

  async setAiTabVisible(_visible: boolean): Promise<void> {
    // Chat sync has been removed; AI tab visibility is local-only.
  }

  reset(): void {
    this.isInitialized = false
  }

  getInitializationStatus(): boolean {
    return this.isInitialized
  }
}

export const chatSyncService = ChatSyncService.getInstance()
