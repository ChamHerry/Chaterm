import { hasPasswordPrompt, hasPasswordError, detectDirectConnectionReason } from './navigator'
import { hasUserSelectionPrompt } from './parser'
import { OutputParser } from './executor'
import {
  jumpserverConnections,
  jumpserverExecStreams,
  clearExecQueueState,
  decrementExecQueueDepth,
  deleteExecQueueTail,
  deleteExecStreamPromise,
  getExecQueueDepth,
  getExecQueueTail,
  getExecStreamPromise,
  incrementExecQueueDepth,
  setExecQueueTail,
  setExecStreamPromise
} from './state'
import { JUMPSERVER_CONSTANTS, type JumpServerNavigationPath } from './constants'
const logger = createLogger('jumpserver')

export type JumpServerExecCommandResult = {
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  exitSignal?: string
  error?: string
}

type JumpServerExecOptions = {
  connectionId?: string
  timeoutMs?: number
  kind?: 'command-list' | 'sudo-check' | 'system-info' | 'pid-probe' | 'cwd' | 'user-command'
}

export async function navigateToJumpServerAsset(
  stream: any,
  targetIp: string,
  navigationPath: JumpServerNavigationPath,
  jumpserverUuid: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputBuffer = ''
    let connectionPhase = 'connecting'
    let connectionEstablished = false

    const cleanup = () => {
      stream.removeListener('data', dataHandler)
      stream.removeListener('error', errorHandler)
      stream.removeListener('close', closeHandler)
    }

    const handleNavigationSuccess = (reason: string) => {
      if (connectionEstablished) return
      connectionEstablished = true
      logger.debug('JumpServer exec stream navigation successful', { event: 'jumpserver.exec.navigation.success', jumpserverUuid, reason })
      connectionPhase = 'connected'
      outputBuffer = ''
      cleanup()
      resolve()
    }

    const dataHandler = (data: Buffer) => {
      const ansiRegex = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nry=><]/g
      const chunk = data.toString().replace(ansiRegex, '')
      outputBuffer += chunk

      if (connectionPhase === 'connecting' && outputBuffer.includes('Opt>')) {
        logger.debug('JumpServer exec stream: Menu detected', { event: 'jumpserver.exec.menu.detected' })
        connectionPhase = 'inputIp'
        outputBuffer = ''
        stream.write(targetIp + '\r')
        return
      }

      if (connectionPhase === 'inputIp') {
        if (hasUserSelectionPrompt(outputBuffer)) {
          if (navigationPath.selectedUserId !== undefined) {
            logger.debug('JumpServer exec stream: User selection prompt detected, auto-selecting', {
              event: 'jumpserver.exec.user.autoselect',
              selectedUserId: navigationPath.selectedUserId
            })
            connectionPhase = 'selectUser'
            outputBuffer = ''
            stream.write(navigationPath.selectedUserId.toString() + '\r')
          } else {
            cleanup()
            reject(new Error('JumpServer exec stream: Multiple user scenario detected but selectedUserId not provided'))
          }
          return
        }

        if (hasPasswordPrompt(outputBuffer)) {
          if (navigationPath.password) {
            logger.debug('JumpServer exec stream: Password prompt detected, using saved password', { event: 'jumpserver.exec.auth.password' })
            connectionPhase = 'inputPassword'
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.password + '\r')
            }, JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            const reason = detectDirectConnectionReason(outputBuffer)
            if (reason) {
              logger.debug('JumpServer exec stream: No password, attempting direct connection', { event: 'jumpserver.exec.connect.direct', reason })
              handleNavigationSuccess(`Direct connection without password - ${reason}`)
            } else {
              logger.warn('JumpServer exec stream: Password required but not recorded', { event: 'jumpserver.exec.auth.missing' })
            }
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`No password required - ${reason}`)
        }
        return
      }

      if (connectionPhase === 'selectUser') {
        if (hasPasswordPrompt(outputBuffer)) {
          if (navigationPath.password) {
            logger.debug('JumpServer exec stream: Password prompt after user selection', { event: 'jumpserver.exec.auth.password' })
            connectionPhase = 'inputPassword'
            outputBuffer = ''
            setTimeout(() => {
              stream.write(navigationPath.password + '\r')
            }, JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
          } else {
            const reason = detectDirectConnectionReason(outputBuffer)
            if (reason) {
              logger.debug('JumpServer exec stream: No password after user selection, direct connection', {
                event: 'jumpserver.exec.connect.direct',
                reason
              })
              handleNavigationSuccess(`Direct connection without password after user selection - ${reason}`)
            } else {
              logger.warn('JumpServer exec stream: Password required after user selection but not recorded', {
                event: 'jumpserver.exec.auth.missing'
              })
            }
          }
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`After user selection - ${reason}`)
        }
        return
      }

      if (connectionPhase === 'inputPassword') {
        if (hasPasswordError(outputBuffer)) {
          cleanup()
          reject(new Error('JumpServer exec stream: Password authentication failed'))
          return
        }

        const reason = detectDirectConnectionReason(outputBuffer)
        if (reason) {
          handleNavigationSuccess(`After password verification - ${reason}`)
        }
      }
    }

    const errorHandler = (error: Error) => {
      logger.error('JumpServer exec stream navigation error', { event: 'jumpserver.exec.navigation.error', error: error.message })
      cleanup()
      clearTimeout(timeout)
      reject(error)
    }

    const closeHandler = () => {
      logger.debug('JumpServer exec stream closed during navigation', { event: 'jumpserver.exec.stream.close' })
      cleanup()
      if (connectionPhase !== 'connected') {
        clearTimeout(timeout)
        reject(new Error('exec stream closed before navigation completed'))
      }
    }

    stream.on('data', dataHandler)
    stream.on('error', errorHandler)
    stream.on('close', closeHandler)

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('JumpServer exec stream navigation timeout'))
    }, JUMPSERVER_CONSTANTS.NAVIGATION_TIMEOUT)
    const clearNavigationTimeout = () => clearTimeout(timeout)

    const originalResolve = resolve
    resolve = (value?: any) => {
      clearNavigationTimeout()
      originalResolve(value)
    }

    const originalReject = reject
    reject = (reason?: any) => {
      clearNavigationTimeout()
      originalReject(reason)
    }
  })
}

