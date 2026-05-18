import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

type IpcHandler = (event: any, payload?: any) => any

const setupSftpHandlers = async (sshClientFactory?: () => any) => {
  vi.resetModules()

  const handlers = new Map<string, IpcHandler>()
  const sftpConnections = new Map<string, any>()
  const sshConnections = new Map<string, any>()
  const connectionStatus = new Map<string, any>()
  const jumpserverConnections = new Map<string, any>()

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn(() => '/tmp') },
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler)
      })
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

  vi.doMock('../sshHandle', () => ({
    getSftpConnection: vi.fn((id: string) => {
      const record = sftpConnections.get(id)
      return record?.isSuccess ? record.sftp : null
    }),
    getUniqueRemoteName: vi.fn(async (_sftp: any, _remoteDir: string, originalName: string) => originalName),
    pickReconnectConnectionInfo: vi.fn((connectionInfo: any) => connectionInfo),
    connectionStatus,
    sftpConnections,
    sshConnections,
    sshConnectionPool: new Map(),
    KeyboardInteractiveTimeout: 1000,
    handleRequestKeyboardInteractive: vi.fn(),
    getConnectionPoolKey: vi.fn((host: string, port: number, username: string) => `${username}@${host}:${port}`),
    createProxyCommandSocket: vi.fn()
  }))

  vi.doMock('../jumpserverHandle', () => ({
    jumpserverConnections
  }))

  vi.doMock('../proxy', () => ({
    createProxySocket: vi.fn()
  }))

  vi.doMock('../algorithms', () => ({
    getAlgorithmsByAssetType: vi.fn(() => undefined)
  }))

  vi.doMock('../jumpserver/connectionManager', () => ({
    getPackageInfo: vi.fn(() => ({ name: 'chaterm-test', version: '0.0.0' }))
  }))

  const ClientMock = vi.fn(function MockClient() {
    return sshClientFactory?.()
  })
  vi.doMock('ssh2', () => ({
    Client: ClientMock
  }))

  const module = await import('../sftpTransfer')
  module.registerFileSystemHandlers()

  return {
    handlers,
    sftpConnections,
    sshConnections,
    connectionStatus,
    jumpserverConnections,
    ClientMock
  }
}

