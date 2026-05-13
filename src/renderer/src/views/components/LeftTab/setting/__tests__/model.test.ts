import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const modelSource = readFileSync(resolve(dir, '../model.vue'), 'utf8')
const modelConfigSource = readFileSync(resolve(dir, '../../../AiTab/composables/useModelConfiguration.ts'), 'utf8')

describe('Model settings YiXin-only contract', () => {
  it('does not bootstrap models from the legacy Chaterm user API', () => {
    const combined = `${modelSource}\n${modelConfigSource}`

    expect(combined).not.toContain('@api/user/user')
    expect(combined).not.toContain('@/api/user/user')
    expect(combined).not.toContain('getUser(')
    expect(combined).not.toContain('llmGatewayAddr')
    expect(combined).not.toContain('defaultApiKey')
    expect(combined).not.toContain('login-skipped')
  })

  it('keeps user-configured provider settings as the model source', () => {
    expect(modelSource).toContain('openAiBaseUrl')
    expect(modelSource).toContain('openAiApiKey')
    expect(modelSource).toContain('anthropicApiKey')
    expect(modelSource).toContain('liteLlmBaseUrl')
    expect(modelConfigSource).toContain('getGlobalState')
    expect(modelConfigSource).toContain('storeSecret')
  })
})
