import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { mockGetUserInfo } = vi.hoisted(() => ({
  mockGetUserInfo: vi.fn()
}))

vi.mock('@/locales', () => ({
  default: {
    global: {
      t: (key: string) =>
        ({
          'userInfo.personal': 'Personal User',
          'userInfo.name': 'Name',
          'userInfo.email': 'Email'
        })[key] || key
    }
  }
}))

vi.mock('@/utils/permission', () => ({
  getUserInfo: mockGetUserInfo
}))

import UserInfoComponent from '../userInfo.vue'

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../userInfo.vue'), 'utf8')

describe('UserInfo Component local YiXin contract', () => {
  let wrapper: VueWrapper<any> | undefined

  const createWrapper = () =>
    mount(UserInfoComponent, {
      global: {
        stubs: {
          'a-card': { template: '<div class="a-card"><slot /></div>' },
          'a-form': { template: '<form class="a-form"><slot /></form>' },
          'a-form-item': { template: '<div class="a-form-item"><slot /></div>' },
          'a-divider': { template: '<div class="a-divider" />' }
        }
      }
    })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInfo.mockReturnValue({
      uid: 1001,
      name: 'YiXin User',
      email: 'user@example.com',
      avatar: 'local-avatar.png'
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('does not import or call the legacy Chaterm user API', () => {
    expect(source).not.toContain('@api/user/user')
    expect(source).not.toContain('@/api/user/user')
    expect(source).not.toContain('getUser(')
    expect(source).not.toContain('updateUser')
    expect(source).not.toContain('changePassword')
    expect(source).not.toContain('updateAvatar')
  })

  it('renders cached local YiXin user information', async () => {
    wrapper = createWrapper()
    await flushPromises()

    expect(mockGetUserInfo).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('1001')
    expect(wrapper.text()).toContain('YiXin User')
    expect(wrapper.text()).toContain('user@example.com')
  })

  it('renders placeholders when local YiXin user fields are missing', async () => {
    mockGetUserInfo.mockReturnValue({ uid: 1002 })

    wrapper = createWrapper()
    await flushPromises()

    expect(wrapper.text()).toContain('1002')
    expect(wrapper.text()).toContain('-')
  })
})
