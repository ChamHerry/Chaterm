import { describe, it, expect } from 'vitest'
import { parseJumpserverOutput, parseJumpServerUsers, hasUserSelectionPrompt } from '../parser'

describe('JumpServer Parser', () => {
  describe('parseJumpserverOutput', () => {
    describe('parse Chinese format', () => {
      const chineseOutput = `
  ID | 名称                             | 地址        | 平台           | 组织            | 备注
-----+----------------------------------+-------------+----------------+-----------------+-------------------------------
  1  | demo-app-01                      | 192.0.2.10   | Linux          | ExampleOrg      | 示例资产A
  2  | demo-db-01                       | 198.51.100.20| Linux          | ExampleOrg      | 数据库节点
  3  | demo-cache-01                    | 203.0.113.30 | Linux          | ExampleOrg      |
  4  | qa-proxy-01                      | 192.0.2.40   | Linux          | ExampleOrg      | 代理
  5  | ops-bastion-01                   | 198.51.100.50| Linux          | ExampleOrg      | 跳板
页码：1，每页行数：15，总页数：6，总数量：88
提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n
搜索：
`

      it('should parse asset list with Chinese headers', () => {
        const result = parseJumpserverOutput(chineseOutput)

        expect(result.assets).toHaveLength(5)
        expect(result.assets[0]).toEqual({
          id: 1,
          name: 'demo-app-01',
          address: '192.0.2.10',
          platform: 'Linux',
          organization: 'ExampleOrg',
          comment: '示例资产A'
        })
        expect(result.assets[2]).toEqual({
          id: 3,
          name: 'demo-cache-01',
          address: '203.0.113.30',
          platform: 'Linux',
          organization: 'ExampleOrg',
          comment: ''
        })
      })

      it('should parse Chinese pagination info', () => {
        const result = parseJumpserverOutput(chineseOutput)

        expect(result.pagination).toEqual({
          currentPage: 1,
          totalPages: 6
        })
      })
    })

    describe('parse English format', () => {
      const englishOutput = `
  ID | NAME                             | ADDRESS     | PLATFORM       | ORGANIZATION       | COMMENT
-----+----------------------------------+-------------+----------------+--------------------+----------------------------
  1  | demo-app-01                      | 192.0.2.10   | Linux          | ExampleOrg      | sample asset A
  2  | demo-db-01                       | 198.51.100.20| Linux          | ExampleOrg      | database node
  3  | demo-cache-01                    | 203.0.113.30 | Linux          | ExampleOrg      | cache layer
  4  | qa-proxy-01                      | 192.0.2.40   | Linux          | ExampleOrg      | proxy
  5  | ops-bastion-01                   | 198.51.100.50| Linux          | ExampleOrg      | bastion host
  6  | staging-worker-02                | 203.0.113.60 | Linux          | ExampleOrg      | autoscale node
Page: 1, Count: 15, Total Page: 6, Total Count: 88
Enter ID number directly login, multiple search use // + field, such as: //16 Page up: b        Page down: n
Search:
`

      it('should parse asset list with English headers', () => {
        const result = parseJumpserverOutput(englishOutput)

        expect(result.assets).toHaveLength(6)
        expect(result.assets[0]).toEqual({
          id: 1,
          name: 'demo-app-01',
          address: '192.0.2.10',
          platform: 'Linux',
          organization: 'ExampleOrg',
          comment: 'sample asset A'
        })
        expect(result.assets[5]).toEqual({
          id: 6,
          name: 'staging-worker-02',
          address: '203.0.113.60',
          platform: 'Linux',
          organization: 'ExampleOrg',
          comment: 'autoscale node'
        })
      })

      it('should parse English pagination info', () => {
        const result = parseJumpserverOutput(englishOutput)

        expect(result.pagination).toEqual({
          currentPage: 1,
          totalPages: 6
        })
      })
    })

    describe('parse JumpServer table variants', () => {
      it('should parse asset list without organization column', () => {
        const output = `
  ID | NAME        | ADDRESS      | PLATFORM | COMMENT
-----+-------------+--------------+----------+----------------
  1  | app-01      | 192.0.2.11   | Linux    | application
  2  | db-01       | 192.0.2.12   | Linux    |
Page: 1, Count: 15, Total Page: 1, Total Count: 2
Search:
`
        const result = parseJumpserverOutput(output)

        expect(result.assets).toHaveLength(2)
        expect(result.assets[0]).toMatchObject({
          id: 1,
          name: 'app-01',
          address: '192.0.2.11',
          platform: 'Linux',
          organization: '',
          comment: 'application'
        })
      })

      it('should parse localized IP based asset headers', () => {
        const output = `
  ID | 主机名      | IP           | 平台     | 备注
-----+-------------+--------------+----------+----------------
  1  | app-01      | 192.0.2.21   | Linux    | 应用节点
页码：1，每页行数：15，总页数：1，总数量：1
搜索：
`
        const result = parseJumpserverOutput(output)

        expect(result.assets).toHaveLength(1)
        expect(result.assets[0]).toMatchObject({
          id: 1,
          name: 'app-01',
          address: '192.0.2.21',
          platform: 'Linux',
          comment: '应用节点'
        })
      })

      it('should parse current JumpServer host/IP/comment table', () => {
        const output = `
ID    | 主机名                                                                    | IP                             | 备注
--------+---------------------------------------------------------------------------+--------------------------------+------------------------
  1     | 10.200.2.201-aipaas                                                       | 10.200.2.201                   |
  2     | 10.208.10.3                                                               | 10.208.10.3                    |
  46    | 翠湖dw-10.88.215.201                                                      | 10.88.215.201                  |
页码：1，每页行数：46，总页数：2，总数量：53
提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n
搜索：
[Host]>
`
        const result = parseJumpserverOutput(output)

        expect(result.assets).toHaveLength(3)
        expect(result.assets[0]).toEqual({
          id: 1,
          name: '10.200.2.201-aipaas',
          address: '10.200.2.201',
          platform: '',
          organization: '',
          comment: ''
        })
        expect(result.assets[2]).toMatchObject({
          id: 46,
          name: '翠湖dw-10.88.215.201',
          address: '10.88.215.201'
        })
        expect(result.pagination).toEqual({
          currentPage: 1,
          totalPages: 2
        })
      })

      it('should parse asset list with extra columns before organization and comment', () => {
        const output = `
  ID | NAME        | ADDRESS      | PLATFORM | PROTOCOLS | ORGANIZATION | COMMENT
-----+-------------+--------------+----------+-----------+--------------+----------------
  1  | app-01      | 192.0.2.31   | Linux    | ssh       | Default      | application
Page: 1, Count: 15, Total Page: 1, Total Count: 1
Search:
`
        const result = parseJumpserverOutput(output)

        expect(result.assets).toHaveLength(1)
        expect(result.assets[0]).toEqual({
          id: 1,
          name: 'app-01',
          address: '192.0.2.31',
          platform: 'Linux',
          organization: 'Default',
          comment: 'application'
        })
      })
    })

    describe('edge cases', () => {
      it('empty output should return empty assets and default pagination', () => {
        const result = parseJumpserverOutput('')

        expect(result.assets).toEqual([])
        expect(result.pagination).toEqual({
          currentPage: 1,
          totalPages: 1
        })
      })

      it('output without header should return empty assets', () => {
        const noHeaderOutput = `
Some random text
Another line without table format
`
        const result = parseJumpserverOutput(noHeaderOutput)

        expect(result.assets).toEqual([])
      })

      it('separator only output should return empty assets', () => {
        const separatorOnlyOutput = `-----+----------------------------------+-------------+----------------+-----------------+-------------------------------`
        const result = parseJumpserverOutput(separatorOnlyOutput)

        expect(result.assets).toEqual([])
      })
    })
  })

  describe('parseJumpServerUsers', () => {
    const userSelectionOutput = `
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
  2  | developer     | dev_user
  3  | operator      | ops_user
Tips: Input account ID to confirm
Back: b
ID>
`

    it('should correctly parse user list', () => {
      const users = parseJumpServerUsers(userSelectionOutput)

      expect(users).toHaveLength(3)
      expect(users[0]).toEqual({
        id: 1,
        name: 'admin',
        username: 'admin'
      })
      expect(users[1]).toEqual({
        id: 2,
        name: 'developer',
        username: 'dev_user'
      })
      expect(users[2]).toEqual({
        id: 3,
        name: 'operator',
        username: 'ops_user'
      })
    })

    it('should stop parsing when encountering Tips', () => {
      const outputWithTips = `
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
Tips: Some tips here
  2  | should_not_appear | hidden
`
      const users = parseJumpServerUsers(outputWithTips)

      expect(users).toHaveLength(1)
      expect(users[0].name).toBe('admin')
    })

    it('should stop parsing when encountering Back prompt', () => {
      const outputWithBack = `
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
Back: b
  2  | should_not_appear | hidden
`
      const users = parseJumpServerUsers(outputWithBack)

      expect(users).toHaveLength(1)
    })

    it('should stop parsing when encountering ID prompt', () => {
      const outputWithIdPrompt = `
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
ID>
  2  | should_not_appear | hidden
`
      const users = parseJumpServerUsers(outputWithIdPrompt)

      expect(users).toHaveLength(1)
    })

    it('empty output should return empty user list', () => {
      const users = parseJumpServerUsers('')

      expect(users).toEqual([])
    })

    it('output without header should return empty user list', () => {
      const noHeaderOutput = 'Some random text without user table'
      const users = parseJumpServerUsers(noHeaderOutput)

      expect(users).toEqual([])
    })

    it('should skip separator lines', () => {
      const outputWithSeparator = `
  ID | NAME          | USERNAME
---+---+---
  1  | admin         | admin
`
      const users = parseJumpServerUsers(outputWithSeparator)

      expect(users).toHaveLength(1)
      expect(users[0].name).toBe('admin')
    })

    it('should parse Chinese user selection table from current JumpServer output', () => {
      const chineseUserSelectionOutput = `
  ID    | 主机名                                                 | IP                            | 备注
--------+--------------------------------------------------------+-------------------------------+----------------------
  1     | TEST-192.0.2.14-IAAS云管理平台                         | 192.0.2.14                    |
页码：1，每页行数：22，总页数：1，总数量：1
提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n
搜索：192.0.2.14
[Host]> 1
  ID    | 名称                                                                  | 用户名
--------+-----------------------------------------------------------------------+---------------------------------------
  1     | CSD-192.0.2.217_pgsql                                                 | pgsql
  2     | CSD-192.0.2.35_cloud用户                                              | cloud
  3     | CSD-192.0.2.44_cloud用户                                              | cloud
  4     | CSD-192.0.2.170_csdcloud用户                                          | csdcloud
  5     | CSD-192.0.2.11_root用户                                               | root
  6     | CSD-192.0.2.12_root用户                                               | root
  7     | CSD-192.0.2.15_root用户                                               | root
  8     | CSD-192.0.2.100_root用户                                              | root
  9     | ISOS-192.0.2.11-root用户                                              | root
  10    | ISOS-IaaS云管理平台_cloud用户_cuihu                                   | cloud
提示：输入系统用户ID直接登录
返回：B/b
ID>
`

      const users = parseJumpServerUsers(chineseUserSelectionOutput)

      expect(users).toHaveLength(10)
      expect(users[0]).toEqual({
        id: 1,
        name: 'CSD-192.0.2.217_pgsql',
        username: 'pgsql'
      })
      expect(users[9]).toEqual({
        id: 10,
        name: 'ISOS-IaaS云管理平台_cloud用户_cuihu',
        username: 'cloud'
      })
    })
  })

  describe('hasUserSelectionPrompt', () => {
    it('should detect output containing user selection prompt', () => {
      const promptOutput = `
Please select account ID to connect:
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
`
      expect(hasUserSelectionPrompt(promptOutput)).toBe(true)
    })

    it('should detect full user selection prompt', () => {
      const fullPromptOutput = `
Select account ID to login:
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
  2  | developer     | dev_user
`
      expect(hasUserSelectionPrompt(fullPromptOutput)).toBe(true)
    })

    it('should return false when account ID is missing', () => {
      const noAccountIdOutput = `
  ID | NAME          | USERNAME
-----+---------------+--------------
  1  | admin         | admin
`
      expect(hasUserSelectionPrompt(noAccountIdOutput)).toBe(false)
    })

    it('should return false when header is missing', () => {
      const noHeaderOutput = `
Please select account ID to connect:
Some other content
`
      expect(hasUserSelectionPrompt(noHeaderOutput)).toBe(false)
    })

    it('should return false for empty output', () => {
      expect(hasUserSelectionPrompt('')).toBe(false)
    })

    it('should return false when only partial keywords exist', () => {
      // only account ID without header
      expect(hasUserSelectionPrompt('account ID')).toBe(false)
      // only ID and NAME without account ID
      expect(hasUserSelectionPrompt('ID | NAME')).toBe(false)
    })

    it('should detect Chinese system user selection prompt', () => {
      const promptOutput = `
  ID    | 名称                                                                  | 用户名
--------+-----------------------------------------------------------------------+---------------------------------------
  1     | CSD-192.0.2.217_pgsql                                                 | pgsql
提示：输入系统用户ID直接登录
返回：B/b
ID>
`

      expect(hasUserSelectionPrompt(promptOutput)).toBe(true)
    })

    it('should not detect Chinese asset selection prompt as user selection', () => {
      const assetPromptOutput = `
  ID    | 主机名                                                 | IP                            | 备注
--------+--------------------------------------------------------+-------------------------------+----------------------
  1     | TEST-192.0.2.14-IAAS云管理平台                         | 192.0.2.14                    |
提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n
搜索：
`

      expect(hasUserSelectionPrompt(assetPromptOutput)).toBe(false)
    })
  })
})
