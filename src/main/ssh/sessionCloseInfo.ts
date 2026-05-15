// Shared shell close classification helpers used by normal SSH and JumpServer.
// Renderer uses the payload to decide whether an automatic reconnect is safe.

const logger = createLogger('ssh')

export type ShellCloseReason = 'manual' | 'network' | 'unknown'

export type ShellCloseInfoPayload = {
  reason: ShellCloseReason
  isNetworkDisconnect: boolean
  errorCode?: string
  errorMessage?: string
}

export const manualDisconnectSessions = new Set<string>()
export const lastConnectionErrorBySession = new Map<string, { errorCode?: string; errorMessage?: string; isNetwork: boolean }>()
export const pendingShellCloseInfoBySession = new Map<string, ShellCloseInfoPayload>()

const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ECONNREFUSED'
])

const NETWORK_ERROR_PATTERNS = [
  /timed out/i,
  /keepalive/i,
  /connection lost/i,
  /connection reset/i,
  /socket hang up/i,
  /network is unreachable/i,
  /not reachable/i,
  /broken pipe/i
]

export const isLikelyNetworkDisconnect = (err: any): boolean => {
  const code = String(err?.code || err?.errno || '').toUpperCase()
  const message = String(err?.message || '')

  if (code && NETWORK_ERROR_CODES.has(code)) {
    return true
  }

  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

export const setPendingShellCloseInfo = (sessionId: string, info: ShellCloseInfoPayload) => {
  if (!sessionId) return
  pendingShellCloseInfoBySession.set(sessionId, info)
  logger.info('Pending shell close info updated', {
    event: 'ssh.shell.close.pending',
    connectionId: sessionId,
    reason: info.reason,
    isNetworkDisconnect: info.isNetworkDisconnect,
    errorCode: info.errorCode,
    errorMessage: info.errorMessage
  })
}

export const recordSessionConnectionError = (sessionId: string, err: any) => {
  if (!sessionId) return
  const errorCode = String(err?.code || err?.errno || '').toUpperCase() || undefined
  const errorMessage = String(err?.message || '').trim() || undefined
  const isNetwork = isLikelyNetworkDisconnect(err)

  lastConnectionErrorBySession.set(sessionId, {
    errorCode,
    errorMessage,
    isNetwork
  })

  setPendingShellCloseInfo(sessionId, {
    reason: isNetwork ? 'network' : 'unknown',
    isNetworkDisconnect: isNetwork,
    errorCode,
    errorMessage
  })

  logger.info('Session connection error recorded', {
    event: 'ssh.session.error.recorded',
    connectionId: sessionId,
    errorCode,
    errorMessage,
    isNetworkDisconnect: isNetwork
  })
}

export const clearSessionConnectionState = (sessionId: string) => {
  if (!sessionId) return
  manualDisconnectSessions.delete(sessionId)
  lastConnectionErrorBySession.delete(sessionId)
  pendingShellCloseInfoBySession.delete(sessionId)
}

export const markSessionManualDisconnect = (sessionId: string) => {
  if (!sessionId) return
  manualDisconnectSessions.add(sessionId)
  setPendingShellCloseInfo(sessionId, {
    reason: 'manual',
    isNetworkDisconnect: false
  })
}

export const consumeShellCloseInfo = (sessionId: string): ShellCloseInfoPayload => {
  if (!sessionId) {
    return { reason: 'unknown', isNetworkDisconnect: false }
  }

  if (manualDisconnectSessions.has(sessionId)) {
    clearSessionConnectionState(sessionId)
    return {
      reason: 'manual',
      isNetworkDisconnect: false
    }
  }

  const pending = pendingShellCloseInfoBySession.get(sessionId)
  if (pending) {
    pendingShellCloseInfoBySession.delete(sessionId)
    lastConnectionErrorBySession.delete(sessionId)
    return pending
  }

  const lastError = lastConnectionErrorBySession.get(sessionId)
  if (lastError) {
    lastConnectionErrorBySession.delete(sessionId)
    return {
      reason: lastError.isNetwork ? 'network' : 'unknown',
      isNetworkDisconnect: lastError.isNetwork,
      errorCode: lastError.errorCode,
      errorMessage: lastError.errorMessage
    }
  }

  return { reason: 'unknown', isNetworkDisconnect: false }
}
