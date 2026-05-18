import { getCurrentYixinUser, isYixinSessionToken, clearCurrentSession } from '@/services/yixinSessionService'

const logger = createRendererLogger('router')

export const beforeEach = async (to) => {
  if (to.path === '/login') {
    return true
  }

  const token = localStorage.getItem('ctm-token')
  if (!isYixinSessionToken(token)) {
    clearCurrentSession()
    return '/login'
  }

  try {
    const userInfo = getCurrentYixinUser()
    if (!userInfo?.uid) {
      clearCurrentSession()
      return '/login'
    }

    const api = window.api as any
    const dbResult = await api.initUserDatabase({ uid: userInfo.uid })
    if (dbResult.success) {
      return true
    }

    logger.error('Database initialization failed, redirecting to login page')
    clearCurrentSession()
    return '/login'
  } catch (error) {
    logger.error('Processing failed', { error })
    clearCurrentSession()
    return '/login'
  }
}

export const afterEach = () => {}
