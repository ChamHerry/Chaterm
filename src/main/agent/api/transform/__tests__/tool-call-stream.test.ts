import { describe, expect, it } from 'vitest'

import { OpenAiToolCallStreamAccumulator, parseNativeToolArguments } from '../../tools'

describe('native OpenAI-style tool call stream accumulator', () => {
  it('aggregates streamed tool-call argument deltas into a native tool call', () => {
    const accumulator = new OpenAiToolCallStreamAccumulator()

    accumulator.append([{ index: 0, id: 'call_1', function: { name: 'list_tables', arguments: '{"database":"app' } }])
    accumulator.append([{ index: 0, function: { arguments: '_prod","schema":"public"}' } }])

    const calls = accumulator.flush('openai')

    expect(calls).toEqual([
      {
        id: 'call_1',
        name: 'list_tables',
        input: { database: 'app_prod', schema: 'public' },
        rawArguments: '{"database":"app_prod","schema":"public"}',
        provider: 'openai'
      }
    ])
  })

  it('returns invalid tool call for malformed JSON arguments', () => {
    const accumulator = new OpenAiToolCallStreamAccumulator()

    accumulator.append([{ index: 0, id: 'call_bad', function: { name: 'list_tables', arguments: '{bad' } }])

    const calls = accumulator.flush('openai')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ invalid: true, id: 'call_bad', name: 'list_tables', rawArguments: '{bad' })
  })

  it('repairs malformed execute_command JSON with unescaped shell quotes', () => {
    const accumulator = new OpenAiToolCallStreamAccumulator()

    accumulator.append([
      {
        index: 0,
        id: 'call_cmd',
        function: {
          name: 'execute_command',
          arguments: '{"ip":"10.0.0.1","command":"awk "{print $1}" /var/log/app.log","requires_approval":false,"interactive":false}'
        }
      }
    ])

    const calls = accumulator.flush('openai')

    expect(calls).toEqual([
      {
        id: 'call_cmd',
        name: 'execute_command',
        input: {
          ip: '10.0.0.1',
          command: 'awk "{print $1}" /var/log/app.log',
          requires_approval: true,
          interactive: false
        },
        rawArguments: '{"ip":"10.0.0.1","command":"awk "{print $1}" /var/log/app.log","requires_approval":false,"interactive":false}',
        provider: 'openai'
      }
    ])
  })

  it('requires native arguments to be JSON objects', () => {
    expect(parseNativeToolArguments('[]')).toMatchObject({ ok: false })
    expect(parseNativeToolArguments('"x"')).toMatchObject({ ok: false })
    expect(parseNativeToolArguments('{"x":1}')).toEqual({ ok: true, input: { x: 1 } })
  })
})
