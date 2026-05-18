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
  rawArguments: string | undefined,
  toolName?: string
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const raw = rawArguments && rawArguments.trim() !== '' ? rawArguments : '{}'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.' }
    }
    return { ok: true, input: parsed as Record<string, unknown> }
  } catch (error) {
    const repaired = repairNativeToolArguments(raw, toolName)
    if (repaired) {
      return { ok: true, input: repaired }
    }

    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function repairNativeToolArguments(raw: string, toolName?: string): Record<string, unknown> | undefined {
  if (toolName !== 'execute_command') return undefined

  const repaired = parseLooseFlatJsonObject(raw, ['ip', 'command', 'requires_approval', 'interactive', 'depositExperience'])
  if (!repaired || typeof repaired.command !== 'string' || typeof repaired.ip !== 'string') {
    return undefined
  }

  // Repaired command arguments are best-effort recovery from malformed JSON.
  // Keep execution behind explicit approval even if the malformed payload tried
  // to mark the command as safe.
  repaired.requires_approval = true
  return repaired
}

function parseLooseFlatJsonObject(raw: string, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined

  const expected = new Set(expectedKeys)
  const keyMatches = [...trimmed.matchAll(/"([^"\\]+)"\s*:/g)]
    .map((match) => ({
      key: match[1],
      index: match.index ?? -1,
      token: match[0]
    }))
    .filter((match) => match.index >= 0 && expected.has(match.key))

  if (keyMatches.length === 0) return undefined

  const result: Record<string, unknown> = {}
  for (let i = 0; i < keyMatches.length; i++) {
    const current = keyMatches[i]
    const next = keyMatches[i + 1]
    const valueStart = skipWhitespace(trimmed, current.index + current.token.length)
    if (valueStart >= trimmed.length) return undefined

    if (trimmed[valueStart] === '"') {
      const endQuote = findLooseStringEnd(trimmed, valueStart + 1, next?.index)
      if (endQuote === -1) return undefined

      const rawValue = trimmed.slice(valueStart + 1, endQuote)
      const parsedValue = parseLooseStringValue(rawValue)
      if (parsedValue === undefined) return undefined
      result[current.key] = parsedValue
      continue
    }

    const valueEnd = findLooseScalarEnd(trimmed, valueStart, next?.index)
    if (valueEnd === -1) return undefined
    const rawValue = trimmed.slice(valueStart, valueEnd).trim().replace(/,$/, '').trim()
    try {
      result[current.key] = JSON.parse(rawValue)
    } catch {
      return undefined
    }
  }

  return result
}

function skipWhitespace(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index])) {
    index++
  }
  return index
}

function findLooseStringEnd(raw: string, contentStart: number, nextKeyIndex?: number): number {
  if (nextKeyIndex !== undefined) {
    const commaIndex = raw.lastIndexOf(',', nextKeyIndex)
    const searchEnd = commaIndex >= contentStart ? commaIndex : nextKeyIndex
    const quoteBeforeNextKey = findLastNonWhitespaceQuote(raw, searchEnd - 1)
    if (quoteBeforeNextKey !== -1) return quoteBeforeNextKey
  }

  const objectEnd = raw.lastIndexOf('}')
  if (objectEnd <= contentStart) return -1
  return findLastNonWhitespaceQuote(raw, objectEnd - 1)
}

function findLooseScalarEnd(raw: string, valueStart: number, nextKeyIndex?: number): number {
  if (nextKeyIndex !== undefined) {
    const commaIndex = raw.lastIndexOf(',', nextKeyIndex)
    return commaIndex >= valueStart ? commaIndex : nextKeyIndex
  }

  const objectEnd = raw.lastIndexOf('}')
  return objectEnd > valueStart ? objectEnd : -1
}

function findLastNonWhitespaceQuote(raw: string, start: number): number {
  let index = start
  while (index >= 0 && /\s/.test(raw[index])) {
    index--
  }
  return raw[index] === '"' ? index : -1
}

function parseLooseStringValue(rawValue: string): string | undefined {
  let escaped = ''
  for (let index = 0; index < rawValue.length; index++) {
    const char = rawValue[index]
    if (char === '"') {
      escaped += '\\"'
      continue
    }

    if (char === '\\') {
      const next = rawValue[index + 1]
      if (!next) {
        escaped += '\\\\'
      } else if ('"\\/bfnrt'.includes(next)) {
        escaped += char + next
        index++
      } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(rawValue.slice(index + 2, index + 6))) {
        escaped += rawValue.slice(index, index + 6)
        index += 5
      } else {
        escaped += '\\\\'
      }
      continue
    }

    if (char === '\n') {
      escaped += '\\n'
    } else if (char === '\r') {
      escaped += '\\r'
    } else if (char === '\t') {
      escaped += '\\t'
    } else {
      escaped += char
    }
  }

  try {
    return JSON.parse(`"${escaped}"`) as string
  } catch {
    return undefined
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

      const parsed = parseNativeToolArguments(call.arguments, name)
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
