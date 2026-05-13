import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../login.vue'), 'utf8')

describe('Login Component YiXin-only contract', () => {
  it('keeps YiXin SSO as the only login entry point', () => {
    expect(source).toContain('handleYixinLogin')
    expect(source).toContain('openYixinLogin')
    expect(source).toContain('login.yixinLogin')

    expect(source).not.toContain('userLogin')
    expect(source).not.toContain('emailLogin')
    expect(source).not.toContain('mobileLogin')
    expect(source).not.toContain('sendEmailCode')
    expect(source).not.toContain('sendMobileCode')
    expect(source).not.toContain('guest_token')
    expect(source).not.toContain('login-skipped')
  })

  it('stores YiXin callback data as a local session before entering the app', () => {
    expect(source).toContain('external-login-success')
    expect(source).toContain('external-login-error')
    expect(source).toContain('setCurrentYixinSession')
    expect(source).toContain('initUserDatabase')
    expect(source).toContain("router.replace('/')")
  })
})
