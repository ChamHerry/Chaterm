// Temporary reproduction harness for the AI context-compression / truncation chain.
// NOT for CI: only runs when REPRO_COMPRESSION=1 (otherwise the whole suite is skipped).
//
// Purpose: gather evidence across provider / config / data boundaries to localize the
// "compression keeps failing on the local branch" symptom. See ContextManager.ts.
// We use the REAL OpenAiHandler (no mocks) and intentionally avoid importing
// ContextManager / disk.ts so no sqlite native binding is needed.
//
// Stages:
//   0  - Provider boundary with full config (incl. max_tokens + x-api-key).
//   0a - Same request with maxTokens disabled (isolates max_tokens as a failure cause).
//   0b - Auth variant: Bearer only (no x-api-key header).
//   1  - R2: the truncation summary request end-to-end, mirroring
//        ContextManager.summarizeMessagesBeforeTruncation including the 30s race.
//   2  - R1: getContextWindowInfo across contextWindow values -> maxAllowedSize.
//   3  - R3: structuredClone on the first assistant message (getAndAlterTruncatedMessages).
//
// Run locally:
//   REPRO_COMPRESSION=1 REPRO_API_KEY=sk-... \
//   REPRO_MODEL=minimax-m2.7 \
//   REPRO_BASE_URL=https://aiproxy.si-tech.com.cn/api/v1/openai/v1 \
//   REPRO_CONTEXT_WINDOW=128000 REPRO_MAX_TOKENS=32000 \
//   npx vitest run src/main/agent/core/context/__tests__/compression-repro.test.ts

import { describe, it, expect } from 'vitest'
import { OpenAiHandler } from '../../../api/providers/openai'
import { createTextOnlyRequest } from '../../../api/tools'
import type { ApiStream } from '../../../api/transform/stream'
import { getContextWindowInfo } from '../context-management/context-window-utils'
import { formatResponse } from '../../prompts/responses'
import type { ApiHandlerOptions, OpenAiCompatibleModelInfo } from '../../../shared/api'

const RUN = process.env.REPRO_COMPRESSION === '1'

const apiKey = process.env.REPRO_API_KEY ?? ''
const baseUrl = process.env.REPRO_BASE_URL ?? 'https://aiproxy.si-tech.com.cn/api/v1/openai/v1'
const modelId = process.env.REPRO_MODEL ?? 'minimax-m2.7'
const ctxWindow = Number(process.env.REPRO_CONTEXT_WINDOW ?? '128000')
const maxTokens = Number(process.env.REPRO_MAX_TOKENS ?? '0')

function buildOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
  const modelInfo: OpenAiCompatibleModelInfo = {
    supportsPromptCache: false,
    contextWindow: ctxWindow,
    ...(maxTokens > 0 ? { maxTokens } : {})
  }
  return {
    openAiBaseUrl: baseUrl,
    openAiApiKey: apiKey,
    openAiModelId: modelId,
    // Also send x-api-key: some proxies accept it but not Authorization: Bearer.
    openAiHeaders: { 'x-api-key': apiKey },
    openAiModelInfo: modelInfo,
    needProxy: false,
    requestTimeoutMs: Number(process.env.REPRO_TIMEOUT_MS ?? '60000'),
    ...overrides
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

// Consume an ApiStream fully; capture partial text + the point of failure.
async function collectStream(stream: ApiStream, label: string) {
  let text = ''
  let usage: unknown = null
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk
    }
    return { text, usage, error: null as string | null }
  } catch (e) {
    console.log(`[${label}] stream threw after ${text.length} chars ->`, describeError(e))
    return { text, usage, error: describeError(e) }
  }
}

// Fake "conversation excerpt about to be truncated" — long enough to be worth summarizing.
function buildConversationToSummarize(): string {
  const lines: string[] = []
  for (let i = 0; i < 60; i++) {
    lines.push(`User: check disk usage on host-${i}.example.com and clean logs`)
    lines.push(`Assistant: logged in to host-${i}.example.com; /data at ${70 + (i % 25)}%; freed ${(i * 13) % 500}MB from /var/log/app.log`)
  }
  return lines.join('\n')
}

