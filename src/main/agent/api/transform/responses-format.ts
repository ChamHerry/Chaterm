//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { Anthropic } from '@anthropic-ai/sdk'
import type OpenAI from 'openai'

type ResponseInputItem = OpenAI.Responses.ResponseInputItem

/**
 * Convert Anthropic messages to OpenAI Responses API input format.
 * The Responses API uses "easy input" messages with role/content pairs,
 * similar to Chat Completions but with different content block types
 * (input_text, input_image instead of text, image_url).
 */
export function convertToResponsesInput(anthropicMessages: Anthropic.Messages.MessageParam[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      const contentParts: Array<OpenAI.Responses.ResponseInputText | OpenAI.Responses.ResponseInputImage> = []

      for (const part of msg.content) {
        if (part.type === 'text') {
          contentParts.push({ type: 'input_text', text: part.text })
        } else if (part.type === 'image' && part.source.type === 'base64') {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${part.source.media_type};base64,${part.source.data}`,
            detail: 'auto'
          })
        } else if (part.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: part.tool_use_id,
            output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? [])
          } as unknown as ResponseInputItem)
        }
      }

      if (contentParts.length > 0) {
        input.push({ role: 'user', content: contentParts })
      }
    } else if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter((part): part is Anthropic.TextBlockParam => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

      if (textParts) {
        input.push({ role: 'assistant', content: textParts })
      }

      for (const part of msg.content) {
        if (part.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {})
          } as unknown as ResponseInputItem)
        }
      }
    }
  }

  return input
}
