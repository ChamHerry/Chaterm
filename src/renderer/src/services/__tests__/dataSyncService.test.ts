import { describe, expect, it } from 'vitest'

import { ChatSyncService } from '../chatSyncService'
import { DataSyncService } from '../dataSyncService'

describe('DataSyncService', () => {
  it('keeps data sync local-only and disabled', async () => {
    const service = new DataSyncService()

    await service.initialize()
    expect(service.getInitializationStatus()).toBe(true)

    await expect(service.enableDataSync()).resolves.toBe(false)
    expect(service.getInitializationStatus()).toBe(true)

    await expect(service.disableDataSync()).resolves.toBe(true)
    expect(service.getInitializationStatus()).toBe(false)
  })

  it('resets local data sync state without IPC side effects', async () => {
    const service = new DataSyncService()

    await service.initialize()
    service.reset()

    expect(service.getInitializationStatus()).toBe(false)
  })
})

describe('ChatSyncService', () => {
  it('keeps chat sync local-only and disabled', async () => {
    const service = new ChatSyncService()

    await service.initialize()
    expect(service.getInitializationStatus()).toBe(true)

    await expect(service.enable()).resolves.toBe(false)
    await expect(service.getStatus()).resolves.toEqual({ enabled: false })
    await expect(service.syncNow()).resolves.toBe(false)

    await expect(service.disable()).resolves.toBe(true)
    expect(service.getInitializationStatus()).toBe(false)
  })

  it('ignores AI tab visibility updates after cloud chat sync removal', async () => {
    const service = new ChatSyncService()

    await expect(service.setAiTabVisible(true)).resolves.toBeUndefined()
  })
})
