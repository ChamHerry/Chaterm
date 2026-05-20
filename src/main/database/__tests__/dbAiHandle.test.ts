import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { __testing } from '../dbAiHandle'

const validDiagnoseRequest = (overrides: Record<string, unknown> = {}) => ({
  reqId: 'dbai-test-1',
  action: 'diagnose',
  context: { assetId: 'asset-1', dbType: 'postgresql', databaseName: 'app' },
  input: { sql: 'select * from missing_table', errorMessage: 'relation does not exist' },
  ...overrides
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
})
