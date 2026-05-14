// Copyright (c) 2025-present, chaterm.ai  All rights reserved.
// This source code is licensed under the GPL-3.0

// Centralized tool registry and workspace-based visibility metadata.
//
// Context: The repo historically tracked tool names in two places -
// `toolUseNames` (assistant-message parser input) and the switch statements
// inside `Task.handleToolUse()` (dispatch/description/auto-approval).
// Phase 3 of the DB-AI plan introduces a second workspace ("database") whose
// visible tool list is a strict subset of the classic server workspace.
// Rather than sprinkle workspace gates throughout the switch cases, we collect
// the authoritative list here. Downstream modules derive from this single
// source of truth:
//   - `toolUseNames` (assistant-message/index.ts) is re-exported from the
//     registry so the parser only recognises known tools.
//   - Task dispatch applies `isToolAllowed(name, workspace)` as the final
//     safety boundary, returning a tool error for any workspace violation.
//   - System prompt rendering filters the documented tool list by workspace
//     (wired up in later tasks).

// NOTE: this module intentionally does not import `ToolUseName` from
// assistant-message; doing so would create a circular dependency because
// assistant-message derives `toolUseNames` from `registeredToolNames` here.
// `ToolParamName` is defined independently in assistant-message and is safe
// to import.
import type { ToolParamName } from '../assistant-message'
import type { TaskWorkspace as SharedTaskWorkspace } from '@shared/task-workspace'
import type { JsonSchemaObject, JsonSchemaValue, NativeToolDefinition } from '@api/tools'

/**
 * Workspace in which a Task operates.
 *
 * Re-exported from `@shared/task-workspace` so `tsconfig.web` type lookups
 * that transit through `ContextTrackerTypes.ts` never pull in assistant-
 * message / tool-registry. See `@shared/task-workspace` for the canonical
 * definition.
 */
export type TaskWorkspace = SharedTaskWorkspace

/**
 * Tool category used for grouping in prompts and logs. Does NOT participate
 * in visibility checks - `allowedIn` is the sole source of truth for that.
 *
 * - `'server'`: tool only makes sense in the server workspace (shell/FS).
 * - `'database'`: tool only makes sense in the database workspace.
 * - `'common'`: tool is workspace-neutral (interaction, knowledge, web, ...).
 */
export type ToolCategory = 'server' | 'database' | 'common'

/**
 * Internal shape used to declare `toolMetadata` without depending on
 * `ToolUseName`. The public `ToolMetadata` type narrows `name` to
 * `ToolUseName` once it is derived below.
 */
interface ToolMetadataDecl {
  readonly name: string
  readonly allowedIn: readonly TaskWorkspace[]
  readonly paramNames: readonly ToolParamName[]
  readonly allowPartial?: boolean
  readonly category: ToolCategory
}

/**
 * Authoritative list of 19 existing tools with their workspace visibility.
 *
 * Visibility is taken from `docs/db-ai-tool-whitelist-decision.md` table 2.1.
 * DB-specific tools (#20+) will be appended by task #16 once their handlers
 * are implemented; this file intentionally only registers tools that have
 * working dispatch handlers today.
 */
