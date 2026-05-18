export type JumpServerSftpMode = 'direct-asset' | 'root-tree'

export type JumpServerSftpBuildInput = {
  username?: string
  targetAccountUsername?: string
  preferredLoginUsername?: string
  preferredLoginUserName?: string
  loginUsername?: string
  loginUserName?: string
  targetAssetUuid?: string
  targetAsset?: string
  targetAssetId?: string
  assetTarget?: string
  targetIp?: string
  targetHostname?: string
}

type RootTreeReason = 'missing-jms-username' | 'missing-target-account' | 'missing-target-asset' | 'unsupported-separator'

export type JumpServerSftpBuildResult =
  | {
      mode: 'direct-asset'
      username: string
      targetAccountUsername: string
      targetAsset: string
      separator: '@' | '#'
      protocol: 'sftp'
    }
  | {
      mode: 'root-tree'
      username: string
      reason: RootTreeReason
    }

const firstNonEmpty = (...values: Array<unknown>) => {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return ''
}

const chooseDirectSeparator = (parts: string[]): '@' | '#' | null => {
  if (parts.every((part) => !part.includes('@'))) return '@'
  if (parts.every((part) => !part.includes('#'))) return '#'
  return null
}

export function buildJumpServerSftpUsername(input: JumpServerSftpBuildInput): JumpServerSftpBuildResult {
  const username = firstNonEmpty(input.username)
  if (!username) {
    return { mode: 'root-tree', username: '', reason: 'missing-jms-username' }
  }

  const targetAccountUsername = firstNonEmpty(
    input.targetAccountUsername,
    input.preferredLoginUsername,
    input.preferredLoginUserName,
    input.loginUsername,
    input.loginUserName
  )
  if (!targetAccountUsername) {
    return { mode: 'root-tree', username, reason: 'missing-target-account' }
  }

  const targetAsset = firstNonEmpty(
    input.targetAssetUuid,
    input.targetAssetId,
    input.targetAsset,
    input.assetTarget,
    input.targetIp,
    input.targetHostname
  )
  if (!targetAsset) {
    return { mode: 'root-tree', username, reason: 'missing-target-asset' }
  }

  const protocol = 'sftp' as const
  const separator = chooseDirectSeparator([username, protocol, targetAccountUsername, targetAsset])
  if (!separator) {
    return { mode: 'root-tree', username, reason: 'unsupported-separator' }
  }

  return {
    mode: 'direct-asset',
    username: [username, protocol, targetAccountUsername, targetAsset].join(separator),
    targetAccountUsername,
    targetAsset,
    separator,
    protocol
  }
}

export function hasJumpServerSftpDirectTarget(input: JumpServerSftpBuildInput): boolean {
  return !!firstNonEmpty(input.targetAssetUuid, input.targetAssetId, input.targetAsset, input.assetTarget, input.targetIp, input.targetHostname)
}
