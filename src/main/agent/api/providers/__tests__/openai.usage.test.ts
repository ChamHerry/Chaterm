// Regression test for a token-usage inflation bug that caused spurious context
// compression on OpenAI-compatible endpoints (e.g. minimax-m2.7 behind aiproxy).
//
// Such endpoints attach a CUMULATIVE `usage` object to EVERY streamed chunk instead
// of only the final chunk (as standard OpenAI does). OpenAiHandler must yield usage
// exactly once with the final cumulative value; otherwise Task.handleUsageChunk
// (task/index.ts) sums every yielded usage and inflates token counts, which makes
// ContextManager.needsTruncation trip on nearly every turn.

import { describe, it, expect } from 'vitest'
import { OpenAiHandler } from '../openai'
import { createTextOnlyRequest } from '../../tools'

function makeHandler() {
  return new OpenAiHandler({
    openAiBaseUrl: 'https://example.invalid',
    openAiApiKey: 'k',
    openAiModelId: 'test-model',
    needProxy: false,
    openAiModelInfo: { supportsPromptCache: false, contextWindow: 128_000 }
  } as never)
}

// Mimics a chatty proxy: three chunks, each carrying the same cumulative usage
// (prompt_tokens stays 24, completion_tokens grows to 36).
function fakeStreamChunks() {
  return [
    { choices: [{ delta: { content: 'po' } }], usage: { prompt_tokens: 24, completion_tokens: 1 } },
    { choices: [{ delta: { content: 'ng' } }], usage: { prompt_tokens: 24, completion_tokens: 10 } },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 24, completion_tokens: 36 } }
  ]
}

describe('OpenAiHandler usage dedup for chatty proxies', () => {
  it('yields usage exactly once with the final cumulative value', async () => {
    const handler = makeHandler()
    const chunks = fakeStreamChunks()
    const fakeStream = (async function* () {
      for (const c of chunks) yield c
    })()
    // The OpenAI client is private; replace it with a stub returning our fake stream.
    ;(handler as unknown as { client: unknown }).client = {
      chat: { completions: { create: async () => fakeStream } }
    }

    const req = createTextOnlyRequest('sys', [{ role: 'user', content: 'ping' }])
    const usages: Array<{ inputTokens: number; outputTokens: number }> = []
    const texts: string[] = []
    for await (const c of handler.createMessage(req)) {
      if (c.type === 'usage') usages.push({ inputTokens: c.inputTokens, outputTokens: c.outputTokens })
      else if (c.type === 'text') texts.push(c.text)
    }

    // Text must still stream normally.
    expect(texts.join('')).toBe('pong')
    // Usage must be emitted exactly once, holding the FINAL cumulative value.
    expect(usages).toHaveLength(1)
    expect(usages[0].inputTokens).toBe(24)
    expect(usages[0].outputTokens).toBe(36)
  })

  it('dedups usage across multiple chunks that also carry cache fields', async () => {
    const handler = makeHandler()
    // Two chunks both carry usage with extra cache/detail fields; only the final
    // cumulative value must be emitted once.
    const chunks = [
      { choices: [{ delta: { content: 'hel' } }], usage: { prompt_tokens: 30, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10 } } },
      { choices: [{ delta: { content: 'lo' } }], usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } }
    ]
    const fakeStream = (async function* () {
      for (const c of chunks) yield c
    })()
    ;(handler as unknown as { client: unknown }).client = {
      chat: { completions: { create: async () => fakeStream } }
    }

    const req = createTextOnlyRequest('sys', [{ role: 'user', content: 'hi' }])
    const usages: Array<{ inputTokens: number; outputTokens: number }> = []
    const texts: string[] = []
    for await (const c of handler.createMessage(req)) {
      if (c.type === 'usage') usages.push({ inputTokens: c.inputTokens, outputTokens: c.outputTokens })
      else if (c.type === 'text') texts.push(c.text)
    }

    expect(texts.join('')).toBe('hello')
    expect(usages).toHaveLength(1)
    expect(usages[0].inputTokens).toBe(30)
    expect(usages[0].outputTokens).toBe(5)
  })
})
