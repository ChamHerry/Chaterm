import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockKvGet, mockKvMutate, mockKvTransaction, mockSanitizeForSync } = vi.hoisted(() => ({
  mockKvGet: vi.fn(),
  mockKvMutate: vi.fn(),
  mockKvTransaction: vi.fn(),
  mockSanitizeForSync: vi.fn((value) => value)
}))

vi.mock('../userConfigStoreService', () => ({
  sanitizeForSync: mockSanitizeForSync,
  parseRemoteConfig: vi.fn(() => ({})),
  migrateRemoteConfig: vi.fn((payload) => payload),
  applyRemoteConfig: vi.fn(),
  buildDefaultUserConfig: vi.fn(() => ({ theme: 'auto' })),
  getPlatformKey: vi.fn(() => 'mac'),
  isFlatShortcutConfig: vi.fn(() => false),
  isPlatformShortcuts: vi.fn(() => false),
  SUPPORTED_USER_CONFIG_SCHEMA_VERSION: 1,
  userConfigStore: {
    getConfig: vi.fn(async () => ({ theme: 'auto' }))
  }
}))

vi.mock('../syncJson', () => ({
  canonicalJSONStringify: (value: unknown) => JSON.stringify(value)
}))

describe('UserConfigSyncService', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockKvGet.mockResolvedValue(null)
    mockKvMutate.mockResolvedValue(undefined)
    mockKvTransaction.mockResolvedValue(undefined)
    ;(globalThis as any).window = (globalThis as any).window || {}
    ;(globalThis as any).window.api = {
      kvGet: mockKvGet,
      kvMutate: mockKvMutate,
      kvTransaction: mockKvTransaction
    }
  })

  it('initializes as a local no-op without reading or writing remote sync state', async () => {
    const { userConfigSyncService } = await import('../userConfigSyncService')

    await userConfigSyncService.initialize()
    userConfigSyncService.scheduleUpload()
    userConfigSyncService.stop()

    expect(mockKvGet).not.toHaveBeenCalled()
    expect(mockKvMutate).not.toHaveBeenCalled()
    expect(mockKvTransaction).not.toHaveBeenCalled()
  })

  it('reset only clears local cached platform shortcut metadata', async () => {
    const { userConfigSyncService } = await import('../userConfigSyncService')

    userConfigSyncService.reset()

    expect(mockKvMutate).toHaveBeenCalledWith({
      action: 'delete',
      key: 'platformShortcutsCache'
    })
    expect(mockKvGet).not.toHaveBeenCalled()
    expect(mockKvTransaction).not.toHaveBeenCalled()
  })
})