describe.skipIf(!RUN)('compression/truncation reproduction (set REPRO_COMPRESSION=1)', () => {
  it('Stage 0 - provider boundary: connectivity + auth (full config)', async () => {
    const handler = new OpenAiHandler(buildOptions())
    const req = createTextOnlyRequest('You are a connectivity probe. Reply briefly.', [{ role: 'user', content: 'ping' }])
    const res = await collectStream(handler.createMessage(req), 'Stage0')
    console.log('[Stage0] full config:', {
      ok: res.error === null,
      text: res.text.slice(0, 120),
      usage: res.usage,
      error: res.error
    })
    expect(true).toBe(true)
  }, 120_000)

  it('Stage 0a - same request with maxTokens disabled (isolate max_tokens cause)', async () => {
    const handler = new OpenAiHandler(buildOptions({ openAiModelInfo: { supportsPromptCache: false, contextWindow: ctxWindow } }))
    const req = createTextOnlyRequest('You are a connectivity probe. Reply briefly.', [{ role: 'user', content: 'ping' }])
    const res = await collectStream(handler.createMessage(req), 'Stage0a')
    console.log('[Stage0a] maxTokens=undefined:', {
      ok: res.error === null,
      text: res.text.slice(0, 120),
      error: res.error
    })
    expect(true).toBe(true)
  }, 120_000)

  it('Stage 0b - auth variant: Bearer only (drop x-api-key header)', async () => {
    const handler = new OpenAiHandler(buildOptions({ openAiHeaders: undefined }))
    const req = createTextOnlyRequest('You are a connectivity probe. Reply briefly.', [{ role: 'user', content: 'ping' }])
    const res = await collectStream(handler.createMessage(req), 'Stage0b')
    console.log('[Stage0b] Bearer only:', {
      ok: res.error === null,
      text: res.text.slice(0, 120),
      error: res.error
    })
    expect(true).toBe(true)
  }, 120_000)

  it('Stage 1 (R2) - truncation summary request, mirroring summarizeMessagesBeforeTruncation (30s race)', async () => {
    const handler = new OpenAiHandler(buildOptions())
    const serialized = buildConversationToSummarize()
    const userContent = formatResponse.preTruncationSummaryUserContent(serialized, null)
    const req = createTextOnlyRequest(formatResponse.preTruncationSummaryPrompt(), [{ role: 'user', content: userContent }])

    // Mirror ContextManager.summarizeMessagesBeforeTruncation exactly: race the
    // generator collection against a 30s timeout that closes the stream.
    const stream = handler.createMessage(req)
    let timedOut = false
    const collect = async (): Promise<string> => {
      const chunks: string[] = []
      for await (const chunk of stream) {
        if (timedOut) break
        if (chunk.type === 'text') chunks.push(chunk.text)
      }
      return chunks.join('')
    }
    const timeout = new Promise<string>((_, reject) => {
      setTimeout(() => {
        timedOut = true
        stream.return(undefined as never).catch(() => {})
        reject(new Error('Summary request timed out (30s)'))
      }, 30_000)
    })

    const started = Date.now()
    let summary = ''
    let failureMode: string | null = null
    try {
      summary = await Promise.race([collect(), timeout])
    } catch (e) {
      failureMode = describeError(e)
    }
    const elapsed = Date.now() - started
    const tooShort = summary.length > 0 && summary.length < 50
    console.log('[Stage1] summary result:', {
      elapsedMs: elapsed,
      summaryLength: summary.length,
      summaryHead: summary.slice(0, 160),
      tooShortToUse: tooShort,
      failureMode,
      note: failureMode
        ? '=> summary FAILED; ContextManager logs "Pre-truncation summary failed" and falls back to standard truncation'
        : tooShort
          ? '=> summary too short (<50); treated as null, falls back to standard truncation'
          : '=> summary OK'
    })
    expect(true).toBe(true)
  }, 120_000)

  it('Stage 2 (R1) - getContextWindowInfo across contextWindow values', () => {
    const cases = [4096, 8192, 64000, 100000, 128000, 200000, 245760, 1000000]
    for (const cw of cases) {
      const handler = new OpenAiHandler(buildOptions({ openAiModelInfo: { supportsPromptCache: false, contextWindow: cw } }))
      const info = getContextWindowInfo(handler)
      const branch = [64000, 128000, 200000].includes(cw) ? 'explicit' : 'default'
      console.log(`[Stage2] contextWindow=${String(cw).padStart(7)} branch=${branch.padEnd(8)} -> maxAllowedSize=${info.maxAllowedSize}`)
    }
    console.log('[Stage2] note: small / non-standard windows hit the default branch where')
    console.log('         maxAllowedSize = max(ctx - 40000, ctx * 0.8); for small windows this is tiny')
    console.log('         => needsTruncation returns true almost every turn => repeated compression')
    expect(true).toBe(true)
  })

  it('Stage 3 (R3) - structuredClone on first assistant message (getAndAlterTruncatedMessages)', () => {
    // Inline replica of the clone step inside ContextManager.getAndAlterTruncatedMessages.
    function tryClone(firstAssistantContent: unknown): { ok: boolean; error: string | null } {
      const msg = { role: 'assistant', content: firstAssistantContent }
      try {
        structuredClone(msg)
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }
    console.log('[Stage3] plain text block :', tryClone([{ type: 'text', text: 'hello' }]))
    console.log('[Stage3] content w/ function:', tryClone([{ type: 'text', text: 'x', fn: () => {} }]))
    console.log('[Stage3] note: getAndAlterTruncatedMessages has NO try/catch around structuredClone;')
    console.log('         a DataCloneError bubbles through getNewContextMessagesAndMetadata (no try/catch)')
    console.log('         and attemptApiRequest (compressing sent, completed NOT sent)')
    console.log('         => main request fails + UI stuck on "compressing"')
    expect(true).toBe(true)
  })

  it('Stage 4 (R2-variant) - count usage chunks in one stream (token accumulation)', async () => {
    // Short output + no max_tokens, so the stream finishes fast and we can cleanly
    // count how many usage chunks aiproxy/minimax emits in a single request.
    const handler = new OpenAiHandler(buildOptions({ openAiModelInfo: { supportsPromptCache: false, contextWindow: ctxWindow } }))
    const req = createTextOnlyRequest('Reply with exactly one word: pong', [{ role: 'user', content: 'ping' }])
    const usageChunks: Array<{ inputTokens: number; outputTokens: number }> = []
    let textChunks = 0
    for await (const chunk of handler.createMessage(req)) {
      if (chunk.type === 'usage') {
        usageChunks.push({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
      } else if (chunk.type === 'text') {
        textChunks++
      }
    }
    const sumInput = usageChunks.reduce((a, c) => a + c.inputTokens, 0)
    const sumOutput = usageChunks.reduce((a, c) => a + c.outputTokens, 0)
    const lastInput = usageChunks.at(-1)?.inputTokens ?? 0
    const lastOutput = usageChunks.at(-1)?.outputTokens ?? 0
    console.log('[Stage4] usage chunk count:', usageChunks.length, '| text chunk count:', textChunks)
    console.log('[Stage4] per-chunk usage:', usageChunks)
    console.log('[Stage4] SUM  input=', sumInput, 'output=', sumOutput, '(what Chaterm records via += at task/index.ts:2692)')
    console.log('[Stage4] LAST input=', lastInput, 'output=', lastOutput, '(single value, correct)')
    console.log('[Stage4] totalTokens(SUM)=', sumInput + sumOutput, ' vs maxAllowedSize(128k window)=98000')
    console.log(
      '[Stage4] note: if usage chunk count > 1, Chaterm ADDS them => inflated totalTokens => spurious needsTruncation => repeated compression'
    )
    expect(true).toBe(true)
  }, 120_000)
})
