import { describe, expect, it } from 'vitest'
import { buildJumpServerSftpUsername, hasJumpServerSftpDirectTarget } from '../sftpDirect'

describe('buildJumpServerSftpUsername', () => {
  it('builds KoKo direct SFTP username with asset uuid and target account', () => {
    const result = buildJumpServerSftpUsername({
      username: 'jms-user',
      targetAccountUsername: 'root',
      targetAssetUuid: 'asset-uuid'
    })

    expect(result).toEqual({
      mode: 'direct-asset',
      username: 'jms-user@sftp@root@asset-uuid',
      targetAccountUsername: 'root',
      targetAsset: 'asset-uuid',
      separator: '@',
      protocol: 'sftp'
    })
  })

  it('uses # separator when a username segment contains @', () => {
    const result = buildJumpServerSftpUsername({
      username: 'jms@example.com',
      targetAccountUsername: 'root',
      targetAssetUuid: 'asset-uuid'
    })

    expect(result).toMatchObject({
      mode: 'direct-asset',
      username: 'jms@example.com#sftp#root#asset-uuid',
      separator: '#'
    })
  })

  it('falls back to root tree when target account is missing', () => {
    const result = buildJumpServerSftpUsername({
      username: 'jms-user',
      targetAssetUuid: 'asset-uuid'
    })

    expect(result).toEqual({ mode: 'root-tree', username: 'jms-user', reason: 'missing-target-account' })
  })

  it('detects whether a direct target exists independently from account availability', () => {
    expect(hasJumpServerSftpDirectTarget({ targetAssetUuid: 'asset-uuid' })).toBe(true)
    expect(hasJumpServerSftpDirectTarget({ targetIp: '10.0.0.1' })).toBe(true)
    expect(hasJumpServerSftpDirectTarget({ username: 'jms-user' })).toBe(false)
  })
})
