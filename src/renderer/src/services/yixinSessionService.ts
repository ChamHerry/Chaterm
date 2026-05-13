import { pinia } from '@/main'
import { userInfoStore } from '@/store/index'

export interface YixinSessionUserInfo {
  uid: number
  username?: string
  name?: string
  email?: string
  mobile?: string
  avatar?: string
  token: string
  jmsToken?: string
  provider?: 'yixin'
  yixinUid?: string
  enterCode?: string
  domain?: string
  isLocalSso?: true
  registrationType?: number | string
}

const SESSION_TOKEN_KEY = 'ctm-token'
const JMS_TOKEN_KEY = 'jms-token'
const LEGACY_BEARER_TOKEN_KEY = 'bearer-token'
const USER_INFO_KEY = 'userInfo'
const LOGIN_SKIPPED_KEY = 'login-skipped'

export const isYixinSessionToken = (token: string | null | undefined): boolean => Boolean(token?.startsWith('local_yixin_'))

const getUserStore = () => userInfoStore(pinia)

export const setCurrentYixinSession = (userInfo: YixinSessionUserInfo): void => {
  localStorage.setItem(SESSION_TOKEN_KEY, userInfo.token)
  localStorage.setItem(JMS_TOKEN_KEY, userInfo.jmsToken || '')
  localStorage.setItem(USER_INFO_KEY, JSON.stringify(userInfo))
  localStorage.removeItem(LOGIN_SKIPPED_KEY)
  localStorage.removeItem(LEGACY_BEARER_TOKEN_KEY)
  getUserStore().updateInfo(userInfo)
}

export const getCurrentYixinUser = (): YixinSessionUserInfo | null => {
  const token = localStorage.getItem(SESSION_TOKEN_KEY)
  if (!isYixinSessionToken(token)) {
    return null
  }

  const storeUser = getUserStore().userInfo as YixinSessionUserInfo | undefined
  if (storeUser?.uid && storeUser.token === token) {
    return storeUser
  }

  const raw = localStorage.getItem(USER_INFO_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as YixinSessionUserInfo
    if (parsed?.uid && parsed.token === token && isYixinSessionToken(parsed.token)) {
      getUserStore().updateInfo(parsed)
      return parsed
    }
  } catch {
    // Ignore corrupted local session data; caller will clear it.
  }

  return null
}

export const clearCurrentSession = (): void => {
  localStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(JMS_TOKEN_KEY)
  localStorage.removeItem(LEGACY_BEARER_TOKEN_KEY)
  localStorage.removeItem(USER_INFO_KEY)
  localStorage.removeItem(LOGIN_SKIPPED_KEY)
  getUserStore().deleteInfo()
}