const toolMetadataInternal = [
  // Server-only tools: shell execution and local filesystem access. These
  // violate the DB-AI workspace design intent even if they technically would
  // downgrade to local execution (e.g. execute_command without a host).
  {
    name: 'execute_command',
    allowedIn: ['server'],
    paramNames: ['command', 'ip', 'requires_approval', 'interactive', 'depositExperience'],
    category: 'server'
  },
  {
    name: 'write_to_file',
    allowedIn: ['server'],
    paramNames: ['path', 'file_path', 'content', 'diff', 'ip'],
    category: 'server'
  },
  {
    name: 'read_file',
    allowedIn: ['server'],
    paramNames: ['path', 'file_path', 'ip', 'offset', 'limit'],
    category: 'server'
  },
  {
    name: 'ask_followup_question',
    allowedIn: ['server', 'database'],
    paramNames: ['question', 'options', 'response'],
    category: 'common'
  },
  {
    name: 'attempt_completion',
    allowedIn: ['server', 'database'],
    paramNames: ['result', 'command', 'ip', 'depositExperience'],
    allowPartial: true,
    category: 'common'
  },
  {
    name: 'new_task',
    allowedIn: ['server', 'database'],
    paramNames: ['context'],
    category: 'common'
  },
  {
    name: 'condense',
    allowedIn: ['server', 'database'],
    paramNames: ['context'],
    category: 'common'
  },
  {
    name: 'report_bug',
    allowedIn: ['server', 'database'],
    paramNames: ['title', 'what_happened', 'steps_to_reproduce', 'api_request_output', 'additional_context'],
    category: 'common'
  },
  {
    name: 'todo_write',
    allowedIn: ['server', 'database'],
    paramNames: ['todos'],
    category: 'common'
  },
  {
    name: 'todo_read',
    allowedIn: ['server', 'database'],
    paramNames: [],
    category: 'common'
  },
  {
    name: 'glob_search',
    allowedIn: ['server'],
    paramNames: ['pattern', 'file_pattern', 'path', 'ip', 'limit', 'sort'],
    category: 'server'
  },
  {
    name: 'grep_search',
    allowedIn: ['server'],
    paramNames: ['pattern', 'regex', 'path', 'ip', 'include', 'file_pattern', 'case_sensitive', 'context_lines', 'max_matches'],
    category: 'server'
  },
  {
    name: 'use_mcp_tool',
    allowedIn: ['server', 'database'],
    paramNames: ['server_name', 'tool_name', 'arguments'],
    category: 'common'
  },
  {
    name: 'access_mcp_resource',
    allowedIn: ['server', 'database'],
    paramNames: ['server_name', 'uri'],
    category: 'common'
  },
  {
    name: 'use_skill',
    allowedIn: ['server', 'database'],
    paramNames: ['name'],
    category: 'common'
  },
  {
    name: 'summarize_to_knowledge',
    allowedIn: ['server', 'database'],
    paramNames: ['file_name', 'summary'],
    allowPartial: true,
    category: 'common'
  },
  {
    name: 'summarize_to_skill',
    allowedIn: ['server', 'database'],
    paramNames: ['skill_name', 'description', 'content'],
    allowPartial: true,
    category: 'common'
  },
  {
    name: 'kb_search',
    allowedIn: ['server', 'database'],
    paramNames: ['query', 'max_results'],
    category: 'common'
  },
  {
    name: 'web_fetch',
    allowedIn: ['server', 'database'],
    paramNames: ['url', 'extract_mode', 'max_chars'],
    category: 'common'
  },
  // ----- DB-AI workspace tools ----------------------------------------------
  {
    name: 'list_databases',
    allowedIn: ['database'],
    paramNames: [],
    category: 'database'
  },
  {
    name: 'list_schemas',
    allowedIn: ['database'],
    paramNames: ['database'],
    category: 'database'
  },
  {
    name: 'list_tables',
    allowedIn: ['database'],
    paramNames: ['database', 'schema'],
    category: 'database'
  },
  {
    name: 'describe_table',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'table'],
    category: 'database'
  },
  {
    name: 'inspect_indexes',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'table'],
    category: 'database'
  },
  {
    name: 'sample_rows',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'table', 'limit'],
    category: 'database'
  },
  {
    name: 'count_rows',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'table', 'exact'],
    category: 'database'
  },
  {
    name: 'explain_plan',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'sql'],
    category: 'database'
  },
  {
    name: 'execute_readonly_query',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'sql'],
    category: 'database'
  },
  {
    name: 'execute_write_query',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'sql'],
    category: 'database'
  },
  {
    name: 'suggest_indexes',
    allowedIn: ['database'],
    paramNames: ['database', 'schema', 'table', 'query_patterns'],
    category: 'database'
  }
] as const satisfies readonly ToolMetadataDecl[]

