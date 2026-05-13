import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const { mockGetConfig, mockSaveConfig, mockSendToMain, mockEventOn, mockEventOff, mockNotificationError } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
  mockSendToMain: vi.fn(),
  mockEventOn: vi.fn(),
  mockEventOff: vi.fn(),
  mockNotificationError: vi.fn()
}))

const translations: Record<string, string> = {
  'user.privacy': '隐私',
  'user.telemetry': '遥测',
  'user.telemetryEnabled': '开启',
  'user.telemetryDisabled': '关闭',
  'user.telemetryDescriptionText': '遥测功能用于收集使用情况统计信息，帮助我们改进产品。',
  'user.secretRedaction': '密文脱敏',
  'user.secretRedactionEnabled': '开启',
  'user.secretRedactionDisabled': '关闭',
  'user.secretRedactionDescription': '密文脱敏功能旨在自动遮盖敏感信息。',
  'user.supportedPatterns': '支持的匹配模式',
  'user.loadConfigFailed': '加载配置失败',
  'user.loadConfigFailedDescription': '无法加载配置，请稍后重试',
  'user.error': '错误',
  'user.saveConfigFailedDescription': '保存配置失败，请稍后重试',
  'user.telemetryUpdateFailed': '遥测设置更新失败',
  'user.telemetryUpdateFailedDescription': '请稍后重试',
  'user.ipv4Address': 'IPv4 地址',
  'user.ipv6Address': 'IPv6 地址',
  'user.emailAddress': '邮箱地址',
  'user.openaiApiKey': 'OpenAI API Key',
  'user.anthropicApiKey': 'Anthropic API Key',
  'user.jsonWebToken': 'JSON Web Token'
}

const t = (key: string) => translations[key] || key

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

vi.mock('ant-design-vue', () => ({
  notification: {
    success: vi.fn(),
    error: mockNotificationError,
    config: vi.fn()
  }
}))

vi.mock('@/services/userConfigStoreService', () => ({
  userConfigStore: {
    getConfig: mockGetConfig,
    saveConfig: mockSaveConfig
  },
  remoteApplyGuard: {
    isApplying: false
  }
}))

vi.mock('@/utils/eventBus', () => ({
  default: {
    on: mockEventOn,
    off: mockEventOff
  }
}))

import PrivacyComponent from '../privacy.vue'

function withoutDataSync(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && !Object.prototype.hasOwnProperty.call(payload, 'dataSync')
}

describe('Privacy Component', () => {
  let wrapper: VueWrapper<any> | undefined

  const createWrapper = () =>
    mount(PrivacyComponent, {
      global: {
        stubs: {
          'a-card': { template: '<div class="a-card"><slot /></div>' },
          'a-form': { template: '<form class="a-form"><slot /></form>' },
          'a-form-item': { template: '<div class="a-form-item"><slot name="label" /><slot /></div>' },
          'a-radio-group': { template: '<div class="a-radio-group"><slot /></div>' },
          'a-radio': { template: '<label class="a-radio"><slot /></label>' },
          'a-collapse': { template: '<div class="a-collapse"><slot /></div>' },
          'a-collapse-panel': { template: '<div class="a-collapse-panel"><slot name="header" /><slot /></div>' }
        },
        mocks: { $t: t }
      }
    })

  const waitForUpdates = async () => {
    await flushPromises()
    await nextTick()
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ secretRedaction: 'enabled', telemetry: 'disabled' })
    mockSaveConfig.mockResolvedValue(undefined)
    mockSendToMain.mockResolvedValue(undefined)
    ;(globalThis as any).window = (globalThis as any).window || {}
    ;(globalThis as any).window.api = { sendToMain: mockSendToMain }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('renders only telemetry and secret-redaction privacy controls', async () => {
    wrapper = createWrapper()
    await waitForUpdates()

    expect(wrapper.text()).toContain('遥测')
    expect(wrapper.text()).toContain('密文脱敏')
    expect(wrapper.text()).not.toContain('数据同步')
    expect(wrapper.text()).not.toContain('注销账号')
    expect(wrapper.findAll('.a-radio-group')).toHaveLength(2)
  })

  it('loads and saves only local privacy config fields', async () => {
    wrapper = createWrapper()
    await waitForUpdates()

    const vm = wrapper.vm as any
    expect(mockGetConfig).toHaveBeenCalled()
    expect(vm.userConfig).toMatchObject({ secretRedaction: 'enabled', telemetry: 'disabled' })
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ secretRedaction: 'enabled', telemetry: 'disabled' }))
    expect(mockSaveConfig.mock.calls.every(([payload]) => withoutDataSync(payload))).toBe(true)
  })

  it('updates telemetry through main process and keeps the payload local', async () => {
    wrapper = createWrapper()
    await waitForUpdates()

    const vm = wrapper.vm as any
    vi.mocked(mockSaveConfig).mockClear()
    vm.userConfig.telemetry = 'enabled'
    await nextTick()

    await vm.updateTelemetry()

    expect(mockSendToMain).toHaveBeenCalledWith({
      type: 'telemetrySetting',
      telemetrySetting: 'enabled'
    })
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ telemetry: 'enabled' }))
    expect(mockSaveConfig.mock.calls.every(([payload]) => withoutDataSync(payload))).toBe(true)
  })

  it('does not expose removed data sync or remote account deletion handlers', async () => {
    wrapper = createWrapper()
    await waitForUpdates()

    const vm = wrapper.vm as any
    expect(vm.changeDataSync).toBeUndefined()
    expect(vm.openDeactivateModal).toBeUndefined()
    expect(vm.handleDeactivateAccount).toBeUndefined()
  })

  it('shows an error when telemetry update fails', async () => {
    wrapper = createWrapper()
    await waitForUpdates()

    const vm = wrapper.vm as any
    mockSendToMain.mockRejectedValueOnce(new Error('failed'))

    await vm.updateTelemetry()

    expect(mockNotificationError).toHaveBeenCalledWith({
      message: '遥测设置更新失败',
      description: '请稍后重试'
    })
  })
})
