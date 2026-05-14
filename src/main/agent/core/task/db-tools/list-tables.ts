// list_tables: enumerate tables in a (database, schema) scope.

import type { DbAiActiveSession, DbToolResult } from './shared'
import { optionalStringParam, unexpectedError } from './shared'

export interface ListTablesInput {
  database?: string
  schema?: string
}

export interface ListTablesResult {
  tables: string[]
}

export async function runListTables(session: DbAiActiveSession, input: ListTablesInput): Promise<DbToolResult<ListTablesResult>> {
  const db = optionalStringParam(input.database, 'database')
  if (!db.ok) return db
  const database = db.value ?? session.databaseName
  if (!database) {
    return { ok: false, errorCode: 'E_MISSING_PARAM', errorMessage: 'Missing required parameter: database.' }
  }

  const sc = optionalStringParam(input.schema, 'schema')
  if (!sc.ok) return sc
  const schema = sc.value ?? session.schemaName

  try {
    // When the engine has a schema layer (PG) and the caller supplied one,
    // validate schema membership via hasSchema (internal first-miss refresh).
    if (schema) {
      const knownSchemas = await session.listSchemas(database)
      if (knownSchemas.length > 0 && !(await session.hasSchema(database, schema))) {
        return { ok: false, errorCode: 'E_UNKNOWN_SCHEMA', errorMessage: 'Schema does not exist.' }
      }
    }
    const tables = await session.listTables(database, schema)
    return { ok: true, data: { tables } }
  } catch (error) {
    return unexpectedError(error)
  }
}
