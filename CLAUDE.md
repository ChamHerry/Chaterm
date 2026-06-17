# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chaterm is an Electron-based AI-driven terminal tool with intelligent command completion, multi-device management, AI Agent capabilities, and enterprise-grade security.

**Tech Stack:** Vue 3 + TypeScript + Pinia + Ant Design Vue + Monaco Editor + xterm.js + Electron 30 + better-sqlite3 + ssh2 + node-pty + Anthropic/OpenAI/Bedrock/Ollama + Vitest + Playwright

## Core Architecture

Three-layer: Renderer (Vue 3 SPA) → Preload (contextBridge IPC) → Main (Agent, SSH, Storage).

**Main Process Aliases:** `@shared` `@core` `@services` `@integrations` `@utils` `@api` → `src/main/agent/*`

**Renderer Process Aliases:** `@renderer` `@views` `@router` `@store` `@utils` `@api` `@config` `@` → `src/renderer/src/*`

## Development Commands

```bash
node scripts/patch-package-lock.js && npm install  # setup
npm run dev                                         # dev server
npm run lint && npm run typecheck && npm test       # pre-commit checks
```

## Behavioral Rules

### Rule 1 — Think Before Coding

State assumptions explicitly. If uncertain, ask rather than guess. Push back when a simpler approach exists. Stop when confused — name what's unclear.

### Rule 2 — Simplicity First

Minimum code that solves the problem. No speculative features. No abstractions for single-use code. If a senior engineer would call it overcomplicated, simplify.

### Rule 3 — Surgical Changes

Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style.

### Rule 7 — Surface Conflicts, Don't Average Them

If two existing patterns contradict, pick one (more recent / more tested), explain why, and flag the other for cleanup. Don't blend conflicting patterns.

### Rule 8 — Read Before You Write

Before adding code in a file, read its exports, the immediate caller, and any obvious shared utilities. "Looks orthogonal to me" is dangerous — if unsure why code is structured a certain way, ask.

### Rule 12 — Fail Loud

"Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.

## Code Standards

1. **Minimize Change Scope:** Only modify files directly related to current requirements
2. **Type Safety First:** Strict TypeScript, avoid `any`; new IPC channels must define types in `src/preload/index.d.ts`
3. **Maintain Contract Stability:** Do not break existing IPC interfaces, Pinia Stores, or database table structures
4. **Test Coverage:** Core logic changes require adding or updating unit tests
5. **No Emojis:** Prohibited in code, comments, logs, strings
6. **English Comments:** All code comments must be in English
7. **No Console Logging:** Use `createLogger(module)` from the project logger — never `console.*`
8. **Log Sanitization:** Never log objects that may contain credentials (configs, API configs, keychain objects). Never use string interpolation to embed sensitive values (hostnames, IPs, API keys, passwords). Use safe fields only: `logger.info('msg', { event: 'name', id, count, hasPassword: !!password })`. Use boolean flags (`hasApiKey`, `hasPrivateKey`) instead of actual values.

## Git Rules

- **No auto git operations:** Never run `git add` or `git commit` automatically
- After changes, only show `git status` and `git diff` for user review

## Electron Constraints

- Main: no blocking event loop; IPC payloads must be serializable. Entry: `src/main/index.ts`. Window management: `src/main/windowManager.ts`
- Preload: `contextBridge` only; minimal API surface; types in `src/preload/index.d.ts`
- Renderer: Vue 3 Composition API; Pinia for state. Entry: `src/renderer/src/main.ts`. Routes: `src/renderer/src/router/routes.ts`. Guards: `src/renderer/src/router/guards.ts`

## Agent Subsystem (src/main/agent)

- `api/` — AI provider adapters (Anthropic, OpenAI, Bedrock, Ollama)
- `core/` — controller, prompts, storage, context
- `services/` — telemetry, diff, terminal
- `integrations/` — remote-terminal, tools
- `shared/` — shared types and constants
- `utils/` — utility functions

Extending a provider: create file in `api/providers/`, register in `api/providers/types.ts`, complete in `api/index.ts`, route network requests through `api/retry.ts`.

## Database Migrations

New tables or schema changes:

1. Create timestamped file in `migrations/`
2. Ensure idempotent and replayable
3. Add service methods in corresponding `.service.ts`
4. Define types in `types.ts`

## i18n

All user-facing text must be translated into all 11 locale files: `zh-CN` `zh-TW` `en-US` `ja-JP` `ko-KR` `de-DE` `fr-FR` `it-IT` `pt-PT` `ru-RU` `ar-AR`

## Pre-commit Checklist

1. `npm run lint && npm run typecheck && npm test` passes
2. No formatting changes to unrelated files
3. Commit message follows Conventional Commits
4. UI changes: all 11 locale files updated
5. DB changes: migration file created
6. New IPC channels: types defined in `src/preload/index.d.ts`
7. No sensitive data committed

## Security

- No API keys, tokens, private domains in commits
- All IPC via `contextBridge`; validate all renderer IPC messages
- Evaluate security and bundle size before adding dependencies

## Related Docs

- Contribution: `CONTRIBUTING.md` / `CONTRIBUTING_zh.md`
- Agent development: `AGENTS.md`
- Security policy: `SECURITY.md`

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Chaterm** (75424 symbols, 191204 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).
- For control/data dependence, `pdg_query({mode: "controls", target: "fileOrSymbol"})` answers "under what condition does X run?" (CDG, incl. guard clauses) and `pdg_query({mode: "flows", target, variable})` traces "where does variable Y flow?" (REACHING_DEF). `--pdg` layer.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource                                 | Use for                                  |
| ---------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/Chaterm/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/Chaterm/clusters`       | All functional areas                     |
| `gitnexus://repo/Chaterm/processes`      | All execution flows                      |
| `gitnexus://repo/Chaterm/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->
