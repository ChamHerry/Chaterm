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

  it('rejects legacy file_path aliases for native file tools', () => {
    expect(validateNativeToolInput('read_file', { file_path: 'src/main/index.ts' })).toMatchObject({ ok: false })
    expect(validateNativeToolInput('write_to_file', { file_path: 'notes.txt', content: 'hello' })).toMatchObject({ ok: false })
  })

  it('does not require read_file offset or limit because the handler supplies defaults', () => {
    const readFile = getNativeToolDefinitions('server').find((tool) => tool.function.name === 'read_file')

    expect(readFile?.function.parameters.required).toEqual(['path'])
    expect(validateNativeToolInput('read_file', { path: 'src/main/index.ts' })).toEqual({ ok: true })
  })

  it('only exposes implemented canonical fields for native server tools', () => {
    const tools = getNativeToolDefinitions('server')
    const byName = (name: string) => tools.find((tool) => tool.function.name === name)?.function.parameters

    expect(byName('execute_command')?.required).toEqual(['ip', 'command', 'requires_approval'])
    expect(byName('execute_command')?.properties).not.toHaveProperty('interactive')
    expect(byName('execute_command')?.properties).not.toHaveProperty('depositExperience')

    expect(byName('attempt_completion')?.required).toEqual(['result'])

    expect(byName('glob_search')?.properties).not.toHaveProperty('file_pattern')
    expect(byName('grep_search')?.properties).not.toHaveProperty('regex')
    expect(byName('grep_search')?.properties).not.toHaveProperty('file_pattern')
    expect(byName('write_to_file')?.properties).not.toHaveProperty('diff')
  })
})
