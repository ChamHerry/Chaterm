import { ipcMain, app } from 'electron'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { getUniqueRemoteName, pickReconnectConnectionInfo } from './sshHandle'
import nodeFs from 'node:fs/promises'
import fs from 'fs'
import type { Client } from 'ssh2'
import { Client as SSHClient } from 'ssh2'
import {
  connectionStatus,
  sftpConnections,
  sshConnections,
  sshConnectionPool,
  KeyboardInteractiveTimeout,
  handleRequestKeyboardInteractive
} from './sshHandle'
import { jumpserverConnections } from './jumpserverHandle'
import { getConnectionPoolKey, createProxyCommandSocket } from './sshHandle'
import { createProxySocket } from './proxy'
import { getAlgorithmsByAssetType } from './algorithms'
import { getPackageInfo } from './jumpserver/connectionManager'
import { buildJumpServerSftpUsername, type JumpServerSftpMode } from './jumpserver/sftpDirect'
const sftpLogger = createLogger('ssh')

export type SftpConnectResult = { status: string; message: string }

const activeTasks = new Map<string, { read?: any; write?: any; localPath?: string; cancel?: () => void }>()
// Tracks JumpServer connections created by SFTP itself, not by the SSH connect flow.
const sftpOwnedJumpServerConnections = new Map<string, Client>()

export const sftpConnectionInfoMap = new Map<string, any>()
const sftpReadyPromises = new Map<string, Promise<any>>()

type SftpProvider = 'ssh' | 'jumpserver-root' | 'jumpserver-direct-asset'

type SftpConnectionMetadata = {
  provider: SftpProvider
  mode?: JumpServerSftpMode
  targetAsset?: string
  targetAccountUsername?: string
  targetHostname?: string
  targetIp?: string
  virtualBasePath?: string
  virtualBaseResolved?: boolean
}

const sftpConnectionMetadataMap = new Map<string, SftpConnectionMetadata>()
const jumpServerVirtualBasePromises = new Map<string, Promise<string | undefined>>()

type R2RFileArgs = {
  fromId: string
  toId: string
  fromPath: string
  toPath: string
  autoRename?: boolean
}

type R2RDirArgs = {
  fromId: string
  toId: string
  fromDir: string
  toDir: string
  autoRename?: boolean
  concurrency?: number
}

type GroupKind = 'directory' | 'file'

type ChildTaskOptions = {
  parentTaskKey?: string
  taskKeyOverride?: string
  isGroup?: boolean
  groupKind?: GroupKind
}

function createAsyncPool<T>(worker: (item: T) => Promise<void>, concurrency: number) {
  let active = 0
  let ended = false
  let firstError: any = null
  const queue: T[] = []

  let resolveWait: (() => void) | null = null
  let rejectWait: ((err: any) => void) | null = null

  const settleIfDone = () => {
    if (firstError) {
      rejectWait?.(firstError)
      resolveWait = null
      rejectWait = null
      return
    }
    if (ended && active === 0 && queue.length === 0) {
      resolveWait?.()
      resolveWait = null
      rejectWait = null
    }
  }

  const pump = () => {
    while (!firstError && active < concurrency && queue.length > 0) {
      const item = queue.shift()!
      active++
      Promise.resolve(worker(item))
        .catch((err) => {
          if (!firstError) firstError = err
        })
        .finally(() => {
          active--
          if (!firstError) pump()
          settleIfDone()
        })
    }
  }

  return {
    push(item: T) {
      if (firstError) throw firstError
      queue.push(item)
      pump()
    },
    end() {
      ended = true
      settleIfDone()
    },
    async wait() {
      if (firstError) throw firstError
      if (ended && active === 0 && queue.length === 0) return
      await new Promise<void>((resolve, reject) => {
        resolveWait = resolve
        rejectWait = reject
        pump()
        settleIfDone()
      })
      if (firstError) throw firstError
    }
  }
}

export const registerFileSystemHandlers = () => {
  ipcMain.handle('ssh:sftp:connect', async (_event, connectionInfo) => {
    const result = await connectSftpReuseFirst(_event, connectionInfo)

    // Cache the minimum connection info needed for later SFTP reconnects.
    if (result?.status === 'connected' && connectionInfo?.id) {
      const picked = pickReconnectConnectionInfo(connectionInfo)
      if (picked) {
        sftpConnectionInfoMap.set(String(connectionInfo.id), picked)
      }
    }

    return result
  })
  ipcMain.handle('ssh:sftp:close', async (_event, payload: { id: string }) => {
    const id = String(payload?.id || '')
    const res = await closeSftpOnly(id)
    sftpConnectionInfoMap.delete(id)
    return res
  })

  ipcMain.handle('ssh:sftp:cancel', async (_event, payload: { id: string; requestId?: string }) => {
    const id = String(payload?.id || '')
    const reqId = String(payload?.requestId || '')
    const p = pendingSftpConnects.get(id)
    if (!p) return { status: 'noop', message: 'no pending connect' }
    if (reqId && p.requestId !== reqId) return { status: 'noop', message: 'requestId mismatch' }

    p.cancelled = true
    try {
      p.conn?.end()
    } catch {}
    return { status: 'cancelled', message: 'cancelled' }
  })
  ipcMain.handle('ssh:sftp:conn:list', async () => {
    return Array.from(sftpConnections.entries()).map(([key, sftpConn]) => ({
      id: key,
      isSuccess: sftpConn.isSuccess,
      error: sftpConn.error
    }))
  })
  ipcMain.handle('app:get-path', async (_e, { name }: { name: 'home' | 'documents' | 'downloads' }) => {
    return app.getPath(name)
  })

  ipcMain.handle('ssh:sftp:list', async (event, { path: reqPath, id }) => {
    if (isLocalId(id)) {
      try {
        return await listLocalDir(reqPath)
      } catch (err: any) {
        return [String(err?.message || err)]
      }
    }

    try {
      // Always probe the current SFTP handle before listing, and reconnect if needed.
      let sftp = await ensureSftpReady(event, id)
      let remoteReqPath = normalizeRemotePath(reqPath)

      try {
        remoteReqPath = await toRemoteSftpPath(sftp, id, reqPath)
        const list = await sftpReaddirWithTimeout(sftp, remoteReqPath, 10000)

        return (list || []).map((item) => {
          const name = item.filename
          const attrs = item.attrs
          const displayReqPath = toDisplaySftpPath(id, reqPath)
          const prefix = displayReqPath === '/' ? '/' : displayReqPath + '/'

          return {
            name,
            path: prefix + name,
            isDir: attrs.isDirectory(),
            isLink: attrs.isSymbolicLink(),
            mode: '0' + (attrs.mode & 0o777).toString(8),
            modTime: new Date(attrs.mtime * 1000).toISOString().replace('T', ' ').slice(0, 19),
            size: attrs.size
          }
        })
      } catch (err: any) {
        const shouldRetry = shouldRetrySftpOperation(err)
        sftpLogger.warn('SFTP list failed', {
          event: 'ssh.sftp.list.failed',
          connectionId: id,
          path: reqPath,
          remotePath: remoteReqPath,
          code: err?.code,
          message: err?.message || String(err),
          retry: shouldRetry
        })

        if (!shouldRetry) throw err

        // Retry once with a fresh SFTP session only when the current handle is
        // likely stale. Path/permission errors should be surfaced as-is; dropping
        // a healthy handle for those creates repeated recover.live loops.
        dropSftpHandleOnly(String(id), 'SFTP readdir failed')
        sftp = await ensureSftpReady(event, id)

        remoteReqPath = await toRemoteSftpPath(sftp, id, reqPath)
        const list = await sftpReaddirWithTimeout(sftp, remoteReqPath, 10000)

        return (list || []).map((item) => {
          const name = item.filename
          const attrs = item.attrs
          const displayReqPath = toDisplaySftpPath(id, reqPath)
          const prefix = displayReqPath === '/' ? '/' : displayReqPath + '/'

          return {
            name,
            path: prefix + name,
            isDir: attrs.isDirectory(),
            isLink: attrs.isSymbolicLink(),
            mode: '0' + (attrs.mode & 0o777).toString(8),
            modTime: new Date(attrs.mtime * 1000).toISOString().replace('T', ' ').slice(0, 19),
            size: attrs.size
          }
        })
      }
    } catch (err: any) {
      const errorCode = err?.code

      switch (errorCode) {
        case 2:
          return [`cannot open directory '${reqPath}': No such file or directory`]
        case 3:
          return [`cannot open directory '${reqPath}': Permission denied`]
        case 4:
          return [`cannot open directory '${reqPath}': Operation failed`]
        case 5:
          return [`cannot open directory '${reqPath}': Bad message format`]
        case 6:
          return [`cannot open directory '${reqPath}': No connection`]
        case 7:
          return [`cannot open directory '${reqPath}': Connection lost`]
        case 8:
          return [`cannot open directory '${reqPath}': Operation not supported`]
        default:
          return [`cannot open directory '${reqPath}': ${err?.message || String(err)}`]
      }
    }
  })
  ipcMain.handle('ssh:sftp:upload-file', (event, args) => handleStreamTransfer(event, args.id, args.localPath, args.remotePath, 'upload'))

  ipcMain.handle('ssh:sftp:upload-directory', (event, args) => handleDirectoryTransfer(event, args.id, args.localPath, args.remotePath))

  ipcMain.handle('ssh:sftp:download-file', (event, args) => handleStreamTransfer(event, args.id, args.remotePath, args.localPath, 'download'))

  ipcMain.handle('ssh:sftp:download-directory', (event, args) => handleDirectoryDownload(event, args.id, args.remoteDir, args.localDir))

  ipcMain.handle('ssh:sftp:delete-file', (event, { id, remotePath }) => handleDeleteFile(event, id, remotePath))

  ipcMain.handle('ssh:sftp:rename-move', async (_e, { id, oldPath, newPath }) => {
    try {
      const sftp = await ensureSftpReady(_e, id)
      if (oldPath === newPath) {
        return { status: 'success' }
      }
      const oldRemotePath = await toRemoteSftpPath(sftp, id, oldPath)
      const newRemotePath = await toRemoteSftpPath(sftp, id, newPath)
      await new Promise<void>((res, rej) => {
        sftp.rename(oldRemotePath, newRemotePath, (err) => (err ? rej(err) : res()))
      })
      return { status: 'success' }
    } catch (err) {
      return { status: 'error', message: (err as Error).message }
    }
  })

  ipcMain.handle('ssh:sftp:chmod', async (_e, { id, remotePath, mode, recursive }) => {
    try {
      const sftp = await ensureSftpReady(_e, id)
      const parsedMode = parseInt(String(mode), 8)
      const mappedRemotePath = await toRemoteSftpPath(sftp, id, remotePath)

      if (recursive) {
        const chmodRecursive = async (path: string): Promise<void> => {
          // Modify the permissions of the current path first
          await new Promise<void>((res, rej) => {
            sftp.chmod(path, parsedMode, (err) => (err ? rej(err) : res()))
          })

          // Retrieve directory contents
          const items = await new Promise<any[]>((res, rej) => {
            sftp.readdir(path, (err, list) => (err ? rej(err) : res(list || [])))
          })

          // Recursive processing of subdirectories and files
          for (const item of items) {
            if (item.filename === '.' || item.filename === '..') continue

            const itemPath = `${path}/${item.filename}`

            await new Promise<void>((res, rej) => {
              sftp.chmod(itemPath, parsedMode, (err) => (err ? rej(err) : res()))
            })

            if (item.attrs && item.attrs.isDirectory && item.attrs.isDirectory()) {
              await chmodRecursive(itemPath)
            }
          }
        }

        await chmodRecursive(mappedRemotePath)
      } else {
        await new Promise<void>((res, rej) => {
          sftp.chmod(mappedRemotePath, parsedMode, (err) => (err ? rej(err) : res()))
        })
      }

      return { status: 'success' }
    } catch (err) {
      return { status: 'error', message: (err as Error).message }
    }
  })

  ipcMain.handle('ssh:sftp:cancel-task', (_event, { taskKey }) => {
    const task = activeTasks.get(taskKey)

    if (task) {
      if (task.cancel) {
        task.cancel()
      } else {
        task.read.destroy()
        task.write.destroy()
      }
      activeTasks.delete(taskKey)
      return { status: 'aborted' }
    }
    return { status: 'not_found' }
  })

  ipcMain.handle('sftp:r2r:file', async (event, args: R2RFileArgs) => {
    return transferFileR2R(event, args)
  })

  ipcMain.handle('sftp:r2r:dir', async (event, args: R2RDirArgs) => {
    return transferDirR2R(event, args)
  })

  ipcMain.handle('ssh:sftp:copy-or-move', async (event, args) => {
    return copyOrMoveBySftp(event, args)
  })
}

