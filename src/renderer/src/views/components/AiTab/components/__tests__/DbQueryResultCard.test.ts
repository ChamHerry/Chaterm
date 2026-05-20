import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DbQueryResultCard from '../DbQueryResultCard.vue'

interface DbQueryResultView {
  engine: 'mysql' | 'postgresql'
  executedSql: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  durationMs: number
}

const clipboardWriteText = vi.fn()

const { antMessage } = vi.hoisted(() => ({
  antMessage: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('ant-design-vue', () => ({
  message: antMessage
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

const makeResult = (overrides: Partial<DbQueryResultView> = {}): DbQueryResultView => ({
  engine: 'postgresql' as const,
  executedSql: 'SELECT * FROM usage_records',
  columns: ['id'],
  rows: [{ id: 1 }],
  rowCount: 1,
  truncated: false,
  durationMs: 12,
  ...overrides
})

const mountCard = (result = makeResult()) =>
  mount(DbQueryResultCard, {
    props: { result },
    global: {
      stubs: {
        'a-table': {
          template: '<div class="a-table-stub" />'
        },
        'a-button': {
          inheritAttrs: false,
          emits: ['click'],
          template: '<button class="a-button" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'
        }
      }
    }
  })

describe('DbQueryResultCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: clipboardWriteText.mockResolvedValue(undefined) },
      configurable: true
    })
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => true),
      configurable: true
    })
  })

  it('renders the SQL block with a copy action for read-only SQL', () => {
    const wrapper = mountCard()

    expect(wrapper.find('.sql-block pre').text()).toBe('SELECT * FROM usage_records')
    expect(wrapper.find('.sql-title-action').exists()).toBe(true)
  })

  it('copies SQL through navigator.clipboard when available', async () => {
    const wrapper = mountCard()

    await wrapper.find('.sql-title-action').trigger('click')
    await flushPromises()

    expect(clipboardWriteText).toHaveBeenCalledWith('SELECT * FROM usage_records')
    expect(antMessage.success).toHaveBeenCalledWith('database.copiedToClipboard')
    expect(antMessage.error).not.toHaveBeenCalled()
  })

  it('falls back to document.execCommand when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: undefined,
      configurable: true
    })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true
    })

    const wrapper = mountCard()
    await wrapper.find('.sql-title-action').trigger('click')
    await flushPromises()

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(antMessage.success).toHaveBeenCalledWith('database.copiedToClipboard')
  })

  it('hides the SQL block for write statements', () => {
    const wrapper = mountCard(
      makeResult({
        executedSql: 'UPDATE usage_records SET count = 1'
      })
    )

    expect(wrapper.find('.sql-block').exists()).toBe(false)
    expect(wrapper.find('.sql-title-action').exists()).toBe(false)
  })
})