/**
 * Canonical tool-name union derived from `toolMetadata`.
 * `assistant-message/index.ts` re-exports this as `ToolUseName` to preserve
 * the existing import surface.
 */
export type ToolUseName = (typeof toolMetadataInternal)[number]['name']

/**
 * Static metadata describing a registered tool. Runtime behaviour lives in
 * Task handler methods; this record only captures parser/visibility info.
 */
export interface ToolMetadata {
  /** Canonical tool name used by parser and dispatch. */
  readonly name: ToolUseName
  /**
   * Workspaces in which this tool is visible/allowed. Must be declared
   * explicitly - an empty array means the tool is hidden everywhere, which
   * is intentional to force authors of new tools to make a deliberate
   * decision. See `docs/db-ai-tool-whitelist-decision.md`.
   */
  readonly allowedIn: readonly TaskWorkspace[]
  /** Parameter names the tool accepts. */
  readonly paramNames: readonly ToolParamName[]
  /**
   * Whether the dispatcher may run this tool with `block.partial === true`.
   * Mirrors `isAllowPartialTool()` in task/index.ts (kept in sync).
   */
  readonly allowPartial?: boolean
  /** Grouping category, used by prompts and logs only. */
  readonly category: ToolCategory
}

/** Public, narrowly-typed view of the internal metadata list. */
export const toolMetadata: readonly ToolMetadata[] = toolMetadataInternal as readonly ToolMetadata[]

// Defensive lookup map. Using a Map avoids O(n) scans during dispatch.
const metadataByName: ReadonlyMap<ToolUseName, ToolMetadata> = new Map(toolMetadata.map((m) => [m.name, m]))

/**
 * Return metadata for `name`, or `undefined` if the tool is not registered.
 * Dispatch treats "unregistered" identically to "not allowed in workspace".
 */
export function getToolMetadata(name: ToolUseName): ToolMetadata | undefined {
  return metadataByName.get(name)
}

/** Tools whose `allowedIn` array contains `workspace`. */
export function getAllowedTools(workspace: TaskWorkspace): ToolMetadata[] {
  return toolMetadata.filter((m) => m.allowedIn.includes(workspace))
}

/**
 * Whether `name` is both registered and allowed in `workspace`.
 *
 * Unknown tool names return `false` - callers that already guard against
 * unknown names via the parser will never reach this branch in practice.
 */
export function isToolAllowed(name: ToolUseName, workspace: TaskWorkspace): boolean {
  const meta = metadataByName.get(name)
  if (!meta) return false
  return meta.allowedIn.includes(workspace)
}

/**
 * Canonical list of tool names, derived from `toolMetadata`. Exported so the
 * assistant-message module can re-export it without maintaining a parallel
 * array. Order matches `toolMetadata` declaration order.
 */
export const registeredToolNames: readonly ToolUseName[] = toolMetadata.map((m) => m.name)

const toolDescriptions: Record<ToolUseName, string> = {
  execute_command: 'Execute a CLI command on the selected remote host or host group.',
  write_to_file: 'Write or patch a file in the current workspace.',
  read_file: 'Read file contents from the current workspace or an offloaded tool output file.',
  ask_followup_question: 'Ask the user a concise follow-up question when required information is missing.',
  attempt_completion: 'Finish the task with a final result once the requested work is complete.',
  new_task: 'Create a new task with preloaded context.',
  condense: 'Condense the current conversation context.',
  report_bug: 'Prepare a bug report for the current task.',
  todo_write: 'Create or update the task todo list.',
  todo_read: 'Read the current task todo list.',
  glob_search: 'Find files matching a glob pattern on the current host.',
  grep_search: 'Search file contents with a regular expression on the current host.',
  use_mcp_tool: 'Invoke a tool exposed by an enabled MCP server.',
  access_mcp_resource: 'Read a resource exposed by an enabled MCP server.',
  use_skill: 'Activate a reusable skill by name.',
  summarize_to_knowledge: 'Save a concise knowledge-base summary from the current conversation.',
  summarize_to_skill: 'Convert the current conversation into reusable skill instructions.',
  kb_search: 'Search the local knowledge base.',
  web_fetch: 'Fetch and extract content from a web URL.',
  list_databases: 'List every database visible to the current database connection.',
  list_schemas: 'List schemas inside a database. Defaults to the current database when omitted.',
  list_tables: 'List tables and views inside a database and schema. Defaults to the current database/schema when omitted.',
  describe_table: 'Return columns, types, keys, and DDL for a specific table.',
  inspect_indexes: 'Return indexes defined on a table, including column order and uniqueness.',
  sample_rows: 'Return a small read-only sample of rows from a table.',
  count_rows: 'Return an approximate or exact row count for a table.',
  explain_plan: 'Return a database execution plan for a SQL statement.',
  execute_readonly_query: 'Execute a read-only SQL query and return capped tabular results.',
  execute_write_query: 'Execute a write SQL statement through the approval-gated database flow.',
  suggest_indexes: 'Suggest indexes for a table and optional query patterns.'
}