const isLocalId = (id: string) => id.includes('localhost@127.0.0.1:local:')
const toPosix = (p: string) => String(p || '').replace(/\\/g, '/')

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtTime = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

function normalizeWindowsDrive(p: string) {
  const s = String(p || '').trim()

  // "C:" / "c:" => "C:\"
  if (/^[a-zA-Z]:$/.test(s)) return s + '\\'

  // "C:/" => "C:\"
  if (/^[a-zA-Z]:\/$/.test(s)) return s.replace('/', '\\')

  return s
}

function ensureAbsLocalPath(reqPath: string) {
  let p = String(reqPath || '').trim()

  if (process.platform === 'win32') {
    p = normalizeWindowsDrive(p)
    p = p.replace(/\//g, '\\')
  }

  return path.isAbsolute(p) ? p : path.resolve(p)
}

async function listLocalDir(reqPath: string) {
  const abs = ensureAbsLocalPath(reqPath)

  let ents: import('fs').Dirent[]
  try {
    ents = await nodeFs.readdir(abs, { withFileTypes: true })
  } catch (err: any) {
    return [String(err?.message || err)]
  }

  const items: any[] = []

  for (const ent of ents) {
    const full = path.join(abs, ent.name)

    // Compatible with Windows files without permission
    let mode = '---'
    let modTime = ''
    let size = 0
    let isLink = ent.isSymbolicLink()

    try {
      const st = await nodeFs.lstat(full)
      mode = ((st.mode ?? 0) & 0o777).toString(8).padStart(3, '0')
      modTime = fmtTime(st.mtime ?? new Date(0))
      size = ent.isDirectory() ? 0 : Number(st.size || 0)
      isLink = st.isSymbolicLink?.() ? true : isLink
    } catch (err: any) {
      const code = String(err?.code || '')
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
        continue
      }
      continue
    }

    items.push({
      name: ent.name,
      path: toPosix(full),
      isDir: ent.isDirectory(),
      isLink,
      mode,
      modTime,
      size
    })
  }

  return items
}

