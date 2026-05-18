import { describe, expect, it } from 'vitest'

import { __testing } from '../index'

describe('db-ai diagnose prompt', () => {
  it('caps fallback table list size in the system prompt', () => {
    const tables = Array.from({ length: 250 }, (_, index) => `table_${index}`)

    const section = __testing.buildDiagnoseTableListSection(tables)

    expect(section).toContain('AVAILABLE TABLES IN CURRENT DATABASE')
    expect(section).toContain('50 additional tables omitted')
    expect(section).toContain('table_199')
    expect(section).not.toContain('table_200')
  })

  it('normalizes blank table names out of diagnose prompt fallback context', () => {
    const { systemPrompt } = __testing.buildDiagnosePrompt('select * from bad', 'missing table', 'postgresql', '', [' users ', '', 'orders\narchive'])

    expect(systemPrompt).toContain('users, orders archive')
    expect(systemPrompt).not.toContain('users, ,')
  })
})
