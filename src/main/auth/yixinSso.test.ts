import { describe, expect, it, vi } from 'vitest'
import {
  buildYixinLoopbackCallbackUrl,
  buildYixinLoginUrl,
  buildYixinServiceUrl,
  buildYixinValidateUrl,
  createLocalYixinUserInfo,
  parseYixinServiceResponse,
  validateYixinTicket
} from './yixinSso'

describe('yixinSso', () => {
  const config = {
    ssoBaseUrl: 'https://sso.teamshub.com',
    loginPath: '/login',
    validatePath: '/serviceValidate'
  }

  it('builds CAS login and validate URLs with the same service URL', () => {
    const callbackUrl = buildYixinLoopbackCallbackUrl(34567)
    const serviceUrl = buildYixinServiceUrl(callbackUrl, 'state-123')
    const loginUrl = buildYixinLoginUrl(config, serviceUrl)
    const validateUrl = buildYixinValidateUrl(config, 'ST-abc', serviceUrl)

    expect(callbackUrl).toBe('http://127.0.0.1:34567/auth/callback')
    expect(serviceUrl).toBe('http://127.0.0.1:34567/auth/callback?state=state-123')
    expect(loginUrl).toBe('https://sso.teamshub.com/login?service=http%3A%2F%2F127.0.0.1%3A34567%2Fauth%2Fcallback%3Fstate%3Dstate-123')
    expect(validateUrl).toBe(
      'https://sso.teamshub.com/serviceValidate?ticket=ST-abc&service=http%3A%2F%2F127.0.0.1%3A34567%2Fauth%2Fcallback%3Fstate%3Dstate-123'
    )
  })

  it('parses YiXin CAS success response with base64 onconParam', () => {
    const onconParam = Buffer.from('wangxc_a_bj,,si-tech.com.cn,1,10000,15501000400,oncon100000290136', 'utf-8').toString('base64')
    const userInfo = parseYixinServiceResponse(`
      <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
        <cas:authenticationSuccess>
          <cas:user>wangxc_a_bj,,si-tech.com.cn,1,10000,15501000400,oncon100000290136</cas:user>
          <cas:attributes>
            <cas:attribute onconParam="${onconParam}"></cas:attribute>
          </cas:attributes>
        </cas:authenticationSuccess>
      </cas:serviceResponse>
    `)

    expect(userInfo).toEqual({
      workId: 'wangxc_a_bj',
      domain: 'si-tech.com.cn',
      enterCode: '10000',
      mobile: '15501000400',
      onconUUID: 'oncon100000290136'
    })
  })

  it('validates ticket through injected fetcher and creates local Chaterm user info', async () => {
    const onconParam = Buffer.from(JSON.stringify({ workId: 'alice', enterCode: '10000', mobile: '13800138000', onconUUID: 'oncon-alice' })).toString(
      'base64'
    )
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationSuccess>
            <cas:attributes>
              <cas:attribute onconParam="${onconParam}"></cas:attribute>
            </cas:attributes>
          </cas:authenticationSuccess>
        </cas:serviceResponse>
      `
    }))

    const yixinUser = await validateYixinTicket(config, 'ST-ok', 'http://127.0.0.1:34567/auth/callback?state=s', fetcher)
    const localUser = createLocalYixinUserInfo(yixinUser)

    expect(fetcher).toHaveBeenCalledWith(
      'https://sso.teamshub.com/serviceValidate?ticket=ST-ok&service=http%3A%2F%2F127.0.0.1%3A34567%2Fauth%2Fcallback%3Fstate%3Ds'
    )
    expect(localUser).toMatchObject({
      username: 'alice',
      name: 'alice',
      email: '13800138000@yixin.local',
      mobile: '13800138000',
      registrationType: 1,
      provider: 'yixin',
      yixinUid: 'oncon-alice',
      isLocalSso: true
    })
    expect(localUser.uid).toBeGreaterThanOrEqual(1000000000)
    expect(localUser.token).toMatch(/^local_yixin_/)
  })
})
