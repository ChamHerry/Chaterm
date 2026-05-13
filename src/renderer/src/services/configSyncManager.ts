const logger = createRendererLogger('service.configSyncManager')

export interface ConfigSyncAdapter<T> {
  readonly configType: string
  readonly metaKey: string
  readonly schemaVersion: number
  readLocal(): Promise<T>
  serializeForUpload(data: T): string
  parseRemote(payload: unknown): T | null
  migrateRemote?(payload: unknown, fromVersion: number, toVersion: number): unknown | null
  applyRemote(data: T, meta?: ConfigSyncMeta, metaKey?: string): Promise<void>
  getDefault?(): T | null
  cacheRemotePlatformData?(serverConfig: string): void
}

export interface ConfigSyncMeta {
  schemaVersion: number
  lastPulledAt: number
  lastPushedAt: number
  lastSyncedPayload: string
  lastSyncedHash: string
  lastRemoteUpdatedAt: number
  lastRemoteSchemaVersion: number
  schemaBlocked: boolean
  dirty: boolean
}

export function buildDefaultConfigSyncMeta(schemaVersion: number): ConfigSyncMeta {
  return {
    schemaVersion,
    lastPulledAt: 0,
    lastPushedAt: 0,
    lastSyncedPayload: '',
    lastSyncedHash: '',
    lastRemoteUpdatedAt: 0,
    lastRemoteSchemaVersion: 0,
    schemaBlocked: false,
    dirty: false
  }
}

export async function markSyncMetaDirty(_metaKey: string, _schemaVersion: number): Promise<void> {
  // Remote config sync has been removed. Keep this hook as a local no-op so
  // existing settings stores can continue saving local preferences.
}

export class ConfigSyncManager<T> {
  private stopped = true

  constructor(private readonly adapter: ConfigSyncAdapter<T>) {}

  async initialize(): Promise<void> {
    this.stopped = false
    logger.info('Config sync is disabled in YiXin-only local mode', { configType: this.adapter.configType })
  }

  scheduleUpload(): void {
    // No-op: configuration stays local.
  }

  stop(): void {
    this.stopped = true
  }

  reset(): void {
    this.stopped = true
  }

  isStopped(): boolean {
    return this.stopped
  }
}
