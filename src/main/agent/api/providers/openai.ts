//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0
//
// Copyright (c) 2025 cline Authors, All rights reserved.
// Licensed under the Apache License, Version 2.0

import OpenAI, { AzureOpenAI } from 'openai'
import { withRetry } from '../retry'
import { ApiHandlerOptions, azureOpenAiDefaultApiVersion, ModelInfo, openAiModelInfoSaneDefaults } from '@shared/api'
import { ApiHandler } from '../index'
import { convertToOpenAiMessages } from '../transform/openai-format'
import { convertToResponsesInput } from '../transform/responses-format'
import type { ApiStream } from '../transform/stream'
import type { ApiCreateMessageRequest, NativeToolChoice, NativeToolDefinition } from '../tools'
import { OpenAiToolCallStreamAccumulator } from '../tools'
import { convertToR1Format } from '../transform/r1-format'
import type { ChatCompletionReasoningEffort } from 'openai/resources/chat/completions'
import { checkProxyConnectivity, createProxyAgent } from './proxy/index'
import type { Agent } from 'http'
const logger = createLogger('agent')

function isAzureEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    return parsed.hostname.toLowerCase().endsWith('.azure.com')
  } catch {
    return false
  }
}

/**
 * Normalize the base URL for OpenAI SDK:
 * - URL ending with '#': strip '#', skip /v1 prefix (user wants direct path)
 * - URL already containing '/v1' path segment: use as-is
 * - Otherwise: auto-append /v1
 */
function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (!url) return url
  const trimmed = url.trim()
  if (!trimmed) return trimmed

  // '#' at end = skip /v1 version prefix
  if (trimmed.endsWith('#')) {
    return trimmed.slice(0, -1)
  }

  // Check if URL already contains /v1 path segment
  try {
    const parsed = new URL(trimmed)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.includes('v1')) {
      return trimmed
    }
  } catch {
    return trimmed
  }

  // Auto-add /v1
  const separator = trimmed.endsWith('/') ? '' : '/'
  return `${trimmed}${separator}v1`
}

export class OpenAiHandler implements ApiHandler {
  private options: ApiHandlerOptions
  private client: OpenAI

  constructor(options: ApiHandlerOptions) {
    this.options = options
    // Azure API shape slightly differs from the core API shape: https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
    // Use azureApiVersion to determine if this is an Azure endpoint, since the URL may not always contain 'azure.com'
    let httpAgent: Agent | undefined = undefined
    if (this.options.needProxy !== false) {
      const proxyConfig = this.options.proxyConfig
      httpAgent = createProxyAgent(proxyConfig)
    }
    const timeoutMs = this.options.requestTimeoutMs || 20000

    if (
      this.options.azureApiVersion ||
      (isAzureEndpoint(this.options.openAiBaseUrl) && !this.options.openAiModelId?.toLowerCase().includes('deepseek'))
    ) {
      this.client = new AzureOpenAI({
        baseURL: normalizeBaseUrl(this.options.openAiBaseUrl),
        apiKey: this.options.openAiApiKey,
        apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
        defaultHeaders: this.options.openAiHeaders,
        ...(httpAgent && { fetchOptions: { agent: httpAgent } as any }),
        timeout: timeoutMs
      })
    } else {
      this.client = new OpenAI({
        baseURL: normalizeBaseUrl(this.options.openAiBaseUrl),
        apiKey: this.options.openAiApiKey,
        defaultHeaders: this.options.openAiHeaders,
        ...(httpAgent && { fetchOptions: { agent: httpAgent } as any }),
        timeout: timeoutMs
      })
    }
  }

  @withRetry()
  async *createMessage(request: ApiCreateMessageRequest): ApiStream {
    const useResponsesApi = this.options.openAiModelInfo?.apiFormat === 'responses'

    if (useResponsesApi) {
      yield* this.createMessageViaResponses(request)
    } else {
      yield* this.createMessageViaChatCompletions(request)
    }
  }