describe('sftpTransfer reconnect', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('recreates a missing SFTP wrapper from a live SSH connection before file operations', async () => {
    const { handlers, sftpConnections, sshConnections, connectionStatus } = await setupSftpHandlers()
    const id = 'user@host:local:aG9zdA==:session-1'
    const unlink = vi.fn((_: string, cb: (err?: Error | null) => void) => cb(null))
    const sftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => cb(null, [])),
      unlink,
      end: vi.fn()
    }
    const conn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    }

    sshConnections.set(id, conn)

    const handler = handlers.get('ssh:sftp:delete-file')
    expect(handler).toBeTypeOf('function')

    const result = await handler!({ sender: { send: vi.fn() } }, { id, remotePath: '/tmp/a.txt' })

    expect(result).toMatchObject({ status: 'success', deletedPath: '/tmp/a.txt' })
    expect(conn.sftp).toHaveBeenCalledTimes(1)
    expect(unlink).toHaveBeenCalledWith('/tmp/a.txt', expect.any(Function))
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp })
    expect(connectionStatus.get(id)).toMatchObject({ sftpAvailable: true })
  })

  it('recreates a missing SFTP wrapper from a live JumpServer connection by exact id', async () => {
    const { handlers, sftpConnections, jumpserverConnections } = await setupSftpHandlers()
    const id = 'user@host:local-team:aG9zdA==:session-1'
    const sftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => cb(null, [])),
      unlink: vi.fn((_: string, cb: (err?: Error | null) => void) => cb(null)),
      end: vi.fn()
    }
    const conn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    }

    jumpserverConnections.set(id, { conn })

    const handler = handlers.get('ssh:sftp:delete-file')
    expect(handler).toBeTypeOf('function')

    const result = await handler!({ sender: { send: vi.fn() } }, { id, remotePath: '/tmp/a.txt' })

    expect(result).toMatchObject({ status: 'success' })
    expect(conn.sftp).toHaveBeenCalledTimes(1)
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp })
  })

  it('recreates a missing SFTP wrapper from an SFTP-owned JumpServer transport', async () => {
    const id = 'user@host:local-team:aG9zdA==:files-left'
    const firstSftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => cb(null, [])),
      end: vi.fn()
    }
    const secondSftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => cb(null, [])),
      unlink: vi.fn((_: string, cb: (err?: Error | null) => void) => cb(null)),
      end: vi.fn()
    }
    const sftpQueue = [firstSftp, secondSftp]
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn((_opts: any, cb: (err: Error | null, stream: any) => void) => cb(null, new EventEmitter()))
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftpQueue.shift()))
    conn.end = vi.fn()

    const { handlers, sftpConnections } = await setupSftpHandlers(() => conn)
    const connectHandler = handlers.get('ssh:sftp:connect')
    const deleteHandler = handlers.get('ssh:sftp:delete-file')
    expect(connectHandler).toBeTypeOf('function')
    expect(deleteHandler).toBeTypeOf('function')

    const connectResult = await connectHandler!(
      { sender: { send: vi.fn() } },
      { id, sshType: 'jumpserver', host: 'host', username: 'user', password: 'pw' }
    )
    expect(connectResult).toMatchObject({ status: 'connected' })
    expect(conn.shell).not.toHaveBeenCalled()
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp: firstSftp })

    sftpConnections.delete(id)
    const deleteResult = await deleteHandler!({ sender: { send: vi.fn() } }, { id, remotePath: '/tmp/a.txt' })

    expect(deleteResult).toMatchObject({ status: 'success', deletedPath: '/tmp/a.txt' })
    expect(conn.sftp).toHaveBeenCalledTimes(2)
    expect(secondSftp.unlink).toHaveBeenCalledWith('/tmp/a.txt', expect.any(Function))
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp: secondSftp })
  })

  it('connects JumpServer direct asset SFTP without opening a shell or reusing an interactive JumpServer session', async () => {
    const id = 'user@bastion:local-team:YmFzdGlvbg==:files-left'
    const sftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => cb(null, [])),
      end: vi.fn()
    }
    const ordinaryJumpServerConn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn()
    }
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn()
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    conn.end = vi.fn()

    const { handlers, sftpConnections, jumpserverConnections } = await setupSftpHandlers(() => conn)
    jumpserverConnections.set(id, { conn: ordinaryJumpServerConn, jumpserverUuid: 'bastion-uuid' })

    const connectHandler = handlers.get('ssh:sftp:connect')
    expect(connectHandler).toBeTypeOf('function')

    const connectResult = await connectHandler!(
      { sender: { send: vi.fn() } },
      {
        id,
        sshType: 'jumpserver',
        host: 'bastion',
        username: 'jms-user',
        password: 'pw',
        assetUuid: 'bastion-uuid',
        targetAssetUuid: 'asset-uuid',
        targetAccountUsername: 'root'
      }
    )

    expect(connectResult).toMatchObject({ status: 'connected' })
    expect(ordinaryJumpServerConn.sftp).not.toHaveBeenCalled()
    expect(conn.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'jms-user@sftp@root@asset-uuid' }))
    expect(conn.shell).not.toHaveBeenCalled()
    expect(conn.sftp).toHaveBeenCalledTimes(1)
    expect(sftpConnections.get(id)).toMatchObject({
      isSuccess: true,
      sftp,
      provider: 'jumpserver-direct-asset',
      targetAsset: 'asset-uuid',
      targetAccountUsername: 'root'
    })
  })

  it('maps JumpServer root-tree SFTP to the target asset virtual path when account is missing', async () => {
    const id = 'user@bastion:local-team:YmFzdGlvbg==:files-left'
    const attrs = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      mtime: 0,
      size: 0
    }
    const dir = (filename: string) => ({ filename, attrs })
    const ordinaryJumpServerConn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn()
    }
    const sftp = {
      readdir: vi.fn((path: string, cb: (err: Error | null, list?: any[]) => void) => {
        const tree: Record<string, any[]> = {
          '/': [dir('Default')],
          '/Default': [dir('Group')],
          '/Default/Group': [dir('asset-host')],
          '/Default/Group/asset-host': [dir('etc'), dir('home'), dir('usr')]
        }
        cb(null, tree[path] || [])
      }),
      unlink: vi.fn((_: string, cb: (err?: Error | null) => void) => cb(null)),
      end: vi.fn()
    }
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn()
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    conn.end = vi.fn()

    const { handlers, ClientMock, sftpConnections, jumpserverConnections } = await setupSftpHandlers(() => conn)
    jumpserverConnections.set(id, { conn: ordinaryJumpServerConn, jumpserverUuid: 'bastion-uuid' })
    const connectHandler = handlers.get('ssh:sftp:connect')
    const listHandler = handlers.get('ssh:sftp:list')
    const deleteHandler = handlers.get('ssh:sftp:delete-file')
    expect(connectHandler).toBeTypeOf('function')
    expect(listHandler).toBeTypeOf('function')
    expect(deleteHandler).toBeTypeOf('function')

    const connectResult = await connectHandler!(
      { sender: { send: vi.fn() } },
      {
        id,
        sshType: 'jumpserver',
        host: 'bastion',
        username: 'jms-user',
        password: 'pw',
        assetUuid: 'bastion-uuid',
        targetAssetUuid: 'asset-uuid',
        targetHostname: 'asset-host',
        targetIp: '10.0.0.5'
      }
    )

    expect(connectResult).toMatchObject({ status: 'connected' })
    expect(ClientMock).toHaveBeenCalledTimes(1)
    expect(ordinaryJumpServerConn.sftp).not.toHaveBeenCalled()
    expect(conn.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'jms-user' }))
    expect(conn.shell).not.toHaveBeenCalled()
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, provider: 'jumpserver-root' })

    const listResult = await listHandler!({ sender: { send: vi.fn() } }, { id, path: '/' })

    expect(listResult).toMatchObject([
      { name: 'etc', path: '/etc' },
      { name: 'home', path: '/home' },
      { name: 'usr', path: '/usr' }
    ])
    expect(sftp.readdir).toHaveBeenCalledWith('/Default/Group/asset-host', expect.any(Function))

    const deleteResult = await deleteHandler!({ sender: { send: vi.fn() } }, { id, remotePath: '/etc/passwd' })
    expect(deleteResult).toMatchObject({ status: 'success', deletedPath: '/etc/passwd' })
    expect(sftp.unlink).toHaveBeenCalledWith('/Default/Group/asset-host/etc/passwd', expect.any(Function))
  })

  it('deduplicates concurrent live-transport recovery for the same file session', async () => {
    const { handlers, sftpConnections, sshConnections } = await setupSftpHandlers()
    const id = 'user@host:local-team:aG9zdA==:files-left'
    const sftp = {
      readdir: vi.fn((_: string, cb: (err: Error | null, list?: any[]) => void) => setTimeout(() => cb(null, []), 1)),
      end: vi.fn()
    }
    const conn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn((cb: (err: Error | null, sftp?: any) => void) => setTimeout(() => cb(null, sftp), 1))
    }

    sshConnections.set(id, conn)

    const handler = handlers.get('ssh:sftp:list')
    expect(handler).toBeTypeOf('function')

    const [leftResult, rightResult] = await Promise.all([
      handler!({ sender: { send: vi.fn() } }, { id, path: '/' }),
      handler!({ sender: { send: vi.fn() } }, { id, path: '/' })
    ])

    expect(leftResult).toEqual([])
    expect(rightResult).toEqual([])
    expect(conn.sftp).toHaveBeenCalledTimes(1)
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp })
  })

  it('does not recover when a cached SFTP wrapper can serve the requested list path', async () => {
    const { handlers, sftpConnections, sshConnections } = await setupSftpHandlers()
    const id = 'user@host:local-team:aG9zdA==:files-left'
    const sftp = {
      readdir: vi.fn((path: string, cb: (err: Error | null, list?: any[]) => void) => {
        if (path === '.') return cb(new Error('probe rejected'))
        cb(null, [
          {
            filename: 'app.log',
            attrs: {
              isDirectory: () => false,
              isSymbolicLink: () => false,
              mode: 0o644,
              mtime: 0,
              size: 10
            }
          }
        ])
      }),
      end: vi.fn()
    }
    const conn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn()
    }

    sftpConnections.set(id, { isSuccess: true, sftp })
    sshConnections.set(id, conn)

    const handler = handlers.get('ssh:sftp:list')
    expect(handler).toBeTypeOf('function')

    const result = await handler!({ sender: { send: vi.fn() } }, { id, path: '/var/log' })

    expect(result).toMatchObject([{ name: 'app.log', path: '/var/log/app.log' }])
    expect(sftp.readdir).toHaveBeenCalledTimes(1)
    expect(sftp.readdir).toHaveBeenCalledWith('/var/log', expect.any(Function))
    expect(conn.sftp).not.toHaveBeenCalled()
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp })
  })

  it('deduplicates concurrent JumpServer virtual asset path resolution', async () => {
    const id = 'user@bastion:local-team:YmFzdGlvbg==:files-left'
    const attrs = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      mtime: 0,
      size: 0
    }
    const dir = (filename: string) => ({ filename, attrs })
    const tree: Record<string, any[]> = {
      '/': [dir('Default')],
      '/Default': [dir('Group')],
      '/Default/Group': [dir('asset-host')],
      '/Default/Group/asset-host': [dir('etc'), dir('home'), dir('usr')]
    }
    const sftp = {
      readdir: vi.fn((path: string, cb: (err: Error | null, list?: any[]) => void) => {
        setTimeout(() => cb(null, tree[path] || []), 1)
      }),
      end: vi.fn()
    }
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn()
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    conn.end = vi.fn()

    const { handlers } = await setupSftpHandlers(() => conn)
    const connectHandler = handlers.get('ssh:sftp:connect')
    const listHandler = handlers.get('ssh:sftp:list')
    expect(connectHandler).toBeTypeOf('function')
    expect(listHandler).toBeTypeOf('function')

    await connectHandler!(
      { sender: { send: vi.fn() } },
      {
        id,
        sshType: 'jumpserver',
        host: 'bastion',
        username: 'jms-user',
        password: 'pw',
        targetHostname: 'asset-host',
        targetIp: '10.0.0.5'
      }
    )

    const [leftResult, rightResult] = await Promise.all([
      listHandler!({ sender: { send: vi.fn() } }, { id, path: '/' }),
      listHandler!({ sender: { send: vi.fn() } }, { id, path: '/' })
    ])

    expect(leftResult).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'etc', path: '/etc' })]))
    expect(rightResult).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'etc', path: '/etc' })]))
    expect(sftp.readdir.mock.calls.filter(([path]) => path === '/Default').length).toBe(1)
    expect(sftp.readdir.mock.calls.filter(([path]) => path === '/Default/Group').length).toBe(1)
    expect(sftp.readdir.mock.calls.filter(([path]) => path === '/Default/Group/asset-host').length).toBe(3)
  })

  it('remaps stale cached JumpServer virtual paths through the resolved asset base', async () => {
    const id = 'user@bastion:local-team:YmFzdGlvbg==:files-left'
    const dirAttrs = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      mtime: 0,
      size: 0
    }
    const fileAttrs = {
      isDirectory: () => false,
      isSymbolicLink: () => false,
      mode: 0o644,
      mtime: 0,
      size: 10
    }
    const dir = (filename: string) => ({ filename, attrs: dirAttrs })
    const file = (filename: string) => ({ filename, attrs: fileAttrs })
    const sftp = {
      readdir: vi.fn((path: string, cb: (err: Error | null, list?: any[]) => void) => {
        const tree: Record<string, any[]> = {
          '/': [dir('Default')],
          '/Default': [dir('Group')],
          '/Default/Group': [dir('asset-host')],
          '/Default/Group/asset-host': [dir('etc'), dir('home'), dir('usr')],
          '/Default/Group/asset-host/etc': [file('passwd')]
        }
        cb(null, tree[path] || [])
      }),
      end: vi.fn()
    }
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn()
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    conn.end = vi.fn()

    const { handlers } = await setupSftpHandlers(() => conn)
    const connectHandler = handlers.get('ssh:sftp:connect')
    const listHandler = handlers.get('ssh:sftp:list')
    expect(connectHandler).toBeTypeOf('function')
    expect(listHandler).toBeTypeOf('function')

    await connectHandler!(
      { sender: { send: vi.fn() } },
      {
        id,
        sshType: 'jumpserver',
        host: 'bastion',
        username: 'jms-user',
        password: 'pw',
        targetHostname: 'asset-host',
        targetIp: '10.0.0.5'
      }
    )

    const result = await listHandler!({ sender: { send: vi.fn() } }, { id, path: '/Default/asset-host/etc' })

    expect(result).toMatchObject([{ name: 'passwd', path: '/etc/passwd' }])
    expect(sftp.readdir).toHaveBeenCalledWith('/Default/Group/asset-host/etc', expect.any(Function))
    expect(sftp.readdir).not.toHaveBeenCalledWith('/Default/Group/asset-host/Default/Group/asset-host/etc', expect.any(Function))
    expect(sftp.readdir).not.toHaveBeenCalledWith('/Default/Group/asset-host/Default/asset-host/etc', expect.any(Function))
    expect(conn.sftp).toHaveBeenCalledTimes(1)
  })

  it('remaps stale cached JumpServer asset root paths to the resolved asset base', async () => {
    const id = 'user@bastion:local-team:YmFzdGlvbg==:files-left'
    const attrs = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      mtime: 0,
      size: 0
    }
    const dir = (filename: string) => ({ filename, attrs })
    const sftp = {
      readdir: vi.fn((path: string, cb: (err: Error | null, list?: any[]) => void) => {
        const tree: Record<string, any[]> = {
          '/': [dir('Default')],
          '/Default': [dir('Group')],
          '/Default/Group': [dir('asset-host')],
          '/Default/Group/asset-host': [dir('etc'), dir('home'), dir('usr')]
        }
        cb(null, tree[path] || [])
      }),
      end: vi.fn()
    }
    const conn = new EventEmitter() as any
    conn._sock = { destroyed: false, closed: false }
    conn.connect = vi.fn(() => conn.emit('ready'))
    conn.shell = vi.fn()
    conn.sftp = vi.fn((cb: (err: Error | null, sftp?: any) => void) => cb(null, sftp))
    conn.end = vi.fn()

    const { handlers } = await setupSftpHandlers(() => conn)
    const connectHandler = handlers.get('ssh:sftp:connect')
    const listHandler = handlers.get('ssh:sftp:list')
    expect(connectHandler).toBeTypeOf('function')
    expect(listHandler).toBeTypeOf('function')

    await connectHandler!(
      { sender: { send: vi.fn() } },
      {
        id,
        sshType: 'jumpserver',
        host: 'bastion',
        username: 'jms-user',
        password: 'pw',
        targetHostname: 'asset-host',
        targetIp: '10.0.0.5'
      }
    )

    const result = await listHandler!({ sender: { send: vi.fn() } }, { id, path: '/Default/asset-host/' })

    expect(result).toMatchObject([
      { name: 'etc', path: '/etc' },
      { name: 'home', path: '/home' },
      { name: 'usr', path: '/usr' }
    ])
    expect(sftp.readdir).toHaveBeenCalledWith('/Default/Group/asset-host', expect.any(Function))
    expect(sftp.readdir).not.toHaveBeenCalledWith('/Default/Group/asset-host/Default/asset-host', expect.any(Function))
    expect(conn.sftp).toHaveBeenCalledTimes(1)
  })

  it('does not drop and recover a healthy SFTP handle for non-retryable list errors', async () => {
    const { handlers, sftpConnections, sshConnections } = await setupSftpHandlers()
    const id = 'user@host:local-team:aG9zdA==:files-left'
    const notFound = Object.assign(new Error('No such file'), { code: 2 })
    const sftp = {
      readdir: vi.fn((_path: string, cb: (err: Error | null, list?: any[]) => void) => cb(notFound)),
      end: vi.fn()
    }
    const conn = {
      _sock: { destroyed: false, closed: false },
      sftp: vi.fn()
    }

    sftpConnections.set(id, { isSuccess: true, sftp })
    sshConnections.set(id, conn)

    const handler = handlers.get('ssh:sftp:list')
    expect(handler).toBeTypeOf('function')

    const result = await handler!({ sender: { send: vi.fn() } }, { id, path: '/missing' })

    expect(result).toEqual(["cannot open directory '/missing': No such file or directory"])
    expect(sftp.end).not.toHaveBeenCalled()
    expect(conn.sftp).not.toHaveBeenCalled()
    expect(sftpConnections.get(id)).toMatchObject({ isSuccess: true, sftp })
  })
})
