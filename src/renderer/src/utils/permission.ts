import { userInfoStore } from '@/store/index'
import { pinia } from '@/main'
import { clearCurrentSession } from '@/services/yixinSessionService'

export const CtmTokenKey: string = 'Ctm-Token'

export function removeToken() {
  clearCurrentSession()
}

export const setUserInfo = (info) => {
  const userStore = userInfoStore(pinia)
  userStore.updateInfo(info)
}

export const getUserInfo = () => {
  const userStore = userInfoStore(pinia)
  return userStore.userInfo
}
