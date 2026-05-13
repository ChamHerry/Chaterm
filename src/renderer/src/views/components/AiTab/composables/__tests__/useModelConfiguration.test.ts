import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../useModelConfiguration.ts'), 'utf8')

describe('useModelConfiguration YiXin-only contract', () => {
  it('does not request server-side account models or gateway keys', () => {
    expect(source).not.toContain('@api/user/user')
    expect(source).not.toContain('@/api/user/user')
    expect(source).not.toContain('getUser(')
    expect(source).not.toContain('subscriptionModels')
    expect(source).not.toContain('llmGatewayAddr')
    expect(source).not.toContain('defaultApiKey')
    expect(source).not.toContain('login-skipped')
  })

  it('initializes available models from local global state only', () => {
    expect(source).toContain("getGlobalState('modelOptions')")
    expect(source).toContain("updateGlobalState('apiProvider'")
    expect(source).toContain('checkModelConfig')
  })
})
