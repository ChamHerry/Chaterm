// Regression tests for the user-configured proxy agent factory.
//
// createProxyAgent must turn the user-selected proxy type into the matching
// URL scheme. Previously the scheme was hard-coded to `http://`, so selecting
// SOCKS4/SOCKS5 (the default in the AI settings) produced a `http://` URL and
// socks-proxy-agent v8 throws `TypeError: A "socks" protocol must be specified`
// at construction time — the AI provider handle failed to instantiate.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { httpCtor, httpsCtor, socksCtor } = vi.hoisted(() => ({
  httpCtor: vi.fn(),
  httpsCtor: vi.fn(),
  socksCtor: vi.fn()
}))

vi.mock('http-proxy-agent', () => ({ HttpProxyAgent: httpCtor }))
vi.mock('https-proxy-agent', () => ({ HttpsProxyAgent: httpsCtor }))
vi.mock('socks-proxy-agent', () => ({ SocksProxyAgent: socksCtor }))

import type { ProxyConfig } from '@shared/Proxy'
import { createProxyAgent } from './user-proxy'

function makeConfig(partial: Partial<ProxyConfig>): ProxyConfig {
  return { host: 'host', port: 8080, ...partial }
}

describe('createProxyAgent scheme mapping', () => {
  beforeEach(() => {
    httpCtor.mockClear()
    httpsCtor.mockClear()
    socksCtor.mockClear()
  })

  it('returns undefined when no config is provided', () => {
    expect(createProxyAgent()).toBeUndefined()
    expect(httpCtor).not.toHaveBeenCalled()
    expect(httpsCtor).not.toHaveBeenCalled()
    expect(socksCtor).not.toHaveBeenCalled()
  })

  it('maps HTTP type to an http:// URL', () => {
    const agent = createProxyAgent(makeConfig({ type: 'HTTP' }))
    expect(agent).toBeDefined()
    expect(httpCtor).toHaveBeenCalledWith('http://host:8080')
  })

  it('maps HTTPS type to an https:// URL', () => {
    createProxyAgent(makeConfig({ type: 'HTTPS' }))
    expect(httpsCtor).toHaveBeenCalledWith('https://host:8080')
  })

  it('maps SOCKS4 type to a socks4:// URL', () => {
    createProxyAgent(makeConfig({ type: 'SOCKS4' }))
    expect(socksCtor).toHaveBeenCalledWith('socks4://host:8080')
  })

  it('maps SOCKS5 type to a socks5:// URL instead of the previous hard-coded http://', () => {
    createProxyAgent(makeConfig({ type: 'SOCKS5' }))
    expect(socksCtor).toHaveBeenCalledWith('socks5://host:8080')
  })

  it('rejects an unknown type consistently with the pre-existing contract', () => {
    expect(() => createProxyAgent(makeConfig({ type: 'UNKNOWN' }))).toThrow('Unsupported proxy type: UNKNOWN')
    expect(httpCtor).not.toHaveBeenCalled()
    expect(socksCtor).not.toHaveBeenCalled()
  })

  it('URL-encodes proxy identity credentials and keeps the chosen scheme', () => {
    createProxyAgent(
      makeConfig({
        type: 'SOCKS5',
        enableProxyIdentity: true,
        username: 'u',
        password: 'p@ss'
      })
    )
    expect(socksCtor).toHaveBeenCalledWith('socks5://u:p%40ss@host:8080')
  })
})
