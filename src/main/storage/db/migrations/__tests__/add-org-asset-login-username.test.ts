import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('@logging/index', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }))
}))

const { upgradeOrgAssetLoginUsernameSupport } = await import('../add-org-asset-login-username')

type Statement = {
  all: () => Array<{ name?: string }>
}

type MockDb = {
  prepare: (sql: string) => Statement
  exec: (sql: string) => void
}

describe('upgradeOrgAssetLoginUsernameSupport', () => {
  let db: MockDb
  let tableColumns: Array<{ name?: string }>
  let execCalls: string[]

  beforeEach(() => {
    tableColumns = []
    execCalls = []

    db = {
      prepare(sql: string): Statement {
        const normalized = sql.trim().toLowerCase()

        if (normalized.includes('pragma table_info(t_organization_assets)')) {
          return { all: () => tableColumns }
        }

        return { all: () => [] }
      },
      exec(sql: string) {
        execCalls.push(sql)
      }
    }
  })

  it('adds login username columns when missing', async () => {
    tableColumns = [{ name: 'uuid' }, { name: 'hostname' }]

    await upgradeOrgAssetLoginUsernameSupport(db as unknown as Database.Database)

    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]).toContain('ALTER TABLE t_organization_assets ADD COLUMN login_username TEXT DEFAULT NULL')
    expect(execCalls[1]).toContain('ALTER TABLE t_organization_assets ADD COLUMN login_user_name TEXT DEFAULT NULL')
  })

  it('skips migration when columns already exist', async () => {
    tableColumns = [{ name: 'login_username' }, { name: 'login_user_name' }]

    await upgradeOrgAssetLoginUsernameSupport(db as unknown as Database.Database)

    expect(execCalls).toHaveLength(0)
  })

  it('adds only the missing display name column', async () => {
    tableColumns = [{ name: 'login_username' }]

    await upgradeOrgAssetLoginUsernameSupport(db as unknown as Database.Database)

    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toContain('ALTER TABLE t_organization_assets ADD COLUMN login_user_name TEXT DEFAULT NULL')
  })

  it('propagates database errors', async () => {
    const errorDb = {
      prepare() {
        throw new Error('Database connection error')
      }
    }

    await expect(upgradeOrgAssetLoginUsernameSupport(errorDb as unknown as Database.Database)).rejects.toThrow('Database connection error')
  })
})