export async function createJumpServerExecStream(connectionId: string): Promise<any> {
  if (jumpserverExecStreams.has(connectionId)) {
    logger.debug('Reusing existing exec stream', { event: 'jumpserver.exec.reuse', connectionId })
    return jumpserverExecStreams.get(connectionId)
  }

  const existingPromise = getExecStreamPromise(connectionId)
  if (existingPromise) {
    logger.debug('Waiting for exec stream being created', { event: 'jumpserver.exec.wait', connectionId })
    return existingPromise
  }

  logger.debug('Starting to create new exec stream', { event: 'jumpserver.exec.create', connectionId })

  const creationPromise = (async () => {
    try {
      const connData = jumpserverConnections.get(connectionId)
      if (!connData) {
        logger.error('Connection data not found for exec stream', { event: 'jumpserver.exec.notfound', connectionId })
        throw new Error(`JumpServer connection not found: ${connectionId}`)
      }

      const { conn, jumpserverUuid, targetIp, navigationPath } = connData

      if (!targetIp) {
        logger.error('Target asset information missing', { event: 'jumpserver.exec.target.missing', connectionId })
        throw new Error(`JumpServer unable to get target asset information: ${connectionId}`)
      }

      if (!navigationPath) {
        logger.error('Navigation path not recorded', { event: 'jumpserver.exec.navpath.missing', connectionId })
        throw new Error(`JumpServer connection missing navigation path: ${connectionId}`)
      }

      const execStream: any = await new Promise((resolve, reject) => {
        conn.shell({ term: 'xterm-256color' }, (err: Error | undefined, stream: any) => {
          if (err) {
            logger.error('Exec stream creation failed', { event: 'jumpserver.exec.create.error', connectionId, error: err.message })
            reject(err)
          } else {
            resolve(stream)
          }
        })
      })

      await navigateToJumpServerAsset(execStream, targetIp, navigationPath, jumpserverUuid)

      jumpserverExecStreams.set(connectionId, execStream)

      execStream.on('close', () => {
        logger.debug('JumpServer exec stream closed', { event: 'jumpserver.exec.stream.close', connectionId })
        jumpserverExecStreams.delete(connectionId)
        deleteExecStreamPromise(connectionId)
      })

      execStream.on('error', (error: Error) => {
        logger.warn('JumpServer exec stream error', {
          event: 'jumpserver.exec.stream.error',
          connectionId,
          errorMessage: error.message
        })
        jumpserverExecStreams.delete(connectionId)
        deleteExecStreamPromise(connectionId)
      })

      deleteExecStreamPromise(connectionId)
      return execStream
    } catch (error) {
      deleteExecStreamPromise(connectionId)
      throw error
    }
  })()

  setExecStreamPromise(connectionId, creationPromise)
  return creationPromise
}

