import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: any, payload?: any) => any

class FakeJumpServerStream extends EventEmitter {
  public stderr = new EventEmitter()
  public windowSizes: Array<{ rows: number; cols: number }> = []

  setWindow(rows: number, cols: number) {
    this.windowSizes.push({ rows, cols })
  }

  write(_data: unknown, cb?: (err?: Error) => void) {
    cb?.()
  }

  end() {
    this.emit('close')
  }
}

class FakeJumpServerClient extends EventEmitter {
  end() {
    this.emit('close')
  }
}

const setupHandlers = async () => {
  vi.resetModules()

  const handlers = new Map<string, IpcHandler>()
  const ipcMainMock = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn()
  }
  const appMock = { getAppPath: () => process.cwd() }

  vi.doMock('electron', () => ({
    app: appMock,
    ipcMain: ipcMainMock,
    BrowserWindow: {
      fromWebContents: vi.fn(() => ({}))
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    default: {
      app: appMock,
      ipcMain: ipcMainMock
    }
  }))

  vi.doMock('ssh2', () => ({
    Client: vi.fn()
  }))

  vi.doMock('../proxy', () => ({
    createProxySocket: vi.fn()
  }))

  vi.doMock('../jumpserver/errorUtils', () => ({
    buildErrorResponse: vi.fn((error: unknown) => ({
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }))
  }))

  const jumpserverConnections = new Map<string, any>()
  const jumpserverShellStreams = new Map<string, any>()
  const jumpserverExecStreams = new Map<string, any>()
  const jumpserverConnectionStatus = new Map<string, any>()
  const jumpserverLastCommand = new Map<string, any>()
  const jumpserverInputBuffer = new Map<string, any>()

  vi.doMock('../jumpserverHandle', () => ({
    jumpserverConnections,
    handleJumpServerConnection: vi.fn(),
    jumpserverShellStreams,
    jumpserverExecStreams,
    jumpserverMarkedCommands: new Map(),
    jumpserverConnectionStatus,
    jumpserverLastCommand,
    jumpserverInputBuffer,
    createJumpServerExecStream: vi.fn(),
    executeCommandOnJumpServerExec: vi.fn(),
    executeCommandOnJumpServerExecQueued: vi.fn(),
    clearJumpServerExecState: vi.fn((id: string) => {
      jumpserverExecStreams.delete(id)
    }),
    jumpserverSessionPids: new Map()
  }))

  vi.doMock('../algorithms', () => ({
    getAlgorithmsByAssetType: vi.fn(() => undefined)
  }))

  vi.doMock('../bastionPlugin', () => ({
    connectBastionByType: vi.fn(async () => null),
    shellBastionSession: vi.fn(async () => null),
    resizeBastionSession: vi.fn(async () => null),
    writeBastionSession: vi.fn(async () => null),
    disconnectBastionSession: vi.fn(async () => null)
  }))

  vi.doMock('../postConnectProbePolicy', () => ({
    shouldSkipPostConnectProbe: vi.fn(() => true)
  }))

  vi.doMock('../sftpTransfer', () => ({
    sftpConnectionInfoMap: new Map()
  }))

  vi.doMock('../ssh-agent/ChatermSSHAgent', () => ({
    SSHAgentManager: {
      getInstance: vi.fn(() => ({
        getAgent: vi.fn(),
        enableAgent: vi.fn(),
        addKey: vi.fn(),
        removeKey: vi.fn(),
        listKeys: vi.fn(() => [])
      }))
    }
  }))

  vi.doMock('@logging/index', () => ({
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }))
  }))

  const sshHandle = await import('../sshHandle')
  sshHandle.registerSSHHandlers()

  return {
    handlers,
    jumpserverConnections,
    jumpserverShellStreams
  }
}

const getCloseInfo = (sendSpy: ReturnType<typeof vi.fn>, id: string) => {
  const closeCalls = sendSpy.mock.calls.filter((call) => call[0] === `ssh:shell:close:${id}`)
  expect(closeCalls.length).toBeGreaterThan(0)
  return closeCalls[closeCalls.length - 1][1]
}

describe('sshHandle JumpServer close classification', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits network close info for JumpServer stream ETIMEDOUT errors', async () => {
    const { handlers, jumpserverConnections, jumpserverShellStreams } = await setupHandlers()
    const id = 'jump-network'
    const stream = new FakeJumpServerStream()
    const conn = new FakeJumpServerClient()
    jumpserverConnections.set(id, { conn, stream })
    jumpserverShellStreams.set(id, stream)

    const sendSpy = vi.fn()
    const shellHandler = handlers.get('ssh:shell')
    expect(shellHandler).toBeTypeOf('function')
    await shellHandler!({ sender: { send: sendSpy } }, { id, terminalType: 'xterm-256color' })

    stream.emit('error', { code: 'ETIMEDOUT', message: 'read ETIMEDOUT' })
    stream.emit('close')

    expect(getCloseInfo(sendSpy, id)).toMatchObject({
      reason: 'network',
      isNetworkDisconnect: true,
      errorCode: 'ETIMEDOUT'
    })
  })

  it('emits manual close info for explicit JumpServer disconnect', async () => {
    const { handlers, jumpserverConnections, jumpserverShellStreams } = await setupHandlers()
    const id = 'jump-manual'
    const stream = new FakeJumpServerStream()
    const conn = new FakeJumpServerClient()
    jumpserverConnections.set(id, { conn, stream })
    jumpserverShellStreams.set(id, stream)

    const sendSpy = vi.fn()
    await handlers.get('ssh:shell')!({ sender: { send: sendSpy } }, { id, terminalType: 'xterm-256color' })

    const result = await handlers.get('ssh:disconnect')!({}, { id })

    expect(result).toMatchObject({ status: 'success' })
    expect(getCloseInfo(sendSpy, id)).toEqual({
      reason: 'manual',
      isNetworkDisconnect: false
    })
  })

  it('defers JumpServer resize when shell stream is not ready yet', async () => {
    const { handlers, jumpserverConnections } = await setupHandlers()
    const id = 'jump-resize-deferred'
    jumpserverConnections.set(id, { conn: new FakeJumpServerClient() })

    const result = await handlers.get('ssh:shell:resize')!({}, { id, cols: 120, rows: 40 })

    expect(result).toEqual({ status: 'deferred', message: 'JumpServer Shell not ready' })
  })
})