  private async *createMessageViaChatCompletions(request: ApiCreateMessageRequest): ApiStream {
    const { systemPrompt, messages, tools } = request
    const modelId = this.options.openAiModelId ?? ''
    const isDeepseekReasoner = modelId.includes('deepseek-reasoner')
    const isR1FormatRequired = this.options.openAiModelInfo?.isR1FormatRequired ?? false
    const isReasoningModelFamily = modelId.includes('o1') || modelId.includes('o3') || modelId.includes('o4')
    const isGpt5OrAbove = modelId.startsWith('gpt-5') || modelId.startsWith('gpt-6')
    const supportsTemperature = !isReasoningModelFamily && !isGpt5OrAbove

    let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...convertToOpenAiMessages(messages)]
    let temperature: number | undefined = this.options.openAiModelInfo?.temperature ?? openAiModelInfoSaneDefaults.temperature
    let reasoningEffort: ChatCompletionReasoningEffort | undefined = undefined
    let maxTokens: number | undefined

    if (this.options.openAiModelInfo?.maxTokens && this.options.openAiModelInfo.maxTokens > 0) {
      maxTokens = Number(this.options.openAiModelInfo.maxTokens)
    } else {
      maxTokens = undefined
    }

    if (isDeepseekReasoner || isR1FormatRequired) {
      openAiMessages = convertToR1Format([{ role: 'user', content: systemPrompt }, ...messages])
    }

    if (isReasoningModelFamily) {
      openAiMessages = [{ role: 'developer', content: systemPrompt }, ...convertToOpenAiMessages(messages)]
      reasoningEffort = (this.options.o3MiniReasoningEffort as ChatCompletionReasoningEffort) || 'medium'
    }

    const stream = await this.client.chat.completions.create({
      model: modelId,
      messages: openAiMessages,
      ...(supportsTemperature && { temperature }),
      max_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
      ...(tools.length > 0 && {
        tools: this.toOpenAiTools(tools),
        tool_choice: this.toOpenAiToolChoice(request.toolChoice),
        parallel_tool_calls: false
      }),
      stream: true,
      stream_options: { include_usage: true }
    })
    const toolCallAccumulator = new OpenAiToolCallStreamAccumulator()
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      toolCallAccumulator.append(delta?.tool_calls)
      if (delta?.content) {
        yield {
          type: 'text',
          text: delta.content
        }
      }

