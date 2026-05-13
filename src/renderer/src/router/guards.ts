import { getCurrentYixinUser, isYixinSessionToken, clearCurrentSession } from '@/services/yixinSessionService'

const logger = createRendererLogger('router')

export const beforeEach = async (to, _from, next) => {
  if (to.path === '/login') {
    next()
    return
  }

  const token = localStorage.getItem('ctm-token')
  if (!isYixinSessionToken(token)) {
    clearCurrentSession()
    next('/login')
    return
  }

  try {
    const userInfo = getCurrentYixinUser()
    if (!userInfo?.uid) {
      clearCurrentSession()
      next('/login')
      return
    }

    const api = window.api as any
    const dbResult = await api.initUserDatabase({ uid: userInfo.uid })
    if (dbResult.success) {
      next()
      return
    }

    logger.error('Database initialization failed, redirecting to login page')
    clearCurrentSession()
    next('/login')
  } catch (error) {
    logger.error('Processing failed', { error })
    clearCurrentSession()
    next('/login')
  }
}

export const afterEach = () => {}
