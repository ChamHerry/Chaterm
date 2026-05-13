// src/renderer/src/services/__tests__/userConfigStore.theme.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as any).window = (globalThis as any).window || {}
  ;(globalThis as any).window.api = {
    kvGet: vi.fn(async () => null),
    kvMutate: vi.fn(async () => undefined),
    kvTransaction: vi.fn(async () => undefined),
    updateTheme: vi.fn()
  }
})

const { mockGetUserTermConfig, mockUpdateUserTermConfig } = vi.hoisted(() => ({
  mockGetUserTermConfig: vi.fn(),
  mockUpdateUserTermConfig: vi.fn()
}))

const { mockUserConfigPiniaStore } = vi.hoisted(() => ({
  mockUserConfigPiniaStore: vi.fn(() => ({
    updateLanguage: vi.fn(),
    updateTheme: vi.fn(),
    updateSecretRedaction: vi.fn(),
    updateDataSync: vi.fn()
  }))
}))

vi.mock('@/api/sync/sync', () => ({
  getUserTermConfig: mockGetUserTermConfig,
  updateUserTermConfig: mockUpdateUserTermConfig
}))

vi.mock('@/locales', () => ({
  default: {
    global: {
      locale: { value: 'zh-CN' }
    }
  }
}))

vi.mock('@/store/userConfigStore', () => ({
  userConfigStore: mockUserConfigPiniaStore
}))

import { SYNC_FIELD_VALIDATORS } from '../userConfigStoreService'

describe('SYNC_FIELD_VALIDATORS.theme', () => {
  const accept = [
    'auto',
    'dark',
    'light',
    'termius-dark',
    'termius-light',
    'flexoki-dark',
    'flexoki-light',
    'kanagawa-wave',
    'kanagawa-dragon',
    'kanagawa-lotus',
    'hacker-blue',
    'hacker-green',
    'dracula-night',
    'catppuccin-mocha',
    'catppuccin-latte',
    'gruvbox-dark',
    'nord-frost'
  ]

  for (const v of accept) {
    it(`accepts ${v}`, () => expect(SYNC_FIELD_VALIDATORS.theme(v)).toBe(true))
  }

  it.each(['not-a-theme', '', 'DARK', 'kanagawa', null, undefined, 42, {}])('rejects %p', (val) => {
    expect(SYNC_FIELD_VALIDATORS.theme(val as any)).toBe(false)
  })
})
