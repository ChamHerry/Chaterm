// ssh2jumpserver/parser.ts
const logger = createLogger('jumpserver')
const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface Asset {
  id: number
  name: string
  address: string
  platform: string
  organization: string
  comment: string
}

export interface PaginationInfo {
  currentPage: number
  totalPages: number
}

export interface ParsedOutput {
  assets: Asset[]
  pagination: PaginationInfo
}

export interface JumpServerUser {
  id: number
  name: string
  username: string
}

function parseAssets(output: string): Asset[] {
  const assets: Asset[] = []
  const lines = output.split('\n')

  let foundAssetHeader = false
  let headers: string[] = []

  const splitColumns = (line: string): string[] => line.split('|').map((column) => column.trim())

  const isSeparator = (line: string): boolean => /^\s*-{2,}\+/.test(line)

  const isPromptLine = (line: string): boolean => {
    const trimmed = line.trim()
    return /^(Page:|页码：|提示：|Enter ID|Search:|搜索：|\[Host\]>|Tips:|Back:|ID>)/i.test(trimmed)
  }

  const hasAddressLikeHeader = (column: string): boolean => {
    const normalized = column.trim().toUpperCase()
    return (
      normalized === 'ADDRESS' ||
      normalized === 'IP' ||
      normalized === 'HOST' ||
      normalized.includes('ADDRESS') ||
      /^IP(V[46])?$/.test(normalized) ||
      column.includes('地址') ||
      column.includes('主机地址')
    )
  }

  const hasNameLikeHeader = (column: string): boolean => {
    const normalized = column.trim().toUpperCase()
    return normalized === 'NAME' || normalized === 'HOSTNAME' || normalized.includes('NAME') || column.includes('名称') || column.includes('主机')
  }

  const findHeaderIndex = (predicates: Array<(column: string) => boolean>): number => {
    for (const predicate of predicates) {
      const index = headers.findIndex(predicate)
      if (index >= 0) return index
    }
    return -1
  }

  const isAssetHeader = (line: string): boolean => {
    if (!line.includes('|')) return false
    const columns = splitColumns(line)
    const normalizedColumns = columns.map((column) => column.toUpperCase())
    const hasId = normalizedColumns.includes('ID')
    const looksLikeUserTable = normalizedColumns.includes('USERNAME') && !columns.some(hasAddressLikeHeader)

    if (!hasId || looksLikeUserTable) return false

    return columns.some(hasAddressLikeHeader) || columns.some(hasNameLikeHeader)
  }

  const isLikelyAddress = (value: string): boolean => {
    const normalized = value.trim()
    if (!normalized || /\s/.test(normalized)) return false
    return (
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
      (normalized.includes(':') && /^[0-9a-f:]+$/i.test(normalized)) ||
      /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(normalized)
    )
  }

  const valueAt = (columns: string[], index: number, fallback = ''): string => {
    return index >= 0 && index < columns.length ? columns[index].trim() : fallback
  }

  for (const line of lines) {
    // Only detect header if not found yet
    if (!foundAssetHeader) {
      if (isAssetHeader(line)) {
        foundAssetHeader = true
        headers = splitColumns(line)
        continue
      }

      // Generic separator detection fallback for stripped headers.
      if (isSeparator(line)) {
        foundAssetHeader = true
        continue
      }
    }

    if (foundAssetHeader) {
      if (!line.trim() || isSeparator(line)) continue
      if (isPromptLine(line)) break

      const columns = splitColumns(line)
      const id = parseInt(columns[0], 10)
      if (!Number.isFinite(id) || columns.length < 3) continue

      try {
        const nameIndex = findHeaderIndex([hasNameLikeHeader])
        let addressIndex = findHeaderIndex([hasAddressLikeHeader])
        if (addressIndex < 0) {
          const inferredAddressIndex = columns.findIndex((column, index) => index > 0 && isLikelyAddress(column))
          addressIndex = inferredAddressIndex >= 0 ? inferredAddressIndex : 2
        }

        const platformIndex = findHeaderIndex([(column) => column.toUpperCase().includes('PLATFORM') || column.includes('平台')])
        const organizationIndex = findHeaderIndex([
          (column) => column.toUpperCase().includes('ORGANIZATION') || column.toUpperCase() === 'ORG' || column.includes('组织')
        ])
        const commentIndex = findHeaderIndex([
          (column) =>
            column.toUpperCase().includes('COMMENT') ||
            column.toUpperCase().includes('DESCRIPTION') ||
            column.includes('备注') ||
            column.includes('描述')
        ])

        const asset: Asset = {
          id,
          name: valueAt(columns, nameIndex >= 0 ? nameIndex : 1),
          address: valueAt(columns, addressIndex),
          platform: platformIndex >= 0 ? valueAt(columns, platformIndex) : headers.length > 0 ? '' : valueAt(columns, 3),
          organization: organizationIndex >= 0 ? valueAt(columns, organizationIndex) : headers.length > 0 ? '' : valueAt(columns, 4),
          comment: valueAt(columns, commentIndex >= 0 ? commentIndex : columns.length > 5 ? columns.length - 1 : 5)
        }
        assets.push(asset)
      } catch (e) {
        logger.debug('Failed to parse asset line', { event: 'jumpserver.parser.asset.error', errorMessage: getErrorMessage(e) })
      }
    }
  }
  return assets
}