const paramSchemas: Record<ToolParamName, JsonSchemaValue> = {
  ip: { type: 'string', description: 'Target host IP/hostname, or a comma-separated list for host groups.' },
  command: { type: 'string', description: 'Command to execute.' },
  depositExperience: { type: 'boolean', description: 'Whether this completion contains reusable experience worth extracting.' },
  requires_approval: { type: 'boolean', description: 'Whether this operation requires explicit approval.' },
  interactive: { type: 'boolean', description: 'Whether the command requires interactive user input.' },
  path: { type: 'string', description: 'File or directory path.' },
  file_path: { type: 'string', description: 'File path.' },
  offset: { type: 'integer', description: 'Line offset or byte offset depending on the tool.' },
  content: { type: 'string', description: 'Text content.' },
  diff: { type: 'string', description: 'Patch diff content.' },
  regex: { type: 'string', description: 'Regular expression pattern.' },
  file_pattern: { type: 'string', description: 'File glob include pattern.' },
  recursive: { type: 'boolean', description: 'Whether to recurse into child paths.' },
  pattern: { type: 'string', description: 'Search or glob pattern.' },
  include: { type: 'string', description: 'Glob include filter.' },
  limit: { type: 'integer', description: 'Maximum number of results or rows.' },
  sort: { type: 'string', enum: ['path', 'none'], description: 'Sort mode.' },
  case_sensitive: { type: 'boolean', description: 'Whether matching is case-sensitive.' },
  context_lines: { type: 'integer', description: 'Number of context lines around matches.' },
  max_matches: { type: 'integer', description: 'Maximum number of matches.' },
  action: { type: 'string', description: 'Action name.' },
  url: { type: 'string', description: 'URL to fetch.' },
  coordinate: { type: 'string', description: 'Coordinate value.' },
  text: { type: 'string', description: 'Text value.' },
  server_name: { type: 'string', description: 'MCP server name.' },
  tool_name: { type: 'string', description: 'MCP tool name.' },
  arguments: { type: 'object', description: 'Tool arguments object.', additionalProperties: true },
  uri: { type: 'string', description: 'Resource URI.' },
  question: { type: 'string', description: 'Question to ask the user.' },
  options: { type: 'array', description: 'Optional selectable answers.', items: { type: 'string' } },
  response: { type: 'string', description: 'User response.' },
  result: { type: 'string', description: 'Final result text.' },
  context: { type: 'string', description: 'Context payload.' },
  title: { type: 'string', description: 'Bug report title.' },
  what_happened: { type: 'string', description: 'Bug report symptom.' },
  steps_to_reproduce: { type: 'string', description: 'Steps to reproduce.' },
  api_request_output: { type: 'string', description: 'API request output summary.' },
  additional_context: { type: 'string', description: 'Additional context.' },
  todos: { type: 'array', description: 'Todo items.', items: { type: 'object', additionalProperties: true } },
  name: { type: 'string', description: 'Name.' },
  file_name: { type: 'string', description: 'File name.' },
  summary: { type: 'string', description: 'Summary content.' },
  skill_name: { type: 'string', description: 'Skill name.' },
  description: { type: 'string', description: 'Description.' },
  query: { type: 'string', description: 'Search query or SQL-related natural-language query.' },
  max_results: { type: 'integer', description: 'Maximum number of results.' },
  extract_mode: { type: 'string', enum: ['markdown', 'text'], description: 'Web extraction mode.' },
  max_chars: { type: 'integer', description: 'Maximum extracted characters.' },
  database: { type: 'string', description: 'Database name. Optional DB tools default to the current database.' },
  schema: { type: 'string', description: 'Schema name. Optional DB tools default to the current schema.' },
  table: { type: 'string', description: 'Table name.' },
  sql: { type: 'string', description: 'SQL statement.' },
  exact: { type: 'boolean', description: 'Whether to force an exact row count.' },
  query_patterns: { type: 'string', description: 'Query patterns to consider when suggesting indexes.' }
}