// Delete file
const handleDeleteFile = async (_event, id, remotePath) => {
  let sftp
  try {
    sftp = await ensureSftpReady(_event, id)
  } catch (err: any) {
    return {
      status: 'error',
      message: err?.message || 'Sftp Not connected'
    }
  }

  if (!remotePath || remotePath.trim() === '' || remotePath.trim() === '*' || remotePath === '/') {
    return {
      status: 'error',
      message: 'Illegal path, cannot be deleted'
    }
  }

  try {
    const mappedRemotePath = await toRemoteSftpPath(sftp, id, remotePath)
    await new Promise<void>((res, rej) => {
      sftp.unlink(mappedRemotePath, (err) => {
        if (err) return rej(err)
        res()
      })
    })
    return {
      status: 'success',
      message: 'File deleted successfully',
      deletedPath: remotePath
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return {
      status: 'error',
      message: `Delete failed: ${errorMessage}`
    }
  }
}

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Wrap ssh2 callback APIs so we can reuse them in reconnect checks.
const sftpStat = async (sftp: any, p: string): Promise<any> => {
  return await new Promise<any>((resolve, reject) => {
    sftp.stat(p, (err: any, st: any) => (err ? reject(err) : resolve(st)))
  })
}

const sftpReaddir = async (sftp: any, p: string): Promise<any[]> => {
  return await new Promise<any[]>((resolve, reject) => {
    sftp.readdir(p, (err: any, list: any[]) => (err ? reject(err) : resolve(list || [])))
  })
}

const sftpReaddirWithTimeout = async (sftp: any, p: string, timeout = 10000): Promise<any[]> => {
  return await withTimeout(sftpReaddir(sftp, p), timeout, `SFTP readdir timeout: ${p}`)
}

const shouldRetrySftpOperation = (err: any) => {
  const code = Number(err?.code)
  if (code === 6 || code === 7) return true

  const message = String(err?.message || err || '').toLowerCase()
  return (
    message.includes('timeout') ||
    message.includes('connection lost') ||
    message.includes('no connection') ||
    message.includes('not connected') ||
    message.includes('connection closed') ||
    message.includes('channel closed') ||
    message.includes('eof') ||
    message.includes('read econnreset') ||
    message.includes('write epipe')
  )
}

const normalizeRemotePath = (p: string) => {
  const value = toPosix(p || '/').trim()
  if (!value || value === '.') return '/'

  const absoluteValue = value.startsWith('/') ? value : `/${value}`
  return path.posix.normalize(absoluteValue)
}

const joinSftpPath = (base: string, child: string) => {
  const normalizedBase = normalizeRemotePath(base)
  const normalizedChild = toPosix(child || '').replace(/^\/+/, '')
  if (!normalizedChild) return normalizedBase

  return path.posix.normalize(normalizedBase === '/' ? `/${normalizedChild}` : `${normalizedBase.replace(/\/+$/, '')}/${normalizedChild}`)
}

const isSameOrChildPath = (base: string, candidate: string) => {
  const normalizedBase = normalizeRemotePath(base)
  const normalizedCandidate = normalizeRemotePath(candidate)
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase.replace(/\/+$/, '')}/`)
}

const getJumpServerVirtualTreeSuffix = (metadata: SftpConnectionMetadata | undefined, virtualBasePath: string, uiPath: string) => {
  const normalizedUiPath = normalizeRemotePath(uiPath)
  const normalizedVirtualBasePath = normalizeRemotePath(virtualBasePath)

  if (isSameOrChildPath(normalizedVirtualBasePath, normalizedUiPath)) {
    const suffix = normalizedUiPath.slice(normalizedVirtualBasePath.replace(/\/+$/, '').length)
    return normalizeRemotePath(suffix || '/')
  }

  const parts = normalizedUiPath.split('/').filter(Boolean)
  const hints = getJumpServerTargetHints(metadata, virtualBasePath)
  const targetSegmentIndex = parts.findIndex((part) => entryMatchesTargetHint(part, hints))
  if (targetSegmentIndex >= 0) {
    return normalizeRemotePath(parts.slice(targetSegmentIndex + 1).join('/') || '/')
  }

  return undefined
}

const remapJumpServerVirtualTreePath = (metadata: SftpConnectionMetadata | undefined, virtualBasePath: string, uiPath: string) => {
  const suffix = getJumpServerVirtualTreeSuffix(metadata, virtualBasePath, uiPath)
  if (suffix !== undefined) return joinSftpPath(virtualBasePath, suffix)

  return joinSftpPath(virtualBasePath, uiPath)
}

const getSftpEntryName = (entry: any) => String(entry?.filename ?? entry?.name ?? '').trim()

const isSftpDirectoryEntry = (entry: any) => {
  if (entry?.attrs?.isDirectory) return !!entry.attrs.isDirectory()
  if (typeof entry?.longname === 'string') return entry.longname.startsWith('d')
  return false
}

const normalizeSearchValue = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()

const uniqueNonEmpty = (values: unknown[]) => Array.from(new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean)))

const getJumpServerTargetHints = (metadata?: SftpConnectionMetadata, virtualBasePath?: string) => {
  if (!metadata) return []

  return uniqueNonEmpty([
    metadata.targetHostname,
    metadata.targetIp,
    metadata.targetAsset,
    virtualBasePath ? path.posix.basename(virtualBasePath) : ''
  ])
}

const looksLikeAssetNodeName = (name: string) => {
  return /(?:\d{1,3}\.){3}\d{1,3}/.test(name) || /^[A-Za-z]+[-_]\d{1,3}\./.test(name)
}

const entryMatchesTargetHint = (entryName: string, hints: string[]) => {
  const normalizedName = normalizeSearchValue(entryName)
  if (!normalizedName) return false

  return hints.some((hint) => {
    const normalizedHint = normalizeSearchValue(hint)
    if (!normalizedHint) return false
    if (normalizedName === normalizedHint) return true

    // JumpServer asset nodes are often named with a display hostname that embeds
    // the asset IP, for example "ISOS-10.88.202.214-".
    return normalizedHint.includes('.') && normalizedName.includes(normalizedHint)
  })
}

const looksLikeUnixFilesystemRoot = (list: any[]) => {
  const names = new Set((list || []).map((entry) => getSftpEntryName(entry).toLowerCase()).filter(Boolean))
  const rootMarkers = ['etc', 'usr', 'var', 'home', 'root', 'tmp', 'dev', 'proc', 'sys', 'opt', 'boot', 'run']
  return rootMarkers.reduce((count, marker) => count + (names.has(marker) ? 1 : 0), 0) >= 3
}

const resolveJumpServerRootTreeBasePath = async (sftp: any, id: string): Promise<string | undefined> => {
  const existingPromise = jumpServerVirtualBasePromises.get(id)
  if (existingPromise) return await existingPromise

  const promise = resolveJumpServerRootTreeBasePathUncached(sftp, id)
  jumpServerVirtualBasePromises.set(id, promise)

  try {
    return await promise
  } finally {
    if (jumpServerVirtualBasePromises.get(id) === promise) {
      jumpServerVirtualBasePromises.delete(id)
    }
  }
}

const resolveJumpServerRootTreeBasePathUncached = async (sftp: any, id: string): Promise<string | undefined> => {
  const metadata = getSftpMetadata(id)
  if (metadata?.provider !== 'jumpserver-root') return undefined
  if (metadata.virtualBasePath) return metadata.virtualBasePath
  if (metadata.virtualBaseResolved) return undefined

  const hints = getJumpServerTargetHints(metadata)
  if (!hints.length) {
    metadata.virtualBaseResolved = true
    return undefined
  }

  const queue: Array<{ path: string; depth: number }> = [{ path: '/', depth: 0 }]
  const visited = new Set<string>()
  const maxDepth = 6
  const maxDirectories = 500
  let inspectedDirectories = 0

  while (queue.length && inspectedDirectories < maxDirectories) {
    const current = queue.shift()!
    const currentPath = normalizeRemotePath(current.path)
    if (visited.has(currentPath)) continue
    visited.add(currentPath)
    inspectedDirectories++

    let list: any[] = []
    try {
      list = await sftpReaddirWithTimeout(sftp, currentPath, 5000)
    } catch (err: any) {
      sftpLogger.debug('JumpServer SFTP virtual path probe skipped', {
        event: 'ssh.sftp.jumpserver.virtual_path_probe_failed',
        connectionId: id,
        depth: current.depth,
        message: err?.message || String(err)
      })
      continue
    }

    for (const entry of list || []) {
      const name = getSftpEntryName(entry)
      if (!name || name === '.' || name === '..' || !isSftpDirectoryEntry(entry)) continue

      const childPath = joinSftpPath(currentPath, name)
      const matchesTarget = entryMatchesTargetHint(name, hints)

      if (matchesTarget) {
        let childList: any[] = []
        try {
          childList = await sftpReaddirWithTimeout(sftp, childPath, 5000)
        } catch {}

        metadata.virtualBasePath = childPath
        metadata.virtualBaseResolved = true
        setSftpMetadata(id, metadata)
        sftpLogger.info('Resolved JumpServer SFTP virtual asset path', {
          event: 'ssh.sftp.jumpserver.virtual_path_resolved',
          connectionId: id,
          verifiedAsUnixRoot: looksLikeUnixFilesystemRoot(childList)
        })
        return childPath
      }

      if (current.depth >= maxDepth) continue
      if (looksLikeAssetNodeName(name)) continue
      queue.push({ path: childPath, depth: current.depth + 1 })
    }
  }

  metadata.virtualBaseResolved = true
  setSftpMetadata(id, metadata)
  sftpLogger.warn('JumpServer SFTP virtual asset path was not found', {
    event: 'ssh.sftp.jumpserver.virtual_path_not_found',
    connectionId: id,
    inspectedDirectories
  })
  return undefined
}

const toRemoteSftpPath = async (sftp: any, id: string, uiPath: string) => {
  const normalizedUiPath = normalizeRemotePath(uiPath)
  const virtualBasePath = await resolveJumpServerRootTreeBasePath(sftp, String(id || ''))
  if (!virtualBasePath) return normalizedUiPath

  // Be tolerant of stale UI/cache paths that still contain JumpServer's virtual
  // asset-tree prefix from older sessions. Prepending the resolved base again
  // would produce a non-existent path and trigger unnecessary SFTP recovery.
  return remapJumpServerVirtualTreePath(getSftpMetadata(String(id || '')), virtualBasePath, normalizedUiPath)
}

const toDisplaySftpPath = (id: string, uiPath: string) => {
  const metadata = getSftpMetadata(String(id || ''))
  if (metadata?.provider === 'jumpserver-root' && metadata.virtualBasePath) {
    const suffix = getJumpServerVirtualTreeSuffix(metadata, metadata.virtualBasePath, uiPath)
    if (suffix !== undefined) return suffix
  }

  return normalizeRemotePath(uiPath)
}

const getSftpMetadata = (id: string): SftpConnectionMetadata | undefined => {
  const sid = String(id || '')
  if (!sid) return undefined

  const direct = sftpConnectionMetadataMap.get(sid)
  if (direct) return direct

  const actualId = findSftpRecordKey(sid)
  if (actualId && actualId !== sid) {
    return sftpConnectionMetadataMap.get(actualId)
  }

  const lastSeparator = sid.lastIndexOf(':')
  if (lastSeparator < 0) return undefined

  const prefix = sid.substring(0, lastSeparator + 1)
  for (const [existingId, metadata] of sftpConnectionMetadataMap.entries()) {
    if (existingId.startsWith(prefix)) return metadata
  }

  return undefined
}

const setSftpMetadata = (id: string, metadata?: SftpConnectionMetadata) => {
  const sid = String(id || '')
  if (!sid || !metadata) return
  sftpConnectionMetadataMap.set(sid, metadata)
}

const clearSftpMetadata = (id: string) => {
  const sid = String(id || '')
  if (!sid) return
  sftpConnectionMetadataMap.delete(sid)
  jumpServerVirtualBasePromises.delete(sid)
}

// Reuse reconnect info across sibling file sessions that share the same prefix.
const getReusableSftpConnectionInfo = (id: string) => {
  const direct = sftpConnectionInfoMap.get(id)
  if (direct) return direct

  if (!id) return null

  const prefix = id.substring(0, id.lastIndexOf(':') + 1)

  for (const [existingId, info] of sftpConnectionInfoMap.entries()) {
    const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
    if (existingId.startsWith(prefix) && sessionPart.startsWith('files-')) {
      return info
    }
  }

  for (const [existingId, info] of sftpConnectionInfoMap.entries()) {
    if (existingId.startsWith(prefix)) {
      return info
    }
  }

  return null
}

const findSftpRecordKey = (id: string) => {
  if (sftpConnections.has(id)) return id

  if (!id) return id

  const lastSeparator = id.lastIndexOf(':')
  if (lastSeparator < 0) return id

  const prefix = id.substring(0, lastSeparator + 1)

  for (const [existingId] of sftpConnections.entries()) {
    const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
    if (existingId.startsWith(prefix) && sessionPart.startsWith('files-')) {
      return existingId
    }
  }

  for (const [existingId] of sftpConnections.entries()) {
    if (existingId.startsWith(prefix)) {
      return existingId
    }
  }

  return id
}

const getCachedSftpHandle = (id: string) => {
  const actualId = findSftpRecordKey(String(id || ''))
  const rec = sftpConnections.get(actualId) as any
  return rec?.isSuccess && rec?.sftp ? rec.sftp : null
}

const dropSftpHandleOnly = (id: string, reason = 'SFTP handle reset') => {
  const actualId = findSftpRecordKey(String(id || ''))
  const rec = sftpConnections.get(actualId) as any

  if (rec?.sftp) {
    try {
      rec.sftp.end()
    } catch {}
  }

  sftpConnections.delete(actualId)
  connectionStatus.set(actualId, {
    sftpAvailable: false,
    sftpError: reason
  })

  return actualId
}

const recoverSftpReady = async (event: any, sid: string): Promise<any> => {
  let sftp = getCachedSftpHandle(sid)
  if (sftp) return sftp

  const liveConn = findLiveConnectionForSftpId(sid)
  if (liveConn) {
    sftpLogger.debug('Recovering SFTP from live transport', { event: 'ssh.sftp.recover.live', connectionId: sid })
    await initSftpOnConnection(liveConn, sid)
    sftp = getCachedSftpHandle(sid)
    if (sftp) return sftp
  }

  const cachedInfo = getReusableSftpConnectionInfo(sid)
  if (!cachedInfo) {
    throw new Error('missing reconnect connection info')
  }

  const result = await connectSftpReuseFirst(event, cachedInfo)
  if (result?.status !== 'connected') {
    throw new Error(result?.message || 'SFTP reconnect failed')
  }

  sftp = getCachedSftpHandle(sid)
  if (!sftp) {
    throw new Error('SFTP reconnect failed: no sftp instance')
  }

  return sftp
}

const ensureSftpReady = async (event: any, id: string): Promise<any> => {
  const sid = String(id || '')
  if (!sid) {
    throw new Error('missing connection id')
  }

  // Trust a cached SFTP wrapper and let the real operation decide whether it is
  // stale. Some JumpServer SFTP sessions reject synthetic probes while normal
  // directory reads continue to work, which causes unnecessary recovery loops.
  const cached = getCachedSftpHandle(sid)
  if (cached) return cached

  const existing = sftpReadyPromises.get(sid)
  if (existing) return await existing

  const promise = recoverSftpReady(event, sid)
  sftpReadyPromises.set(sid, promise)

  try {
    return await promise
  } finally {
    if (sftpReadyPromises.get(sid) === promise) {
      sftpReadyPromises.delete(sid)
    }
  }
}

const tryEnsureSftpReady = async (event: any, id: string): Promise<any | null> => {
  try {
    return await ensureSftpReady(event, id)
  } catch {
    return null
  }
}

function sftpMkdir(sftp: any, p: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(p, (err: any) => {
      if (!err) return resolve()
      reject(err)
    })
  })
}

// R2R
function isDirEntry(ent: any) {
  if (ent?.attrs?.isDirectory) return !!ent.attrs.isDirectory()
  if (typeof ent?.longname === 'string') return ent.longname.startsWith('d')
  return false
}

function entryName(ent: any) {
  return ent?.filename ?? ent?.name
}

export type TaskStatus = 'running' | 'success' | 'failed' | 'error'
export type ErrorSide = 'from' | 'to' | 'remote' | 'local'
export type TransferStatus = 'success' | 'cancelled' | 'skipped' | 'error'

export interface TransferResult {
  status: TransferStatus
  message?: string
  code?: string
  taskKey?: string

  // host/ip labels for UI
  host?: string
  fromHost?: string
  toHost?: string

  // which side errored
  errorSide?: ErrorSide

  // common data
  remotePath?: string
  localPath?: string
  totalFiles?: number
}

const errToMessage = (e: any) => (e as Error)?.message || e?.message || String(e)

const isPrematureStreamError = (e: any) => {
  const code = e?.code
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

const getTotalUi = (total: number) => (Number.isFinite(total) && total > 0 ? total : 1)

const terminalBytes = (total: number) => getTotalUi(total)

function hookStartOnce(rs: any, ws: any, startOnce: () => void) {
  rs?.once?.('open', startOnce)
  ws?.once?.('open', startOnce)
  rs?.once?.('error', startOnce)
  ws?.once?.('error', startOnce)
}

const getSftpHostLabel = (id: string, sftp?: any) => {
  if (id.includes('local-team')) {
    const [, rest = ''] = String(id || '').split('@')
    const parts = rest.split(':')
    return (parts[2] ? Buffer.from(parts[2], 'base64').toString('utf-8') : '') || sftp?.host || id
  }
  return sftp?.host || id
}

// ssh2 attrs.mode dir check
const isRemoteDir = (st: any) => {
  const mode = st?.mode
  return typeof mode === 'number' && (mode & 0o170000) === 0o040000
}

// After the mkdir fails, check with stat. If it's already a directory, treat it as a success
async function sftpMkdirSafe(sftp: any, dir: string) {
  try {
    await sftpMkdir(sftp, dir)
    return
  } catch (e: any) {
    try {
      const st = await sftpStat(sftp, dir)
      if (isRemoteDir(st)) return
    } catch {}
    throw e
  }
}

// mkdirp for real transfer output
const sftpMkdirRaw = (sftp: any, p: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.mkdir(p, (err: any) => (err ? reject(err) : resolve()))
  })

const sftpMkdirpForTransfer = async (sftp: any, dir: string) => {
  const d = toPosix(dir)
  if (!d || d === '/' || d === '.') return
  const parts = d.split('/').filter(Boolean)
  let cur = d.startsWith('/') ? '/' : ''
  for (const part of parts) {
    cur = cur === '/' ? `/${part}` : cur ? `${cur}/${part}` : part
    try {
      await sftpMkdirSafe(sftp, cur)
    } catch (e: any) {
      // fallback raw mkdir, then stat-if-exists
      try {
        await sftpMkdirRaw(sftp, cur)
      } catch (e2: any) {
        try {
          const st = await sftpStat(sftp, cur)
          if (isRemoteDir(st)) continue
        } catch {}
        throw e2
      }
    }
  }
}

const sendProgress = (event: any, payload: any) => {
  const wc = event?.sender
  if (!wc || wc.isDestroyed?.()) {
    sftpLogger.warn('Progress event skipped: webContents missing or destroyed', {
      event: 'ssh.sftp.progress.skipped',
      taskKey: payload?.taskKey
    })
    return
  }
  try {
    wc.send('ssh:sftp:transfer-progress', payload)
  } catch (err) {
    sftpLogger.error('Failed to send SFTP transfer progress event', {
      event: 'ssh.sftp.progress.send_failed',
      taskKey: payload?.taskKey,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function waitStreamOpen(stream: any) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const ok = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }
    const bad = (e: any) => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const cleanup = () => {
      stream?.off?.('open', ok)
      stream?.off?.('error', bad)
    }
    stream?.once?.('open', ok)
    stream?.once?.('error', bad)
  })
}

// remote -> remote (single file)
export async function transferFileR2R(event: any, args: R2RFileArgs & ChildTaskOptions): Promise<TransferResult> {
  const srcSftp = await tryEnsureSftpReady(event, args.fromId)
  const dstSftp = await tryEnsureSftpReady(event, args.toId)

  const fromHost = getSftpHostLabel(args.fromId, srcSftp)
  const toHost = getSftpHostLabel(args.toId, dstSftp)

  const fromPath = normalizeRemotePath(args.fromPath)
  let toPath = normalizeRemotePath(args.toPath)

  const rawTaskKeyBase = `${args.fromId}->${args.toId}:r2r:${fromPath}:${toPath}`
  const progressTaskKeyBase = args.taskKeyOverride || rawTaskKeyBase

  const progressBase = (extra: Record<string, any> = {}) => ({
    type: 'r2r',
    fromId: args.fromId,
    toId: args.toId,
    fromHost,
    toHost,
    taskKey: progressTaskKeyBase,
    parentTaskKey: args.parentTaskKey,
    isGroup: args.isGroup ?? false,
    groupKind: args.groupKind ?? 'file',
    ...extra
  })

  if (!srcSftp) {
    sendProgress(
      event,
      progressBase({
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'from'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', fromHost, toHost, errorSide: 'from', taskKey: progressTaskKeyBase }
  }

  if (!dstSftp) {
    sendProgress(
      event,
      progressBase({
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'to'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', fromHost, toHost, errorSide: 'to', taskKey: progressTaskKeyBase }
  }

  const autoRename = args.autoRename !== false
  let mappedFromPath = await toRemoteSftpPath(srcSftp, args.fromId, fromPath)
  let mappedToPath = await toRemoteSftpPath(dstSftp, args.toId, toPath)

  let total = 0
  try {
    const st = await sftpStat(srcSftp, mappedFromPath)
    total = st?.size ?? 0
  } catch (e: any) {
    const msg = errToMessage(e)
    sendProgress(
      event,
      progressBase({
        remotePath: fromPath,
        destPath: toPath,
        bytes: 1,
        total: 1,
        status: 'error',
        message: msg,
        errorSide: 'from'
      })
    )
    return { status: 'error', message: msg, taskKey: progressTaskKeyBase, fromHost, toHost, errorSide: 'from' }
  }

  if (autoRename) {
    try {
      const dir = path.posix.dirname(mappedToPath)
      const uiDir = path.posix.dirname(toPath)
      const base = path.posix.basename(toPath)
      const unique = await getUniqueRemoteName(dstSftp, dir, base, false)
      mappedToPath = path.posix.join(dir, unique)
      toPath = path.posix.join(uiDir, unique)
    } catch (e: any) {
      const msg = errToMessage(e)
      sendProgress(
        event,
        progressBase({
          remotePath: fromPath,
          destPath: toPath,
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'to'
        })
      )
      return { status: 'error', message: msg, taskKey: progressTaskKeyBase, fromHost, toHost, errorSide: 'to' }
    }
  }

  const rawTaskKey = `${args.fromId}->${args.toId}:r2r:${fromPath}:${toPath}`
  const progressTaskKey = args.taskKeyOverride || rawTaskKey

  if (activeTasks.has(progressTaskKey)) {
    return { status: 'skipped', message: 'Task already in progress', taskKey: progressTaskKey, fromHost, toHost }
  }

  const totalUi = getTotalUi(total)

  let created = false
  const ensureCreated = () => {
    if (created) return
    created = true
    sendProgress(
      event,
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: 0,
        total: totalUi,
        status: 'running' as TaskStatus,
        stage: 'init'
      })
    )
  }
  ensureCreated()

  let transferred = 0
  let lastEmitTime = 0
  let isCancelled = false

  let rs: any
  let ws: any

  let firstErr: any = null
  let firstSide: ErrorSide | null = null
  const markFirst = (side: ErrorSide, e: any) => {
    if (!firstErr) {
      firstErr = e
      firstSide = side
    }
  }

  try {
    rs = srcSftp.createReadStream(mappedFromPath)
    rs.once('error', (e: any) => markFirst('from', e))

    await waitStreamOpen(rs)

    ws = dstSftp.createWriteStream(mappedToPath, { flags: 'w' })
    ws.once('error', (e: any) => markFirst('to', e))

    activeTasks.set(progressTaskKey, {
      read: rs,
      write: ws,
      cancel: () => {
        isCancelled = true
        rs.destroy()
        ws.destroy()
      }
    })

    rs.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      const now = Date.now()
      if (now - lastEmitTime > 150 || (total > 0 && transferred >= total)) {
        sendProgress(
          event,
          progressBase({
            taskKey: progressTaskKey,
            remotePath: fromPath,
            destPath: toPath,
            bytes: transferred,
            total: totalUi,
            status: 'running' as TaskStatus
          })
        )
        lastEmitTime = now
      }
    })

    await pipeline(rs, ws)
    activeTasks.delete(progressTaskKey)

    sendProgress(
      event,
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'success' as TaskStatus
      })
    )

    return { status: 'success', remotePath: toPath, taskKey: progressTaskKey, fromHost, toHost }
  } catch (e: any) {
    activeTasks.delete(progressTaskKey)

    if (isCancelled || isPrematureStreamError(e)) {
      sendProgress(
        event,
        progressBase({
          taskKey: progressTaskKey,
          remotePath: fromPath,
          destPath: toPath,
          bytes: terminalBytes(total),
          total: totalUi,
          status: 'failed' as TaskStatus,
          message: 'Transfer cancelled',
          errorSide: 'local'
        })
      )
      return { status: 'cancelled', message: 'Transfer cancelled', taskKey: progressTaskKey, fromHost, toHost, errorSide: 'local' }
    }

    const primaryErr = firstErr || e
    const msg = errToMessage(primaryErr)
    const errorSide: ErrorSide = firstSide || 'from'

    sendProgress(
      event,
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'error' as TaskStatus,
        message: msg,
        errorSide
      })
    )

    return { status: 'error', message: msg, code: primaryErr?.code, taskKey: progressTaskKey, fromHost, toHost, errorSide }
  }
}

// remote -> remote (directory)
export async function transferDirR2R(event: any, args: R2RDirArgs): Promise<TransferResult> {
  const srcSftp = await tryEnsureSftpReady(event, args.fromId)
  const dstSftp = await tryEnsureSftpReady(event, args.toId)

  const fromHost = getSftpHostLabel(args.fromId, srcSftp)
  const toHost = getSftpHostLabel(args.toId, dstSftp)

  const fromDir = normalizeRemotePath(args.fromDir)
  const toParent = normalizeRemotePath(args.toDir)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${args.fromId}->${args.toId}:r2r-dir:${fromDir}:${toParent}:${nonce}`

  const sendGroup = (extra?: Record<string, any>) =>
    sendProgress(event, {
      type: 'r2r',
      fromId: args.fromId,
      toId: args.toId,
      fromHost,
      toHost,
      taskKey: dirTaskKey,
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: toParent,
      bytes: 0,
      total: 1,
      status: 'running',
      stage: 'scanning',
      ...extra
    })

  if (!srcSftp || !dstSftp) {
    const errorSide: ErrorSide = !srcSftp ? 'from' : 'to'
    const msg = 'Sftp Not connected'
    sendGroup({ status: 'error', message: msg, bytes: 1, total: 1, stage: undefined, errorSide })
    return { status: 'error', message: msg, fromHost, toHost, errorSide }
  }

  const mappedFromDir = await toRemoteSftpPath(srcSftp, args.fromId, fromDir)
  const mappedToParent = await toRemoteSftpPath(dstSftp, args.toId, toParent)

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  const autoRename = args.autoRename !== false
  const concurrency = args.concurrency ?? 3

  const originalDirName = path.posix.basename(fromDir)
  let finalDirName = originalDirName
  try {
    finalDirName = autoRename ? await getUniqueRemoteName(dstSftp, mappedToParent, originalDirName, true) : originalDirName
  } catch (e: any) {
    const msg = errToMessage(e)
    sendGroup({ status: 'error', message: msg, bytes: 1, total: 1, stage: undefined, errorSide: 'to' })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, fromHost, toHost, errorSide: 'to' }
  }

  const finalToBaseDir = path.posix.join(toParent, finalDirName)
  const mappedFinalToBaseDir = path.posix.join(mappedToParent, finalDirName)

  try {
    await sftpMkdirSafe(dstSftp, mappedFinalToBaseDir)
  } catch (e: any) {
    const msg = errToMessage(e)
    sendGroup({
      destPath: finalToBaseDir,
      status: 'error',
      message: msg,
      bytes: 1,
      total: 1,
      stage: undefined,
      errorSide: 'to'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, fromHost, toHost, remotePath: finalToBaseDir, errorSide: 'to' }
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  let scanCounter = 0
  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false

  const reportGroup = (extra?: Record<string, any>) => {
    sendGroup({
      destPath: finalToBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  const pool = createAsyncPool<{ from: string; to: string }>(async (f) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${f.to}`

    const r = await transferFileR2R(event, {
      fromId: args.fromId,
      toId: args.toId,
      fromPath: f.from,
      toPath: f.to,
      autoRename: false,
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, concurrency)

  const scan = async (curFrom: string, curMappedFrom: string, curTo: string, curMappedTo: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const list = await sftpReaddir(srcSftp, curMappedFrom)
    for (const ent of list) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const name = entryName(ent)
      if (!name) continue

      const s = path.posix.join(curFrom, name)
      const mappedS = path.posix.join(curMappedFrom, name)
      const d = path.posix.join(curTo, name)
      const mappedD = path.posix.join(curMappedTo, name)

      if (isDirEntry(ent)) {
        await sftpMkdirSafe(dstSftp, mappedD)
        await scan(s, mappedS, d, mappedD)
      } else {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${d}`

        sendProgress(event, {
          type: 'r2r',
          fromId: args.fromId,
          toId: args.toId,
          fromHost,
          toHost,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          isGroup: false,
          groupKind: 'file',
          remotePath: s,
          destPath: d,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ from: s, to: d })
      }
    }
  }

  try {
    await scan(fromDir, mappedFromDir, finalToBaseDir, mappedFinalToBaseDir)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    sendGroup({
      destPath: finalToBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'to')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, fromHost, toHost, errorSide: 'local' }
      : tr || { status: 'error', message: msg, fromHost, toHost, errorSide: 'to' }
  }

  sendGroup({
    destPath: finalToBaseDir,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', remotePath: finalToBaseDir, totalFiles: scannedFiles, fromHost, toHost }
}

// upload/download single file (remote<->local)
export async function handleStreamTransfer(
  event: any,
  id: string,
  srcPath: string,
  destPath: string,
  type: 'download' | 'upload',
  isInternalCall = false,
  childOpts?: ChildTaskOptions
): Promise<TransferResult> {
  const sftp = await tryEnsureSftpReady(event, id)
  const host = getSftpHostLabel(id, sftp)

  const rawFallbackTaskKey =
    type === 'download' ? `${id}:dl:${toPosix(srcPath)}:${path.resolve(destPath)}` : `${id}:up:${srcPath}:${toPosix(destPath)}`

  const progressFallbackTaskKey = childOpts?.taskKeyOverride || rawFallbackTaskKey

  const progressBase = (extra: Record<string, any> = {}) => ({
    id,
    host,
    taskKey: progressFallbackTaskKey,
    parentTaskKey: childOpts?.parentTaskKey,
    type,
    isGroup: childOpts?.isGroup ?? false,
    groupKind: childOpts?.groupKind ?? 'file',
    ...extra
  })

  if (!sftp) {
    sendProgress(
      event,
      progressBase({
        remotePath: toPosix(srcPath),
        destPath,
        bytes: 1,
        total: 1,
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'remote'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote', taskKey: progressFallbackTaskKey }
  }

  let finalRemotePath = normalizeRemotePath(destPath)
  let mappedFinalRemotePath = finalRemotePath
  let mappedSourceRemotePath = normalizeRemotePath(srcPath)
  let finalLocalPath = destPath
  let total = 0

  if (type === 'download') {
    const sourceRemotePath = normalizeRemotePath(srcPath)
    mappedSourceRemotePath = await toRemoteSftpPath(sftp, id, sourceRemotePath)
    try {
      const st = await sftpStat(sftp, mappedSourceRemotePath)
      total = st?.size ?? 0
    } catch (e: any) {
      const msg = errToMessage(e)
      sendProgress(
        event,
        progressBase({
          remotePath: toPosix(srcPath),
          destPath: path.resolve(destPath),
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'remote'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'remote' }
    }

    try {
      finalLocalPath = path.resolve(destPath)
      await fs.promises.mkdir(path.dirname(finalLocalPath), { recursive: true })
    } catch (e: any) {
      const msg = errToMessage(e)
      sendProgress(
        event,
        progressBase({
          remotePath: toPosix(srcPath),
          destPath: finalLocalPath,
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'local'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'local' }
    }
  } else {
    try {
      const st = await fs.promises.stat(srcPath)
      total = st?.size ?? 0
    } catch (e: any) {
      const msg = errToMessage(e)
      sendProgress(
        event,
        progressBase({
          remotePath: toPosix(destPath),
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'local'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'local' }
    }

    if (!isInternalCall) {
      try {
        const remoteDir = normalizeRemotePath(destPath)
        const mappedRemoteDir = await toRemoteSftpPath(sftp, id, remoteDir)
        const fileName = path.basename(srcPath)
        const uniqueName = await getUniqueRemoteName(sftp, mappedRemoteDir, fileName, false)
        finalRemotePath = path.posix.join(remoteDir, uniqueName)
        mappedFinalRemotePath = path.posix.join(mappedRemoteDir, uniqueName)
      } catch (e: any) {
        const msg = errToMessage(e)
        sendProgress(
          event,
          progressBase({
            remotePath: toPosix(destPath),
            bytes: 1,
            total: 1,
            status: 'error',
            message: msg,
            errorSide: 'remote'
          })
        )
        return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'remote' }
      }
    } else {
      finalRemotePath = normalizeRemotePath(destPath)
      mappedFinalRemotePath = await toRemoteSftpPath(sftp, id, finalRemotePath)
    }
  }

  const rawTaskKey = type === 'download' ? `${id}:dl:${toPosix(srcPath)}:${finalLocalPath}` : `${id}:up:${srcPath}:${finalRemotePath}`

  const progressTaskKey = childOpts?.taskKeyOverride || rawTaskKey

  if (activeTasks.has(progressTaskKey)) {
    return { status: 'skipped', message: 'Task already in progress', taskKey: progressTaskKey, host }
  }

  const totalUi = getTotalUi(total)

  let created = false
  const ensureCreated = () => {
    if (created) return
    created = true
    sendProgress(event, {
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: type === 'upload' ? finalRemotePath : normalizeRemotePath(srcPath),
      destPath: type === 'download' ? finalLocalPath : undefined,
      bytes: 0,
      total: totalUi,
      status: 'running' as TaskStatus,
      stage: 'init'
    })
  }
  ensureCreated()

  let isCancelled = false
  let transferred = 0
  let lastEmitTime = 0

  const remotePathForUI = type === 'upload' ? finalRemotePath : normalizeRemotePath(srcPath)
  const destPathForUI = type === 'download' ? finalLocalPath : undefined

  let readStream: any
  let writeStream: any

  let firstErr: any = null
  let firstErrSide: ErrorSide | null = null
  const markFirstErr = (side: ErrorSide, e: any) => {
    if (firstErr) return
    firstErr = e
    firstErrSide = side
  }

  try {
    if (type === 'download') {
      readStream = sftp.createReadStream(mappedSourceRemotePath)
      readStream.once?.('error', (e: any) => markFirstErr('remote', e))
    } else {
      readStream = fs.createReadStream(srcPath)
      readStream.once?.('error', (e: any) => markFirstErr('local', e))
    }
  } catch (e: any) {
    const msg = errToMessage(e)
    const errorSide: ErrorSide = type === 'download' ? 'remote' : 'local'
    sendProgress(event, {
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })
    return { status: 'error', message: msg, code: e?.code, taskKey: progressTaskKey, host, errorSide }
  }

  try {
    if (type === 'download') {
      writeStream = fs.createWriteStream(finalLocalPath)
      writeStream.once?.('error', (e: any) => markFirstErr('local', e))
    } else {
      writeStream = sftp.createWriteStream(mappedFinalRemotePath)
      writeStream.once?.('error', (e: any) => markFirstErr('remote', e))
    }
  } catch (e: any) {
    const msg = errToMessage(e)
    const errorSide: ErrorSide = type === 'download' ? 'local' : 'remote'
    sendProgress(event, {
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })
    return { status: 'error', message: msg, code: e?.code, taskKey: progressTaskKey, host, errorSide }
  }

  let readErr: any = null
  let writeErr: any = null

  readStream.on('error', (e: any) => {
    readErr ??= e
    if (!firstErr) {
      markFirstErr(type === 'download' ? 'remote' : 'local', e)
    }
  })

  writeStream.on('error', (e: any) => {
    writeErr ??= e
    if (!firstErr) {
      markFirstErr(type === 'download' ? 'local' : 'remote', e)
    }
  })

  activeTasks.set(progressTaskKey, {
    read: readStream,
    write: writeStream,
    localPath: type === 'download' ? finalLocalPath : srcPath,
    cancel: () => {
      isCancelled = true
      readStream.destroy()
      writeStream.destroy()
    }
  })

  hookStartOnce(readStream, writeStream, ensureCreated)

  readStream.on('data', (chunk: Buffer) => {
    transferred += chunk.length
    const now = Date.now()
    if (now - lastEmitTime > 150 || (total > 0 && transferred >= total)) {
      sendProgress(event, {
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: transferred,
        total: totalUi,
        status: 'running' as TaskStatus
      })
      lastEmitTime = now
    }
  })

  try {
    await pipeline(readStream, writeStream)
    activeTasks.delete(progressTaskKey)

    sendProgress(event, {
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: total > 0 ? total || transferred : 1,
      total: totalUi,
      status: 'success' as TaskStatus
    })

    return { status: 'success', remotePath: remotePathForUI, taskKey: progressTaskKey, host }
  } catch (e: any) {
    activeTasks.delete(progressTaskKey)

    if (isCancelled || isPrematureStreamError(e)) {
      sendProgress(event, {
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'failed' as TaskStatus,
        message: 'Transfer was cancelled by user',
        errorSide: 'local'
      })
      return { status: 'cancelled', message: 'Transfer was cancelled by user', taskKey: progressTaskKey, host, errorSide: 'local' }
    }

    const primaryErr = firstErr || readErr || writeErr || e
    const msg = errToMessage(primaryErr)

    let errorSide: ErrorSide
    if (firstErrSide) {
      errorSide = firstErrSide
    } else {
      errorSide = type === 'download' ? (writeErr ? 'local' : 'remote') : readErr ? 'local' : 'remote'
    }

    sendProgress(event, {
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })

    return { status: 'error', message: msg, code: primaryErr?.code, taskKey: progressTaskKey, host, errorSide }
  }
}

// remote directory -> local directory
export async function handleDirectoryDownload(event: any, id: string, remoteDir: string, localDir: string): Promise<TransferResult> {
  const sftp = await tryEnsureSftpReady(event, id)
  const host = getSftpHostLabel(id, sftp)

  const fromDir = normalizeRemotePath(remoteDir)
  const toParent = path.resolve(localDir)
  const dirName = path.posix.basename(fromDir)
  const finalLocalBase = path.join(toParent, dirName)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${id}:dl-dir:${fromDir}:${finalLocalBase}:${nonce}`

  if (!sftp) {
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: 1,
      total: 1,
      status: 'error',
      message: 'Sftp Not connected',
      errorSide: 'remote'
    })
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote' }
  }
  const mappedFromDir = await toRemoteSftpPath(sftp, id, fromDir)

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  sendProgress(event, {
    id,
    host,
    taskKey: dirTaskKey,
    type: 'download',
    isGroup: true,
    groupKind: 'directory',
    remotePath: fromDir,
    destPath: finalLocalBase,
    bytes: 0,
    total: 1,
    status: 'running',
    stage: 'scanning'
  })

  try {
    await fs.promises.mkdir(finalLocalBase, { recursive: true })
  } catch (e: any) {
    const msg = errToMessage(e)
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'local'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'local' }
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  let scanCounter = 0
  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false

  const reportGroup = (extra?: Record<string, any>) => {
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: 'running',
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  const pool = createAsyncPool<{ r: string; l: string }>(async (t) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${t.r}`

    const r = await handleStreamTransfer(event, id, t.r, t.l, 'download', true, {
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, 5)

  const scan = async (curFrom: string, curMappedFrom: string, curTo: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const list = await sftpReaddir(sftp, curMappedFrom)
    for (const ent of list) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const name = entryName(ent)
      if (!name) continue

      const rPath = path.posix.join(curFrom, name)
      const mappedRPath = path.posix.join(curMappedFrom, name)
      const lPath = path.join(curTo, name)

      if (isDirEntry(ent)) {
        await fs.promises.mkdir(lPath, { recursive: true })
        await scan(rPath, mappedRPath, lPath)
      } else {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${rPath}`

        sendProgress(event, {
          id,
          host,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          type: 'download',
          isGroup: false,
          groupKind: 'file',
          remotePath: rPath,
          destPath: lPath,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ r: rPath, l: lPath })
      }
    }
  }

  try {
    await scan(fromDir, mappedFromDir, finalLocalBase)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'local')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, host, errorSide: 'local' }
      : tr || { status: 'error', message: msg, host, errorSide: 'local' }
  }

  sendProgress(event, {
    id,
    host,
    taskKey: dirTaskKey,
    type: 'download',
    isGroup: true,
    groupKind: 'directory',
    remotePath: fromDir,
    destPath: finalLocalBase,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', localPath: finalLocalBase, host }
}

// local directory -> remote directory
export async function handleDirectoryTransfer(event: any, id: string, localDir: string, remoteDir: string): Promise<TransferResult> {
  const sftp = await tryEnsureSftpReady(event, id)
  const host = getSftpHostLabel(id, sftp)

  const absLocal = path.resolve(localDir)
  const remoteParent = normalizeRemotePath(remoteDir)
  const originalDirName = path.basename(absLocal)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${id}:up-dir:${absLocal}:${remoteParent}:${nonce}`

  if (!sftp) {
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: remoteParent,
      bytes: 1,
      total: 1,
      status: 'error',
      message: 'Sftp Not connected',
      errorSide: 'remote'
    })
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote' }
  }
  const mappedRemoteParent = await toRemoteSftpPath(sftp, id, remoteParent)

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  sendProgress(event, {
    id,
    host,
    taskKey: dirTaskKey,
    type: 'upload',
    isGroup: true,
    groupKind: 'directory',
    remotePath: remoteParent,
    bytes: 0,
    total: 1,
    status: 'running',
    stage: 'scanning'
  })

  try {
    const st = await fs.promises.stat(absLocal)
    if (!st.isDirectory()) throw Object.assign(new Error(`Not a directory: ${absLocal}`), { code: 'ENOTDIR' })
    await fs.promises.readdir(absLocal)
  } catch (e: any) {
    const msg = errToMessage(e)
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: remoteParent,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'local'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'local', localPath: absLocal }
  }

  let finalDirName = originalDirName
  try {
    finalDirName = await getUniqueRemoteName(sftp, mappedRemoteParent, originalDirName, true)
  } catch (e: any) {
    const msg = errToMessage(e)
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: remoteParent,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'remote'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  const finalRemoteBaseDir = path.posix.join(remoteParent, finalDirName)
  const mappedFinalRemoteBaseDir = path.posix.join(mappedRemoteParent, finalDirName)

  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false
  let scanCounter = 0

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))

  const reportGroup = (extra?: Record<string, any>) => {
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: 'running',
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  try {
    await sftpMkdirpForTransfer(sftp, mappedFinalRemoteBaseDir)
  } catch (e: any) {
    const msg = errToMessage(e)
    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'remote'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  const pool = createAsyncPool<{ local: string; remote: string }>(async (task) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${task.remote}`

    const r = await handleStreamTransfer(event, id, task.local, task.remote, 'upload', true, {
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, 3)

  const scan = async (currentLocal: string, currentRemote: string, currentMappedRemote: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const entries = await fs.promises.readdir(currentLocal, { withFileTypes: true })

    for (const entry of entries) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const lPath = path.join(currentLocal, entry.name)
      const rPath = path.posix.join(currentRemote, entry.name)
      const mappedRPath = path.posix.join(currentMappedRemote, entry.name)

      if (entry.isDirectory()) {
        await sftpMkdirpForTransfer(sftp, mappedRPath)
        await scan(lPath, rPath, mappedRPath)
      } else if (entry.isFile()) {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${rPath}`

        sendProgress(event, {
          id,
          host,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          type: 'upload',
          isGroup: false,
          groupKind: 'file',
          remotePath: rPath,
          localPath: lPath,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ local: lPath, remote: rPath })
      }
    }
  }

  try {
    await scan(absLocal, finalRemoteBaseDir, mappedFinalRemoteBaseDir)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    sendProgress(event, {
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'remote')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, host, errorSide: 'local' }
      : tr || { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  sendProgress(event, {
    id,
    host,
    taskKey: dirTaskKey,
    type: 'upload',
    isGroup: true,
    groupKind: 'directory',
    remotePath: finalRemoteBaseDir,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', host }
}

export const initSftpOnConnection = (conn: Client, connectionId: string, metadata?: SftpConnectionMetadata): Promise<void> => {
  return new Promise<void>((resolve) => {
    try {
      conn.sftp((err, sftp) => {
        if (err || !sftp) {
          connectionStatus.set(connectionId, {
            sftpAvailable: false,
            sftpError: err?.message || 'SFTP object is empty'
          })
          sftpConnections.set(connectionId, {
            isSuccess: false,
            error: `sftp init error: "${err?.message || 'SFTP object is empty'}"`
          })
          return resolve()
        }

        const existingMetadata = metadata || getSftpMetadata(connectionId)
        const probePath = existingMetadata?.provider?.startsWith('jumpserver') ? '/' : '.'

        // Probe the session with a cheap read to avoid caching a dead SFTP wrapper.
        sftp.readdir(probePath, (readDirErr) => {
          if (readDirErr) {
            connectionStatus.set(connectionId, {
              sftpAvailable: false,
              sftpError: readDirErr.message
            })
            try {
              sftp.end()
            } catch {}
            sftpConnections.set(connectionId, {
              isSuccess: false,
              error: `sftp readdir error: "${readDirErr.message}"`
            })
          } else {
            const finalMetadata = existingMetadata || { provider: 'ssh' as const }
            sftpConnections.set(connectionId, { isSuccess: true, sftp, ...finalMetadata })
            setSftpMetadata(connectionId, finalMetadata)
            connectionStatus.set(connectionId, { sftpAvailable: true })
          }
          resolve()
        })
      })
    } catch (err: any) {
      connectionStatus.set(connectionId, {
        sftpAvailable: false,
        sftpError: err?.message || String(err)
      })
      sftpConnections.set(connectionId, {
        isSuccess: false,
        error: `sftp init error: "${err?.message || String(err)}"`
      })
      resolve()
    }
  })
}

const isSkippedConn = (conn: Client | undefined, skipped?: Client) => {
  return !!conn && !!skipped && conn === skipped
}

// Prefer an existing SSH connection when it is still alive and not explicitly skipped.
const findReusableSftpConn = (connectionInfo: any, skippedConn?: Client): Client | undefined => {
  const { id } = connectionInfo

  const direct = sshConnections.get(id)
  if (direct && !isSkippedConn(direct, skippedConn) && isClientSocketAlive(direct)) return direct

  if (id) {
    const prefix = id.substring(0, id.lastIndexOf(':') + 1)

    for (const [existingId, existingConn] of sshConnections.entries()) {
      const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
      if (
        existingId.startsWith(prefix) &&
        sessionPart.startsWith('files-') &&
        !isSkippedConn(existingConn, skippedConn) &&
        isClientSocketAlive(existingConn)
      ) {
        return existingConn
      }
    }

    for (const [existingId, existingConn] of sshConnections.entries()) {
      if (existingId.startsWith(prefix) && !isSkippedConn(existingConn, skippedConn) && isClientSocketAlive(existingConn)) return existingConn
    }
  }

  return undefined
}

// ssh2 keeps socket state on the client instance, so this is the cheapest health signal we can read.
const isClientSocketAlive = (conn?: Client) => {
  const client = conn as any
  if (!client) return false

  const sock = client._sock
  if (!sock) return true

  return !sock.destroyed && !sock.closed
}

const buildJumpServerSftpConnection = (connectionInfo: any) => {
  const result = buildJumpServerSftpUsername({
    username: connectionInfo?.username,
    targetAccountUsername: connectionInfo?.targetAccountUsername,
    preferredLoginUsername: connectionInfo?.preferredLoginUsername,
    preferredLoginUserName: connectionInfo?.preferredLoginUserName,
    loginUsername: connectionInfo?.login_username,
    loginUserName: connectionInfo?.login_user_name,
    targetAssetUuid: connectionInfo?.targetAssetUuid,
    targetAsset: connectionInfo?.targetAsset,
    targetAssetId: connectionInfo?.targetAssetId,
    assetTarget: connectionInfo?.assetTarget,
    targetIp: connectionInfo?.targetIp,
    targetHostname: connectionInfo?.targetHostname
  })
  const targetHostname = String(connectionInfo?.targetHostname || '').trim() || undefined
  const targetIp = String(connectionInfo?.targetIp || '').trim() || undefined
  const preferRootTree = !!targetHostname || !!targetIp

  if (result.mode === 'direct-asset' && !preferRootTree) {
    return {
      username: result.username,
      metadata: {
        provider: 'jumpserver-direct-asset' as const,
        mode: result.mode,
        targetAsset: result.targetAsset,
        targetAccountUsername: result.targetAccountUsername,
        targetHostname,
        targetIp
      },
      result
    }
  }

  return {
    username: String(connectionInfo?.username || ''),
    metadata: {
      provider: 'jumpserver-root' as const,
      mode: 'root-tree' as const,
      targetAsset: String(
        connectionInfo?.targetAssetUuid || connectionInfo?.targetAssetId || connectionInfo?.targetAsset || connectionInfo?.assetTarget || ''
      ).trim(),
      targetAccountUsername: String(connectionInfo?.targetAccountUsername || '').trim() || undefined,
      targetHostname,
      targetIp
    },
    result
  }
}

const findLiveConnectionForSftpId = (id: string): Client | undefined => {
  const metadata = getSftpMetadata(id)
  if (metadata?.provider?.startsWith('jumpserver')) {
    const directOwnedJumpServer = sftpOwnedJumpServerConnections.get(id)
    if (isClientSocketAlive(directOwnedJumpServer)) return directOwnedJumpServer
    return undefined
  }

  const directSsh = sshConnections.get(id)
  if (isClientSocketAlive(directSsh)) return directSsh

  const directJumpServer = jumpserverConnections.get(id)?.conn
  if (isClientSocketAlive(directJumpServer)) return directJumpServer

  const directOwnedJumpServer = sftpOwnedJumpServerConnections.get(id)
  if (isClientSocketAlive(directOwnedJumpServer)) return directOwnedJumpServer

  if (!id) return undefined

  const lastSeparator = id.lastIndexOf(':')
  if (lastSeparator < 0) return undefined

  const prefix = id.substring(0, lastSeparator + 1)

  for (const [existingId, existingConn] of sshConnections.entries()) {
    if (existingId.startsWith(prefix) && isClientSocketAlive(existingConn)) return existingConn
  }

  for (const [existingId, existingData] of jumpserverConnections.entries()) {
    if (existingId.startsWith(prefix) && isClientSocketAlive(existingData?.conn)) return existingData.conn
  }

  for (const [existingId, existingConn] of sftpOwnedJumpServerConnections.entries()) {
    if (existingId.startsWith(prefix) && isClientSocketAlive(existingConn)) return existingConn
  }

  return undefined
}

// JumpServer reuse is read-only here: dead connect-side records are ignored, not deleted.
const findReusableJumpServerConn = (_connectionInfo: any, _skippedConn?: Client): Client | undefined => {
  // Keep Files SFTP on a dedicated JumpServer transport. Reusing an interactive
  // JumpServer terminal connection can make the SFTP channel short-lived and
  // causes repeated recover.live rebuilds while browsing.
  return undefined
}

// Reuse priority: active SFTP/SSH session first, then JumpServer/shared pooled SSH connection.
const findReusableConn = (connectionInfo: any, skippedConn?: Client): Client | undefined => {
  const { sshType, host, port, username } = connectionInfo

  const reusableSftpConn = findReusableSftpConn(connectionInfo, skippedConn)
  if (reusableSftpConn) return reusableSftpConn

  if (sshType === 'jumpserver') {
    const reusableJumpServerConn = findReusableJumpServerConn(connectionInfo, skippedConn)
    if (reusableJumpServerConn) return reusableJumpServerConn
  }

  if (host && username) {
    const poolKey = getConnectionPoolKey(host, port || 22, username)
    const pooled = sshConnectionPool.get(poolKey)
    if (pooled?.conn && !isSkippedConn(pooled.conn, skippedConn) && isClientSocketAlive(pooled.conn)) return pooled.conn
  }

  return undefined
}

export const connectSftpReuseFirst = async (event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const { id } = connectionInfo
  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)

  markPending(id, requestId)
  const reused = findReusableConn(connectionInfo, options?.skipReusableConn)

  if (reused) {
    try {
      const metadata = connectionInfo?.sshType === 'jumpserver' ? buildJumpServerSftpConnection(connectionInfo).metadata : undefined
      await initSftpOnConnection(reused, id, metadata)

      const p = getPending(id)
      if (p?.cancelled) {
        await closeSftpOnly(id)
        clearPending(id)
        return { status: 'cancelled', message: 'cancelled' }
      }

      const st = connectionStatus.get(id) as any
      if (st?.sftpAvailable) {
        clearPending(id)
        return { status: 'connected', message: 'SFTP ready (reused existing SSH connection)' }
      }

      // Mark the reused SFTP as unavailable and fall back to a fresh connection below.
      sftpConnections.delete(id)
      connectionStatus.set(id, {
        sftpAvailable: false,
        sftpError: st?.sftpError || 'reused ssh not available'
      })
    } catch (e) {
      // Reuse failed; keep connect-side state untouched and create a new SFTP connection instead.
      sftpConnections.delete(id)
      connectionStatus.set(id, {
        sftpAvailable: false,
        sftpError: (e as Error)?.message || 'reused ssh not available'
      })
    }
  }

  clearPending(id)
  return await connectSftpNew(event, connectionInfo, { skipReusableConn: reused })
}

// Keep SFTP state in sync when the underlying transport closes unexpectedly.
const markSftpDead = async (id: string, reason = 'SFTP connection lost') => {
  const sid = String(id || '')
  if (!sid) return

  try {
    const rec = sftpConnections.get(sid) as any
    if (rec?.sftp) {
      try {
        rec.sftp.end()
      } catch {}
    }
  } catch {}

  sftpConnections.delete(sid)
  connectionStatus.set(sid, {
    sftpAvailable: false,
    sftpError: reason
  })
}

export const connectSftpNew = async (event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const { id, sshType } = connectionInfo

  if (sshType === 'jumpserver') {
    return await connectJumpServerSftpNew(event, connectionInfo, options)
  }

  const conn = new SSHClient()
  const { host, port, username, password, privateKey, passphrase, needProxy, proxyConfig, proxyCommand, connIdentToken, asset_type } = connectionInfo

  const packageInfo = getPackageInfo()
  const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
  const ident = `${packageInfo.name}_${packageInfo.version}${identToken}`
  const algorithms = getAlgorithmsByAssetType(asset_type)

  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
  markPending(id, requestId, conn as any)

  // This path creates an SFTP-owned SSH connection when reuse is not possible.
  const connectConfig: any = {
    host,
    port: port || 22,
    username,
    keepaliveInterval: 10000,
    readyTimeout: KeyboardInteractiveTimeout,
    tryKeyboard: true,
    ident,
    algorithms
  }

  if (privateKey) {
    connectConfig.privateKey = privateKey
    if (passphrase) connectConfig.passphrase = passphrase
  } else if (password) {
    connectConfig.password = password
  } else {
    clearPending(id)
    return { status: 'error', message: 'No valid authentication method provided' }
  }

  try {
    if (proxyCommand) {
      connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, port || 22)
      delete connectConfig.host
      delete connectConfig.port
    } else if (needProxy) {
      connectConfig.sock = await createProxySocket(proxyConfig, host, port || 22)
    }
  } catch (err: any) {
    clearPending(id)
    return { status: 'error', message: `Failed to establish a transport layer tunnel: ${err?.message || String(err)}` }
  }

  return new Promise((resolve) => {
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      ;(async () => {
        try {
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }
          await handleRequestKeyboardInteractive(event, id, prompts, finish)
        } catch (e: any) {
          conn.end()
          clearPending(id)
          resolve({ status: 'error', message: e?.message || String(e) })
        }
      })()
    })

    conn.on('ready', () => {
      ;(async () => {
        sshConnections.set(id, conn)
        try {
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            clearPending(id)
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }

          await initSftpOnConnection(conn as any, id)

          const p2 = getPending(id)
          if (p2?.cancelled) {
            await closeSftpOnly(id)
            conn.end()
            clearPending(id)
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }

          clearPending(id)
          const st = connectionStatus.get(id) as any
          resolve(
            st?.sftpAvailable
              ? { status: 'connected', message: 'SFTP ready (new SFTP-only SSH connection)' }
              : { status: 'error', message: st?.sftpError || 'SFTP init failed' }
          )
        } catch (e: any) {
          clearPending(id)
          resolve({ status: 'error', message: e?.message || String(e) })
        }
      })()
    })

    conn.on('error', (err: any) => {
      const p = getPending(id)
      if (p?.cancelled) {
        clearPending(id)
        return resolve({ status: 'cancelled', message: 'cancelled' })
      }
      clearPending(id)
      resolve({ status: 'error', message: `SFTP connection failed: ${err.message}` })
    })

    conn.on('close', async () => {
      await markSftpDead(id, 'SFTP connection closed')
    })

    conn.on('end', async () => {
      await markSftpDead(id, 'SFTP connection ended')
    })
    conn.connect(connectConfig)
  })
}

const connectJumpServerSftpNew = async (_event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const { id, host, port, password, privateKey, passphrase, needProxy, proxyConfig, proxyCommand, connIdentToken, asset_type } = connectionInfo
  const jumpServerSftp = buildJumpServerSftpConnection(connectionInfo)

  // Try a live JumpServer connect-side session first, then fall back to an SFTP-owned one.
  const reusableConn = findReusableJumpServerConn(connectionInfo, options?.skipReusableConn)
  if (reusableConn) {
    const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
    markPending(id, requestId)
    await initSftpOnConnection(reusableConn, id, jumpServerSftp.metadata)

    const p = getPending(id)
    if (p?.cancelled) {
      await closeSftpOnly(id)
      clearPending(id)
      return { status: 'cancelled', message: 'cancelled' }
    }

    clearPending(id)
    const st = connectionStatus.get(id) as any
    if (st?.sftpAvailable) {
      return { status: 'connected', message: 'SFTP ready (reused JumpServer connection)' }
    }
  }

  const conn = new SSHClient()

  const packageInfo = getPackageInfo()
  const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
  const ident = `${packageInfo.name}_${packageInfo.version}${identToken}`
  const algorithms = getAlgorithmsByAssetType(asset_type)

  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
  markPending(id, requestId, conn as any)

  const connectConfig: any = {
    host,
    port: port || 22,
    username: jumpServerSftp.username,
    keepaliveInterval: 10000,
    readyTimeout: 180000,
    tryKeyboard: true,
    ident,
    algorithms
  }

  if (privateKey) {
    try {
      connectConfig.privateKey = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey)
      if (passphrase) connectConfig.passphrase = passphrase
    } catch (err: any) {
      clearPending(id)
      return { status: 'error', message: `Private key format error: ${err?.message || String(err)}` }
    }
  } else if (password) {
    connectConfig.password = password
  } else {
    clearPending(id)
    return { status: 'error', message: 'Missing authentication info: private key or password required' }
  }

  try {
    if (proxyCommand) {
      connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, port || 22)
      delete connectConfig.host
      delete connectConfig.port
    } else if (needProxy) {
      connectConfig.sock = await createProxySocket(proxyConfig, host, port || 22)
    }
  } catch (err: any) {
    clearPending(id)
    return { status: 'error', message: `Failed to establish a transport layer tunnel: ${err?.message || String(err)}` }
  }

  return new Promise((resolve) => {
    let settled = false

    const safeResolve = (data) => {
      if (settled) return
      settled = true
      resolve(data)
    }

    // Clean only the JumpServer resources created by SFTP itself.
    const cleanupJumpServerSftpOnlySession = async (reason: string) => {
      sftpOwnedJumpServerConnections.delete(id)
      await markSftpDead(id, reason)
    }

    conn.on('ready', async () => {
      try {
        // Store SFTP-owned JumpServer resources separately from connect-managed sessions.
        sftpOwnedJumpServerConnections.set(id, conn)

        await initSftpOnConnection(conn, id, jumpServerSftp.metadata)

        clearPending(id)

        const st = connectionStatus.get(id)
        safeResolve(
          st?.sftpAvailable
            ? { status: 'connected', message: 'SFTP ready (new JumpServer connection)' }
            : { status: 'error', message: st?.sftpError || 'SFTP init failed' }
        )
      } catch (e: any) {
        clearPending(id)
        conn.end()
        safeResolve({ status: 'error', message: e?.message || String(e) })
      }
    })

    conn.on('error', (err) => {
      clearPending(id)
      conn.end()
      safeResolve({
        status: 'error',
        message: `JumpServer SFTP connection failed: ${err.message}`
      })
    })

    conn.on('close', async () => {
      await cleanupJumpServerSftpOnlySession('SFTP connection closed')
    })

    conn.on('end', async () => {
      await cleanupJumpServerSftpOnlySession('SFTP connection ended')
    })

    conn.connect(connectConfig)
  })
}

type PendingSftp = {
  requestId: string
  cancelled: boolean
  conn?: Client
}
const pendingSftpConnects = new Map<string, PendingSftp>()

const markPending = (id: string, requestId: string, conn?: Client) => {
  pendingSftpConnects.set(id, { requestId, cancelled: false, conn })
}
const getPending = (id: string) => pendingSftpConnects.get(id)
const clearPending = (id: string) => pendingSftpConnects.delete(id)

export const closeSftpOnly = async (connectionId: string): Promise<{ status: string; message: string }> => {
  const id = String(connectionId || '')
  if (!id) return { status: 'error', message: 'missing id' }

  const actualId = findSftpRecordKey(id)

  try {
    const p = pendingSftpConnects.get(actualId)
    if (p) {
      p.cancelled = true
      try {
        p.conn?.end()
      } catch {}
      clearPending(actualId)
    }

    const rec = sftpConnections.get(actualId) as any
    if (rec?.sftp) {
      try {
        rec.sftp.end()
      } catch {}
    }

    sftpConnections.delete(actualId)
    clearSftpMetadata(actualId)
    connectionStatus.set(actualId, { sftpAvailable: false, sftpError: 'SFTP closed by user' })

    // Only tear down JumpServer resources that were created by SFTP itself.
    const ownedConn = sftpOwnedJumpServerConnections.get(actualId)
    if (ownedConn) {
      try {
        ownedConn.end()
      } catch {}
      sftpOwnedJumpServerConnections.delete(actualId)
    }

    return { status: 'closed', message: 'SFTP closed' }
  } catch (e: any) {
    return { status: 'error', message: e?.message || String(e) }
  }
}

type CopyOrMoveBySftpArgs = {
  id: string
  srcPath: string
  targetPath: string
  action: 'copy' | 'move'
}

type SftpCopyOrMoveResult = {
  status: 'success' | 'error' | 'cancelled'
  message?: string
  path?: string
}

async function sftpStatSafe(sftp: any, p: string): Promise<any | null> {
  try {
    return await sftpStat(sftp, p)
  } catch {
    return null
  }
}

function isRemoteDirectoryStat(st: any) {
  return !!st?.isDirectory?.() || isRemoteDir(st)
}

async function resolveRemoteCopyMoveTarget(
  sftp: any,
  id: string,
  srcPath: string,
  targetPath: string
): Promise<{
  srcStat: any
  finalPath: string
  finalMappedPath: string
  mappedSrcPath: string
  isDir: boolean
}> {
  const normalizedSrc = normalizeRemotePath(srcPath)
  const normalizedTarget = normalizeRemotePath(targetPath)
  const targetHadTrailingSlash = toPosix(targetPath || '').endsWith('/')
  const mappedSrcPath = await toRemoteSftpPath(sftp, id, normalizedSrc)
  const mappedTargetPath = await toRemoteSftpPath(sftp, id, normalizedTarget)

  const srcStat = await sftpStat(sftp, mappedSrcPath)
  const isDir = isRemoteDirectoryStat(srcStat)
  const srcBaseName = path.posix.basename(normalizedSrc)

  const targetStat = await sftpStatSafe(sftp, mappedTargetPath)

  let candidatePath = normalizedTarget
  let candidateMappedPath = mappedTargetPath

  if (targetStat && isRemoteDirectoryStat(targetStat)) {
    candidatePath = path.posix.join(normalizedTarget, srcBaseName)
    candidateMappedPath = path.posix.join(mappedTargetPath, srcBaseName)
  } else if (targetHadTrailingSlash) {
    candidatePath = path.posix.join(normalizedTarget, srcBaseName)
    candidateMappedPath = path.posix.join(mappedTargetPath, srcBaseName)
  }

  const parentDir = path.posix.dirname(candidateMappedPath)
  const uiParentDir = path.posix.dirname(candidatePath)
  const baseName = path.posix.basename(candidatePath)
  const uniqueName = await getUniqueRemoteName(sftp, parentDir, baseName, isDir)
  const finalPath = path.posix.join(uiParentDir, uniqueName)
  const finalMappedPath = path.posix.join(parentDir, uniqueName)

  return {
    srcStat,
    finalPath,
    finalMappedPath,
    mappedSrcPath,
    isDir
  }
}

async function copyOrMoveBySftp(event: Electron.IpcMainInvokeEvent, args: CopyOrMoveBySftpArgs): Promise<SftpCopyOrMoveResult> {
  const { id, srcPath, targetPath, action } = args
  const sftp = await tryEnsureSftpReady(event, id)

  if (!sftp) {
    return { status: 'error', message: 'Sftp Not connected' }
  }

  try {
    const { finalPath, finalMappedPath, mappedSrcPath, isDir } = await resolveRemoteCopyMoveTarget(sftp, id, srcPath, targetPath)

    if (action === 'move') {
      if (normalizeRemotePath(srcPath) === finalPath) {
        return { status: 'success', path: finalPath }
      }

      await new Promise<void>((resolve, reject) => {
        sftp.rename(mappedSrcPath, finalMappedPath, (err: any) => {
          if (err) reject(err)
          else resolve()
        })
      })

      return {
        status: 'success',
        path: finalPath
      }
    }

    if (isDir) {
      const res = await transferDirR2R(event, {
        fromId: id,
        toId: id,
        fromDir: normalizeRemotePath(srcPath),
        toDir: path.posix.dirname(finalPath),
        autoRename: false
      })

      if (res.status === 'success') {
        return {
          status: 'success',
          path: res.remotePath || finalPath
        }
      }

      if (res.status === 'cancelled') {
        return {
          status: 'cancelled',
          message: res.message
        }
      }

      return {
        status: 'error',
        message: res.message || 'Copy directory failed'
      }
    }

    const res = await transferFileR2R(event, {
      fromId: id,
      toId: id,
      fromPath: normalizeRemotePath(srcPath),
      toPath: finalPath,
      autoRename: false
    })

    if (res.status === 'success') {
      return {
        status: 'success',
        path: res.remotePath || finalPath
      }
    }

    if (res.status === 'cancelled') {
      return {
        status: 'cancelled',
        message: res.message
      }
    }

    return {
      status: 'error',
      message: res.message || 'Copy file failed'
    }
  } catch (e: any) {
    return {
      status: 'error',
      message: e?.message || String(e)
    }
  }
}