export async function executeCommandOnJumpServerExec(
  execStream: any,
  cmd: string,
  options: JumpServerExecOptions = {}
): Promise<JumpServerExecCommandResult> {
  return new Promise((resolve) => {
    const { marker, exitCodeMarker } = OutputParser.generateMarkers()

    let outputBuffer = ''
    let timeoutHandle: NodeJS.Timeout
    let settleTimer: NodeJS.Timeout | null = null
    let commandSent = false
    let settled = false
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs || JUMPSERVER_CONSTANTS.COMMAND_EXEC_TIMEOUT

    const finish = (result: JumpServerExecCommandResult) => {
      if (settled) return
      settled = true
      cleanup()
      logger.debug('JumpServer command finished', {
        event: 'jumpserver.exec.finish',
        connectionId: options.connectionId,
        kind: options.kind,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        stdoutLength: result.stdout?.length || 0,
        errorMessage: result.error
      })
      resolve(result)
    }

    const dataHandler = (data: Buffer) => {
      if (!commandSent) return

      const chunk = data.toString()
      outputBuffer += chunk

      const hasMarker = outputBuffer.includes(marker)
      const hasExitCode = new RegExp(`${exitCodeMarker}\\d+`).test(outputBuffer)

      if (hasMarker && hasExitCode) {
        settleTimer = setTimeout(() => {
          try {
            const markerPattern = new RegExp(`[\\r\\n]${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\r\\n]`)
            const markerMatch = outputBuffer.match(markerPattern)

            if (!markerMatch || markerMatch.index === undefined) {
              throw new Error('Marker not found or format incorrect')
            }

            const rawOutput = outputBuffer.substring(0, markerMatch.index + 1)
            const stdout = OutputParser.cleanCommandOutput(rawOutput)
            const exitCode = OutputParser.extractExitCode(outputBuffer, exitCodeMarker)

            finish({
              success: exitCode === 0,
              stdout,
              stderr: '',
              exitCode
            })
          } catch (parseError) {
            logger.error('Command output parsing error', {
              event: 'jumpserver.exec.parse.error',
              connectionId: options.connectionId,
              kind: options.kind,
              error: parseError
            })
            finish({
              success: false,
              error: `Failed to parse command output: ${parseError}`,
              stdout: outputBuffer,
              stderr: '',
              exitCode: undefined
            })
          }
        }, JUMPSERVER_CONSTANTS.DATA_SETTLE_DELAY)
      }
    }

    const errorHandler = (error: Error) => {
      logger.warn('JumpServer command stream error', {
        event: 'jumpserver.exec.error',
        connectionId: options.connectionId,
        kind: options.kind,
        errorMessage: error.message
      })
      finish({
        success: false,
        error: error.message || 'JumpServer exec stream error',
        stdout: outputBuffer,
        stderr: '',
        exitCode: undefined
      })
    }

    const closeHandler = () => {
      finish({
        success: false,
        error: 'JumpServer exec stream closed',
        stdout: outputBuffer,
        stderr: '',
        exitCode: undefined
      })
    }

    function cleanup() {
      execStream.removeListener('data', dataHandler)
      execStream.removeListener('error', errorHandler)
      execStream.removeListener('close', closeHandler)
      clearTimeout(timeoutHandle)
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    }

    timeoutHandle = setTimeout(() => {
      logger.warn('Command execution timeout', {
        event: 'jumpserver.exec.timeout',
        connectionId: options.connectionId,
        kind: options.kind,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        commandLength: cmd.length
      })
      finish({
        success: false,
        error: 'Command execution timeout',
        stdout: outputBuffer,
        stderr: '',
        exitCode: undefined
      })
    }, timeoutMs)

    execStream.on('data', dataHandler)
    execStream.once('error', errorHandler)
    execStream.once('close', closeHandler)

    // Leading space prevents the command from being recorded in shell history
    const fullCommand = ` ${cmd}; echo "${marker}"; echo "${exitCodeMarker}$?"\r`
    execStream.write(fullCommand)

    setTimeout(() => {
      commandSent = true
    }, JUMPSERVER_CONSTANTS.DATA_COLLECTION_DELAY)
  })
}