const requiredParamsByTool: Partial<Record<ToolUseName, readonly ToolParamName[]>> = {
  execute_command: ['ip', 'command', 'requires_approval', 'interactive'],
  write_to_file: ['path', 'content'],
  read_file: ['path', 'limit', 'offset'],
  ask_followup_question: ['question'],
  attempt_completion: ['result', 'depositExperience'],
  new_task: ['context'],
  report_bug: ['title', 'what_happened', 'steps_to_reproduce', 'api_request_output', 'additional_context'],
  glob_search: ['pattern'],
  grep_search: ['pattern'],
  use_mcp_tool: ['server_name', 'tool_name', 'arguments'],
  access_mcp_resource: ['server_name', 'uri'],
  use_skill: ['name'],
  summarize_to_knowledge: ['file_name', 'summary'],
  summarize_to_skill: ['skill_name', 'description', 'content'],
  kb_search: ['query'],
  web_fetch: ['url'],
  describe_table: ['table'],
  inspect_indexes: ['table'],
  sample_rows: ['table'],
  count_rows: ['table'],
  explain_plan: ['sql'],
  execute_readonly_query: ['sql'],
  execute_write_query: ['sql']
}

export function getNativeToolInputSchema(tool: ToolMetadata): JsonSchemaObject {
  const properties: Record<string, JsonSchemaValue> = {}
  for (const paramName of tool.paramNames) {
    properties[paramName] = paramSchemas[paramName] ?? { type: 'string' }
  }

  return {
    type: 'object',
    properties,
    required: [...(requiredParamsByTool[tool.name] ?? [])],
    additionalProperties: false
  }
}

export function getNativeToolDefinitions(workspace: TaskWorkspace): NativeToolDefinition[] {
  return getAllowedTools(workspace).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: toolDescriptions[tool.name],
      parameters: getNativeToolInputSchema(tool)
    }
  }))
}

export function isRegisteredToolName(name: string): name is ToolUseName {
  return registeredToolNames.includes(name as ToolUseName)
}

export function normalizeNativeToolInput(name: ToolUseName, input: Record<string, unknown>): Partial<Record<ToolParamName, string>> {
  const meta = getToolMetadata(name)
  if (!meta) return {}

  const params: Partial<Record<ToolParamName, string>> = {}
  for (const paramName of meta.paramNames) {
    const value = input[paramName]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      params[paramName] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      params[paramName] = String(value)
    } else {
      params[paramName] = JSON.stringify(value)
    }
  }
  return params
}

export function validateNativeToolInput(name: ToolUseName, input: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const meta = getToolMetadata(name)
  if (!meta) return { ok: false, error: `Tool '${name}' is not registered.` }

  for (const required of requiredParamsByTool[name] ?? []) {
    const value = input[required]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return { ok: false, error: `Missing required parameter '${required}' for tool '${name}'.` }
    }
  }

  const allowed = new Set(meta.paramNames)
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as ToolParamName)) {
      return { ok: false, error: `Unexpected parameter '${key}' for tool '${name}'.` }
    }
  }

  return { ok: true }
}