function parsePagination(output: string): PaginationInfo {
  // Try Chinese format first
  const chineseRegex = /页码：\s*(\d+).*?总页数：\s*(\d+)/
  const chineseMatch = output.match(chineseRegex)
  if (chineseMatch) {
    return {
      currentPage: parseInt(chineseMatch[1], 10),
      totalPages: parseInt(chineseMatch[2], 10)
    }
  }

  // Fallback to English format
  const englishRegex = /Page:\s*(\d+).*?Total Page:\s*(\d+)/
  const englishMatch = output.match(englishRegex)
  if (englishMatch) {
    return {
      currentPage: parseInt(englishMatch[1], 10),
      totalPages: parseInt(englishMatch[2], 10)
    }
  }

  // Default value
  return { currentPage: 1, totalPages: 1 }
}

/**
 * Parse JumpServer raw output
 * @param output JumpServer shell raw output string
 * @returns Parsed assets and pagination information
 */
export function parseJumpserverOutput(output: string): ParsedOutput {
  const assets = parseAssets(output)
  const pagination = parsePagination(output)
  return { assets, pagination }
}

/**
 * Parse JumpServer user list from output
 * @param output JumpServer shell output containing user table
 * @returns Array of parsed users
 */
export function parseJumpServerUsers(output: string): JumpServerUser[] {
  const users: JumpServerUser[] = []
  const lines = output.split('\n')
  // Match pattern: ID | NAME | USERNAME
  const userRegex = /^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/

  let foundUserHeader = false

  const isUserHeader = (line: string): boolean => {
    if (!line.includes('|')) return false
    const columns = line.split('|').map((column) => column.trim())
    const normalizedColumns = columns.map((column) => column.toUpperCase())
    const hasId = normalizedColumns.includes('ID')
    const hasEnglishHeader = normalizedColumns.includes('NAME') && normalizedColumns.includes('USERNAME')
    const hasChineseHeader = columns.includes('名称') && columns.includes('用户名')
    return hasId && (hasEnglishHeader || hasChineseHeader)
  }

  const isStopLine = (line: string): boolean => {
    const trimmed = line.trim()
    return /^(Tips:|Back:|ID>|提示：|返回：)/i.test(trimmed)
  }

  for (const line of lines) {
    // Detect user table header (ID | NAME | USERNAME)
    if (isUserHeader(line)) {
      foundUserHeader = true
      continue
    }

    // Skip separator lines
    if (line.includes('---+---')) {
      continue
    }

    if (foundUserHeader) {
      // Stop parsing when we hit Tips or other non-table content
      if (isStopLine(line)) {
        break
      }

      const match = line.match(userRegex)
      if (match) {
        try {
          const user: JumpServerUser = {
            id: parseInt(match[1].trim()),
            name: match[2].trim(),
            username: match[3].trim()
          }
          users.push(user)
        } catch (e) {
          logger.debug('Failed to parse user line', { event: 'jumpserver.parser.user.error', errorMessage: getErrorMessage(e) })
        }
      }
    }
  }

  return users
}

/**
 * Detect if output contains user selection prompt
 * @param output JumpServer shell output
 * @returns true if user selection is required
 */
export function hasUserSelectionPrompt(output: string): boolean {
  const hasEnglishPrompt = /account\s+ID/i.test(output)
  const hasChinesePrompt = output.includes('输入系统用户ID直接登录')
  const hasEnglishHeader = output.includes('ID') && output.includes('NAME') && output.includes('USERNAME')
  const hasChineseHeader = output.includes('ID') && output.includes('名称') && output.includes('用户名')

  return (hasEnglishPrompt || hasChinesePrompt) && (hasEnglishHeader || hasChineseHeader)
}
