import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('@logging/index', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
}))

vi.mock('../../services/database-ai', () => ({
  createDbAiService: vi.fn(() => ({ run: vi.fn(), cancel: vi.fn() }))
}))

vi.mock('../../services/database-ai/db-session', () => ({
  closeSessionsOwnedBy: vi.fn()
}))

vi.mock('../../services/database', () => ({
  getConnectionManager: vi.fn()
}))

const { __testing } = await import('../dbAiHandle')

const validDiagnoseRequest = (overrides: Record<string, unknown> = {}) => ({
  reqId: 'dbai-test-1',
  action: 'diagnose',
  context: { assetId: 'asset-1', dbType: 'postgresql', databaseName: 'app' },
  input: { sql: 'select * from missing_table', errorMessage: 'relation does not exist' },
  ...overrides
})

const validConvertRequest = (targetDialect: string) => ({
  reqId: 'req-12345678',
  action: 'convert',
  context: { assetId: 'asset-1', dbType: 'oracle' },
  input: { sql: 'SELECT * FROM employees', targetDialect }
})

describe('dbAiHandle validateRequest', () => {
  it('accepts diagnose errorMessage within the normal text payload limit', () => {
    const result = __testing.validateRequest(validDiagnoseRequest())

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.req.input.errorMessage).toBe('relation does not exist')
    }
  })

  it('rejects oversized diagnose errorMessage payloads', () => {
    const result = __testing.validateRequest(
      validDiagnoseRequest({
        input: {
          sql: 'select 1',
          errorMessage: 'x'.repeat(50 * 1024 + 1)
        }
      })
    )

    expect(result).toEqual({ ok: false, errorMessage: 'input.errorMessage too large or invalid' })
  })

  it('accepts sqlite context and sqlite target dialect', () => {
    const result = __testing.validateRequest(
      validDiagnoseRequest({
        context: { assetId: 'asset-1', dbType: 'sqlite', databaseName: 'main' },
        input: { sql: 'select * from users', errorMessage: 'no such table', targetDialect: 'sqlite' }
      })
    )

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.req.context.dbType).toBe('sqlite')
      expect(result.req.input.targetDialect).toBe('sqlite')
    }
  })

  it('accepts Oracle as a target dialect', () => {
    const result = __testing.validateRequest(validConvertRequest('oracle'))

    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.req.input.targetDialect).toBe('oracle')
  })

  it('still rejects unsupported target dialects', () => {
    const result = __testing.validateRequest(validConvertRequest('mssql'))

    expect(result).toEqual({ ok: false, errorMessage: 'invalid targetDialect' })
  })
})
