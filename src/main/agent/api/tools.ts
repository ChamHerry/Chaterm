// Copyright (c) 2025-present, chaterm.ai  All rights reserved.
// This source code is licensed under the GPL-3.0

import { Anthropic } from '@anthropic-ai/sdk'

export type JsonSchemaPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, JsonSchemaValue>
  required?: string[]
  additionalProperties?: boolean | JsonSchemaValue
  description?: string
}

export interface JsonSchemaValue {
  type?: JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[]
  description?: string
  enum?: Array<string | number | boolean | null>
  items?: JsonSchemaValue
  properties?: Record<string, JsonSchemaValue>
  required?: string[]
  additionalProperties?: boolean | JsonSchemaValue
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface NativeToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchemaObject
    strict?: boolean
  }
}

export type NativeToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }

export interface NativeToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  rawArguments?: string
  provider?: string
}

export interface ApiCreateMessageRequest {
  systemPrompt: string
  messages: Anthropic.Messages.MessageParam[]
  tools: NativeToolDefinition[]
  toolChoice: NativeToolChoice
  workspace?: string
  taskId?: string
}

export class ProviderToolCallingUnsupportedError extends Error {
  constructor(provider: string, modelId?: string) {
    super(`Provider '${provider}'${modelId ? ` model '${modelId}'` : ''} does not support native tool calling for this workspace.`)
    this.name = 'ProviderToolCallingUnsupportedError'
  }
}

export function createTextOnlyRequest(systemPrompt: string, messages: Anthropic.Messages.MessageParam[], taskId?: string): ApiCreateMessageRequest {
  return {
    systemPrompt,
    messages,
    tools: [],
    toolChoice: 'none',
    taskId
  }
}

export function toolResultContentToText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  return (
    content
      ?.map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'image') return '(image tool result omitted)'
        return ''
      })
      .filter(Boolean)
      .join('\n') ?? ''
  )
}

export function parseNativeToolArguments(
  rawArguments: string | undefined
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const raw = rawArguments && rawArguments.trim() !== '' ? rawArguments : '{}'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.' }
    }
    return { ok: true, input: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface OpenAiToolCallDelta {
  index?: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

interface OpenAiToolCallAccumulator {
  id?: string
  name?: string
  arguments: string
}

export class OpenAiToolCallStreamAccumulator {
  private readonly calls = new Map<number, OpenAiToolCallAccumulator>()

  append(deltaCalls: readonly OpenAiToolCallDelta[] | undefined): void {
    if (!deltaCalls) return

    for (const delta of deltaCalls) {
      const index = delta.index ?? 0
      const existing = this.calls.get(index) ?? { arguments: '' }

      if (delta.id) existing.id = delta.id
      if (delta.function?.name) existing.name = delta.function.name
      if (delta.function?.arguments) existing.arguments += delta.function.arguments

      this.calls.set(index, existing)
    }
  }

  flush(provider: string): Array<NativeToolCall | { invalid: true; id?: string; name?: string; rawArguments?: string; error: string }> {
    const result: Array<NativeToolCall | { invalid: true; id?: string; name?: string; rawArguments?: string; error: string }> = []
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b)

    for (const [index, call] of ordered) {
      const id = call.id || `${provider}_tool_call_${index}_${Date.now()}`
      const name = call.name
      if (!name) {
        result.push({ invalid: true, id, rawArguments: call.arguments, error: 'Tool call is missing a function name.' })
        continue
      }

      const parsed = parseNativeToolArguments(call.arguments)
      if (!parsed.ok) {
        result.push({ invalid: true, id, name, rawArguments: call.arguments, error: parsed.error })
        continue
      }

      result.push({
        id,
        name,
        input: parsed.input,
        rawArguments: call.arguments,
        provider
      })
    }

    this.calls.clear()
    return result
  }
}
