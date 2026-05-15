import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeTermId, activeTermOndata, componentInstances, inputManager } from '../termInputManager'

vi.mock('@/utils/logger', () => ({
  createRendererLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('termInputManager', () => {
  afterEach(() => {
    componentInstances.value = []
    activeTermId.value = ''
    activeTermOndata.value = null
    vi.clearAllMocks()
  })

  it('ignores empty active terminal key without changing current active terminal', () => {
    const termOndata = vi.fn()
    inputManager.registerInstances({ termOndata }, 'tab-1')

    inputManager.setActiveTerm('')

    expect(activeTermId.value).toBe('tab-1')
    expect(activeTermOndata.value).toBe(termOndata)
  })

  it('registers and activates a terminal by stable key', () => {
    const termOndata = vi.fn()

    inputManager.registerInstances({ termOndata }, 'tab-stable-key')

    expect(componentInstances.value).toHaveLength(1)
    expect(activeTermId.value).toBe('tab-stable-key')
    expect(activeTermOndata.value).toBe(termOndata)
  })
})