      if (delta && 'reasoning_content' in delta && delta.reasoning_content) {
        yield {
          type: 'reasoning',
          reasoning: (delta.reasoning_content as string | undefined) || ''
        }
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0
        }
      }
    }

    for (const toolCall of toolCallAccumulator.flush('openai')) {
      if ('invalid' in toolCall) {
        yield { type: 'invalid_tool_call', id: toolCall.id, name: toolCall.name, rawArguments: toolCall.rawArguments, error: toolCall.error }
      } else {
        yield { type: 'tool_call', toolCall }
      }
    }
  }

  private async *createMessageViaResponses(request: ApiCreateMessageRequest): ApiStream {
    const { systemPrompt, messages, tools } = request
    const modelId = this.options.openAiModelId ?? ''
    const isReasoningModelFamily = modelId.includes('o1') || modelId.includes('o3') || modelId.includes('o4')
    const isGpt5OrAbove = modelId.startsWith('gpt-5') || modelId.startsWith('gpt-6')
    const supportsTemperature = !isReasoningModelFamily && !isGpt5OrAbove
    const temperature: number | undefined = this.options.openAiModelInfo?.temperature ?? openAiModelInfoSaneDefaults.temperature
    let maxTokens: number | undefined

    if (this.options.openAiModelInfo?.maxTokens && this.options.openAiModelInfo.maxTokens > 0) {
      maxTokens = Number(this.options.openAiModelInfo.maxTokens)
    } else {
      maxTokens = undefined
    }

    const input = convertToResponsesInput(messages)
    const responseInput = systemPrompt ? [{ role: 'developer' as const, content: systemPrompt }, ...input] : input

    const stream = await this.client.responses.create({
      model: modelId,
      input: responseInput,
      ...(tools.length > 0 && {
        tools: this.toResponsesTools(tools),
        tool_choice: this.toResponsesToolChoice(request.toolChoice),
        parallel_tool_calls: false
      }),
      ...(supportsTemperature && temperature !== undefined && { temperature }),
      ...(maxTokens !== undefined && { max_output_tokens: maxTokens }),
      stream: true
    })

    const responseCallArgs = new Map<string, { id: string; name?: string; arguments: string }>()

    for await (const event of stream) {
      const rawEvent = event as any
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text', text: event.delta }
      }

      if (event.type === 'response.reasoning_text.delta') {
        yield { type: 'reasoning', reasoning: event.delta }
      }

      if (event.type === 'response.completed') {
        const usage = event.response.usage
        yield {
          type: 'usage',
          inputTokens: usage?.input_tokens || 0,
          outputTokens: usage?.output_tokens || 0,
          reasoningTokens: usage?.output_tokens_details?.reasoning_tokens || 0
        }
      }

      if (rawEvent.type === 'response.output_item.added' && rawEvent.item?.type === 'function_call') {
        const item = rawEvent.item
        const id = item.call_id || item.id
        responseCallArgs.set(id, { id, name: item.name, arguments: item.arguments || '' })
      }

      if (rawEvent.type === 'response.function_call_arguments.delta') {
        const id = rawEvent.call_id || rawEvent.item_id || rawEvent.output_index?.toString()
        const current: { id: string; name?: string; arguments: string } = responseCallArgs.get(id) ?? { id, arguments: '' }
        current.arguments += rawEvent.delta || ''
        responseCallArgs.set(id, current)
      }

      if (rawEvent.type === 'response.function_call_arguments.done') {
        const id = rawEvent.call_id || rawEvent.item_id || rawEvent.output_index?.toString()
        const current: { id: string; name?: string; arguments: string } = responseCallArgs.get(id) ?? { id, arguments: '' }
        current.arguments = rawEvent.arguments ?? current.arguments
        if (rawEvent.name) current.name = rawEvent.name
        responseCallArgs.set(id, current)
      }

      if (rawEvent.type === 'response.output_item.done' && rawEvent.item?.type === 'function_call') {
        const item = rawEvent.item
        const id = item.call_id || item.id
        responseCallArgs.set(id, {
          id,
          name: item.name,
          arguments: item.arguments ?? responseCallArgs.get(id)?.arguments ?? ''
        })
      }
    }

    const accumulator = new OpenAiToolCallStreamAccumulator()
    let index = 0
    for (const call of responseCallArgs.values()) {
      accumulator.append([
        {
          index: index++,
          id: call.id,
          function: { name: call.name, arguments: call.arguments }
        }
      ])
    }
    for (const toolCall of accumulator.flush('openai_responses')) {
      if ('invalid' in toolCall) {
        yield { type: 'invalid_tool_call', id: toolCall.id, name: toolCall.name, rawArguments: toolCall.rawArguments, error: toolCall.error }
      } else {
        yield { type: 'tool_call', toolCall }
      }
    }
  }

  private toOpenAiTools(tools: NativeToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map(
      (tool) =>
        ({
          type: 'function',
          function: tool.function
        }) as unknown as OpenAI.Chat.ChatCompletionTool
    )
  }

  private toOpenAiToolChoice(toolChoice: NativeToolChoice): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
    if (toolChoice === 'none') return undefined
    return toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption
  }

  private toResponsesTools(tools: NativeToolDefinition[]): any[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: tool.function.strict
    }))
  }

  private toResponsesToolChoice(toolChoice: NativeToolChoice): any {
    if (toolChoice === 'none') return undefined
    if (typeof toolChoice === 'string') return toolChoice
    return { type: 'function', name: toolChoice.function.name }
  }

  getModel(): { id: string; info: ModelInfo } {
    return {
      id: this.options.openAiModelId ?? '',
      info: this.options.openAiModelInfo ?? openAiModelInfoSaneDefaults
    }
  }

  async validateApiKey(): Promise<{ isValid: boolean; error?: string }> {
    try {
      // Validate proxy
      if (this.options.needProxy) {
        await checkProxyConnectivity(this.options.proxyConfig!)
      }

      const useResponsesApi = this.options.openAiModelInfo?.apiFormat === 'responses'
      const validationMaxOutputTokens = 16

      if (useResponsesApi) {
        await this.client.responses.create({
          model: this.options.openAiModelId || '',
          input: 'test',
          max_output_tokens: validationMaxOutputTokens
        })
      } else {
        await this.client.chat.completions.create({
          model: this.options.openAiModelId || '',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: validationMaxOutputTokens
        })
      }
      return { isValid: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.includes('max_tokens or model output limit was reached')) {
        logger.warn('OpenAI compatible validation hit output limit, treating api key as valid', {
          model: this.options.openAiModelId,
          apiFormat: this.options.openAiModelInfo?.apiFormat
        })
        return { isValid: true }
      }
      logger.error('OpenAI compatible configuration validation failed', { error: error })
      return {
        isValid: false,
        error: `Validation failed:  ${errorMessage}`
      }
    }
  }
}
