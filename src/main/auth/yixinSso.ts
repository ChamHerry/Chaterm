import crypto from 'crypto'

export const YIXIN_DEFAULT_LOGIN_PATH = '/login'
export const YIXIN_DEFAULT_VALIDATE_PATH = '/serviceValidate'

export interface YixinSsoConfig {
  ssoBaseUrl: string
  loginPath?: string
  validatePath?: string
}

export interface YixinOnconUserInfo {
  onconUUID: string
  mobile: string
  enterCode: string
  workId: string
  domain: string
}

export interface ChatermYixinUserInfo {
  uid: number
  username: string
  name: string
  email: string
  mobile?: string
  token: string
  jmsToken: string
  registrationType: number
  provider: 'yixin'
  yixinUid: string
  enterCode?: string
  domain?: string
  isLocalSso: true
}

export type YixinValidateFetcher = (url: string) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '')

const normalizePath = (path: string | undefined, fallback: string): string => {
  const value = path?.trim() || fallback
  return value.startsWith('/') ? value : `/${value}`
}

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const extractTagText = (xml: string, tagName: string): string => {
  const tag = `(?:[A-Za-z_][\\w.-]*:)?${tagName}`
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? decodeXmlEntities(match[1].trim()) : ''
}

const extractTagBlock = (xml: string, tagName: string): string => {
  const tag = `(?:[A-Za-z_][\\w.-]*:)?${tagName}`
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? match[1] : ''
}

const extractAttribute = (xml: string, attributeName: string): string => {
  const match = xml.match(new RegExp(`\\b${attributeName}\\s*=\\s*(['"])(.*?)\\1`, 'i'))
  return match ? decodeXmlEntities(match[2]) : ''
}

const parseOnconContent = (content: string): YixinOnconUserInfo | null => {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<{
        onconUUID: string
        mobile: string
        enterCode: string
        workId: string
      }>
      if (parsed.onconUUID) {
        return {
          onconUUID: parsed.onconUUID,
          mobile: parsed.mobile || '',
          enterCode: parsed.enterCode || '',
          workId: parsed.workId || '',
          domain: ''
        }
      }
    } catch {
      // Fall through to comma-delimited parsing.
    }
  }

  const parts = trimmed.split(',')
  if (parts.length >= 7) {
    return {
      workId: parts[0] || '',
      domain: parts[2] || '',
      enterCode: parts[4] || '',
      mobile: parts[5] || '',
      onconUUID: parts[6] || ''
    }
  }

  return null
}

const parseOnconParam = (successXml: string): YixinOnconUserInfo => {
  const onconParam = extractAttribute(successXml, 'onconParam')
  if (onconParam) {
    const decoded = Buffer.from(onconParam, 'base64').toString('utf-8').trim()
    const parsed = parseOnconContent(decoded)
    if (!parsed) {
      throw new Error('YiXin SSO onconParam format is not recognized')
    }
    if (!parsed.onconUUID) {
      throw new Error('YiXin SSO onconParam is missing onconUUID')
    }
    return parsed
  }

  const user = extractTagText(successXml, 'user')
  if (user) {
    const parsed = parseOnconContent(user)
    if (parsed?.onconUUID) {
      return parsed
    }
    return {
      onconUUID: user,
      mobile: '',
      enterCode: '',
      workId: '',
      domain: ''
    }
  }

  throw new Error('YiXin SSO response does not contain user identity')
}

export const createYixinState = (): string => crypto.randomBytes(18).toString('base64url')

export const buildYixinLoopbackCallbackUrl = (port: number, callbackPath = '/auth/callback'): string => {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('YiXin SSO callback port is invalid')
  }
  const normalizedPath = normalizePath(callbackPath, '/auth/callback')
  return `http://127.0.0.1:${port}${normalizedPath}`
}

export const buildYixinServiceUrl = (callbackUrl: string, state: string): string => {
  const separator = callbackUrl.includes('?') ? '&' : '?'
  return `${callbackUrl}${separator}state=${encodeURIComponent(state)}`
}

export const buildYixinLoginUrl = (config: YixinSsoConfig, serviceUrl: string): string => {
  if (!config.ssoBaseUrl?.trim()) {
    throw new Error('YiXin SSO base URL is not configured')
  }
  const params = new URLSearchParams({ service: serviceUrl })
  return `${normalizeBaseUrl(config.ssoBaseUrl)}${normalizePath(config.loginPath, YIXIN_DEFAULT_LOGIN_PATH)}?${params.toString()}`
}

export const buildYixinValidateUrl = (config: YixinSsoConfig, ticket: string, serviceUrl: string): string => {
  if (!config.ssoBaseUrl?.trim()) {
    throw new Error('YiXin SSO base URL is not configured')
  }
  const params = new URLSearchParams({ ticket, service: serviceUrl })
  return `${normalizeBaseUrl(config.ssoBaseUrl)}${normalizePath(config.validatePath, YIXIN_DEFAULT_VALIDATE_PATH)}?${params.toString()}`
}

export const parseYixinServiceResponse = (xml: string): YixinOnconUserInfo => {
  const failureXml = extractTagBlock(xml, 'authenticationFailure')
  if (failureXml) {
    const message = failureXml.trim() ? decodeXmlEntities(failureXml.trim()) : 'Ticket validation failed'
    throw new Error(`YiXin SSO validation failed: ${message}`)
  }

  const successXml = extractTagBlock(xml, 'authenticationSuccess')
  if (!successXml) {
    throw new Error('YiXin SSO response format is invalid')
  }

  const userInfo = parseOnconParam(successXml)
  if (!userInfo.domain) {
    const user = extractTagText(successXml, 'user')
    const parts = user.split(',')
    if (parts.length >= 3 && parts[2]) {
      userInfo.domain = parts[2]
    }
  }

  return userInfo
}

export const validateYixinTicket = async (
  config: YixinSsoConfig,
  ticket: string,
  serviceUrl: string,
  fetcher: YixinValidateFetcher
): Promise<YixinOnconUserInfo> => {
  if (!ticket) {
    throw new Error('YiXin SSO ticket is missing')
  }
  if (!serviceUrl) {
    throw new Error('YiXin SSO service URL is missing')
  }

  const validateUrl = buildYixinValidateUrl(config, ticket, serviceUrl)
  const response = await fetcher(validateUrl)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`YiXin SSO validation request failed with HTTP ${response.status}`)
  }

  return parseYixinServiceResponse(body)
}

export const createYixinLocalUid = (identity: string): number => {
  if (!identity) {
    throw new Error('YiXin SSO identity is missing')
  }
  let hash = 2166136261
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return 1000000000 + ((hash >>> 0) % 1000000000)
}

export const createLocalYixinUserInfo = (onconUser: YixinOnconUserInfo): ChatermYixinUserInfo => {
  const name = onconUser.workId || onconUser.onconUUID
  const email =
    onconUser.workId && onconUser.domain
      ? `${onconUser.workId}@${onconUser.domain}`
      : onconUser.mobile
        ? `${onconUser.mobile}@yixin.local`
        : `${onconUser.onconUUID}@yixin.local`

  return {
    uid: createYixinLocalUid(onconUser.onconUUID),
    username: name,
    name,
    email,
    mobile: onconUser.mobile || undefined,
    token: `local_yixin_${crypto.randomBytes(24).toString('base64url')}`,
    jmsToken: '',
    registrationType: 1,
    provider: 'yixin',
    yixinUid: onconUser.onconUUID,
    enterCode: onconUser.enterCode || undefined,
    domain: onconUser.domain || undefined,
    isLocalSso: true
  }
}
