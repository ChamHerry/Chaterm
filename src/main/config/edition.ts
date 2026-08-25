/**
 * Edition configuration module for main process
 * Loads and manages the single edition configuration (YiXin/CN)
 *
 * IMPORTANT: All edition-specific URLs are defined in build/edition-config/*.json
 * This is the single source of truth - do NOT hardcode URLs elsewhere
 */
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
const logger = createLogger('config')

export type Edition = 'cn'

export interface EditionConfig {
  edition: Edition
  displayName: string
  auth: {
    yixinSsoBaseUrl: string
    yixinLoginPath?: string
    yixinValidatePath?: string
  }
  defaults: {
    language: string
  }
}

let cachedConfig: EditionConfig | null = null
let userDataPath: string | null = null
let userDataPathInitialized = false

/**
 * Get current edition. The project ships a single edition.
 */
export function getEdition(): Edition {
  return 'cn'
}

/**
 * Check if current edition is Chinese edition
 */
export function isChineseEdition(): boolean {
  return true
}

/**
 * Initialize the userData path.
 * This function MUST be called at the very beginning of the app startup,
 * before any other module tries to access userData.
 */
export function initUserDataPath(): void {
  if (userDataPathInitialized) {
    return
  }

  try {
    userDataPath = app.getPath('userData')
  } catch (error) {
    // Fallback for test environment or non-Electron environment
    userDataPath = path.join(process.cwd(), 'test_data')
  }

  userDataPathInitialized = true
}

/**
 * Get the userData path.
 * If not initialized, it will initialize automatically (for backward compatibility).
 */
export function getUserDataPath(): string {
  if (!userDataPathInitialized) {
    initUserDataPath()
  }
  return userDataPath as string
}

/**
 * Get protocol prefix
 */
export function getProtocolPrefix(): string {
  return 'chaterm://'
}

/**
 * Get protocol name (without ://)
 */
export function getProtocolName(): string {
  return 'chaterm'
}

/**
 * Load edition configuration from JSON file
 * This is the single source of truth for all edition-specific URLs
 */
export function loadEditionConfig(): EditionConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  const edition = getEdition()

  // Try to load from packaged resources first, then from dev path
  const packagedConfigPath = path.join(process.resourcesPath || '', `edition-config/${edition}.json`)
  const devConfigPath = path.join(process.cwd(), `build/edition-config/${edition}.json`)

  let configPath: string | null = null

  if (fs.existsSync(packagedConfigPath)) {
    configPath = packagedConfigPath
  } else if (fs.existsSync(devConfigPath)) {
    configPath = devConfigPath
  }

  if (!configPath) {
    // This should never happen in production - config files must exist
    throw new Error(`[Edition] Config file not found for edition: ${edition}. ` + `Checked paths: ${packagedConfigPath}, ${devConfigPath}`)
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8')
    cachedConfig = JSON.parse(configContent) as EditionConfig
    logger.info('Loaded edition configuration', { edition, configPath })
    return cachedConfig
  } catch (error) {
    throw new Error(`[Edition] Failed to parse config file: ${configPath}, error: ${error}`)
  }
}

/**
 * Clear cached config (useful for testing or hot reload)
 */
export function clearConfigCache(): void {
  cachedConfig = null
}

/**
 * Get the full edition configuration object
 */
export function getEditionConfig(): EditionConfig {
  return loadEditionConfig()
}

/**
 * Deprecated Chaterm cloud URLs are intentionally unavailable in YiXin-only mode.
 */
export function getApiBaseUrl(): string {
  return ''
}

export function getKmsUrl(): string {
  return ''
}

export function getSyncUrl(): string {
  return ''
}

export function getUpdateServerUrl(): string {
  return ''
}

export function getLoginBaseUrl(): string {
  return ''
}

/**
 * Get YiXin CAS SSO configuration.
 */
export function getYixinSsoConfig(): { ssoBaseUrl: string; loginPath?: string; validatePath?: string } {
  const auth = loadEditionConfig().auth
  return {
    ssoBaseUrl: auth.yixinSsoBaseUrl || '',
    loginPath: auth.yixinLoginPath,
    validatePath: auth.yixinValidatePath
  }
}

/**
 * Get default language for current edition
 */
export function getDefaultLanguage(): string {
  return loadEditionConfig().defaults.language
}

export function getPrivacyPolicyUrl(): string {
  return ''
}

export function getTermsOfServiceUrl(): string {
  return ''
}

export function getDocsBaseUrl(): string {
  return ''
}

export function getSpeechWsUrl(): string {
  return ''
}
