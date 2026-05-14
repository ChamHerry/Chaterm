import { describe, expect, it } from 'vitest'

import { getNativeToolDefinitions, normalizeNativeToolInput, validateNativeToolInput } from '../tool-registry'

describe('native tool registry definitions', () => {
  it('exposes DB-AI tools as native JSON-schema function definitions', () => {
    const tools = getNativeToolDefinitions('database')
    const listTables = tools.find((tool) => tool.function.name === 'list_tables')

    expect(listTables).toBeTruthy()
    expect(listTables?.type).toBe('function')
    expect(listTables?.function.parameters).toMatchObject({
      type: 'object',
      properties: {
        database: { type: 'string' },
        schema: { type: 'string' }
      },
      additionalProperties: false
    })
  })

  it('validates required native DB tool parameters without XML parsing', () => {
    expect(validateNativeToolInput('describe_table', { table: 'users' })).toEqual({ ok: true })
    expect(validateNativeToolInput('describe_table', {})).toMatchObject({ ok: false })
  })

  it('normalizes native JSON inputs for existing string-param handlers', () => {
    expect(normalizeNativeToolInput('count_rows', { table: 'orders', exact: true })).toEqual({ table: 'orders', exact: 'true' })
  })
})
