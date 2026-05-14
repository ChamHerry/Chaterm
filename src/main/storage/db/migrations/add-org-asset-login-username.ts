import Database from 'better-sqlite3'
const logger = createLogger('db')

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Upgrade t_organization_assets table schema:
 * - login_username stores the target system username selected from JumpServer
 * - login_user_name stores the JumpServer display name for disambiguating
 *   duplicate usernames
 */
export async function upgradeOrgAssetLoginUsernameSupport(db: Database.Database): Promise<void> {
  try {
    const tableInfo = db.prepare('PRAGMA table_info(t_organization_assets)').all() as Array<{ name: string }>
    const loginUsernameExists = tableInfo.some((col) => col.name === 'login_username')
    const loginUserNameExists = tableInfo.some((col) => col.name === 'login_user_name')

    if (!loginUsernameExists) {
      logger.info('Adding login_username column to t_organization_assets table...')
      db.exec('ALTER TABLE t_organization_assets ADD COLUMN login_username TEXT DEFAULT NULL')
      logger.info('login_username column added successfully')
    }

    if (!loginUserNameExists) {
      logger.info('Adding login_user_name column to t_organization_assets table...')
      db.exec('ALTER TABLE t_organization_assets ADD COLUMN login_user_name TEXT DEFAULT NULL')
      logger.info('login_user_name column added successfully')
    }
  } catch (error) {
    logger.error('Failed to upgrade t_organization_assets login username support', { errorMessage: getErrorMessage(error) })
    throw error
  }
}