export async function executeCommandOnJumpServerExecQueued(
  connectionId: string,
  cmd: string,
  options: Omit<JumpServerExecOptions, 'connectionId'> = {}
): Promise<JumpServerExecCommandResult> {
  const previousTail = getExecQueueTail(connectionId) || Promise.resolve()
  const queueDepth = incrementExecQueueDepth(connectionId)
  const queuedAt = Date.now()

  const current = previousTail
    .catch(() => undefined)
    .then(async () => {
      const startedAt = Date.now()
      logger.debug('JumpServer command dequeued', {
        event: 'jumpserver.exec.queue.start',
        connectionId,
        kind: options.kind,
        queueDepth,
        queuedMs: startedAt - queuedAt,
        timeoutMs: options.timeoutMs || JUMPSERVER_CONSTANTS.COMMAND_EXEC_TIMEOUT,
        commandLength: cmd.length
      })

      let execStream: any
      try {
        execStream = await createJumpServerExecStream(connectionId)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.warn('JumpServer queued command could not create exec stream', {
          event: 'jumpserver.exec.queue.stream.error',
          connectionId,
          kind: options.kind,
          errorMessage,
          durationMs: Date.now() - startedAt
        })
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: undefined,
          error: `Failed to create exec stream: ${errorMessage}`
        }
      }

      const result = await executeCommandOnJumpServerExec(execStream, cmd, {
        ...options,
        connectionId
      })

      logger.debug('JumpServer command queue completed', {
        event: 'jumpserver.exec.queue.complete',
        connectionId,
        kind: options.kind,
        success: result.success,
        durationMs: Date.now() - startedAt,
        queueDepth: getExecQueueDepth(connectionId),
        stdoutLength: result.stdout?.length || 0,
        errorMessage: result.error
      })
      return result
    })

  const tail = current.then(
    () => undefined,
    () => undefined
  )
  setExecQueueTail(connectionId, tail)

  return current.finally(() => {
    const remainingDepth = decrementExecQueueDepth(connectionId)
    if (getExecQueueTail(connectionId) === tail && remainingDepth === 0) {
      deleteExecQueueTail(connectionId)
    }
  })
}

export function clearJumpServerExecState(connectionId: string) {
  jumpserverExecStreams.delete(connectionId)
  deleteExecStreamPromise(connectionId)
  clearExecQueueState(connectionId)
}
