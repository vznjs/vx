# `src/workspace/migration.ts` — the plan → files seam

## Purpose

What any adoption tool needs once it has decided what a package's tasks
are: the plan's shape, TypeScript emission, the overwrite guard, the
writes (or the `--dry` print), and the report. Core knows no source
format here — a mapper returns a `MigrationPlan` and `applyMigration`
does the rest — so a config written by `vx init` (package.json scripts,
`migrate-scripts.ts`, in core) and one written by `@vzn/vx-migrate`
(Turbo, Nx, its own package) read exactly the same. Before 2026-09-10
the Turbo and Nx mappers lived in `src/cli/`; core now reads no other
runner's format.

## Public surface (all exported from `@vzn/vx`)

```ts
export interface MigrationPlan {
  headerNotes: string[]
  projects: GeneratedProject[] // { name, dir, importLines, tasks: GeneratedTask[] }
  extraFiles: { relPath: string; contents: string }[]
  notes: string[]
}
export interface GeneratedTask {
  name: string
  todos: string[] // rendered as `// TODO(vx-migrate): …` and listed in the report
  task: Record<string, unknown> | null // TaskConfig-shaped; arrays may hold a RawExpr splice
}
export interface RawExpr {
  readonly raw: string
} // a verbatim TS expression
export interface ApplyMigrationArgs {
  root: string
  metas: readonly ProjectMeta[]
  plan: MigrationPlan
  source: string
  verb: string
  dry: boolean
  force: boolean
  init?: boolean
  notes?: readonly string[]
}
export function applyMigration(args: ApplyMigrationArgs): Promise<number>
export function quoteTsLiteral(s: string): string
export const PERSISTENT_TASK_NAMES: ReadonlySet<string>
export const PERSISTENT_TODO: string
export function migrateScripts(metas: readonly ProjectMeta[]): MigrationPlan
export function delegatedScript(command: string): string | null
```

## Rules

- A generated config is `import type { ProjectConfig } from '@vzn/vx'` plus
  `satisfies ProjectConfig`: the type-only form loads in a workspace that
  runs the binary without the package installed.
- The workspace file is written when no `vx.workspace.{ts,mjs,js}` exists:
  a migrated workspace declares its plugins, and an empty list is a
  complete workspace (the floor).
- Nothing is overwritten without `force`: a discovered project with any
  existing config, and every actual write target (a synthesized root
  project, the Turbo preset), abort the whole run before a byte lands.
- `init` distinguishes the two callers on an empty plan: `vx init` on a
  workspace with no scripts still writes the workspace file and shows a
  worked example; a migration with nothing to convert is an error.
- `quoteTsLiteral` escapes backslash, quote and raw newlines — a value with
  an embedded newline (legal JSON) must round-trip through the loader.
- `PERSISTENT_TASK_NAMES` is the one guess every mapper shares for "this
  task never exits"; a source that says so is believed instead.

## What it does NOT do

- Read `turbo.json`, an Nx graph, or any other runner's format. That is
  `@vzn/vx-migrate`, whose `turbo()` plugin runs the same Turbo
  mapping live.

## Tests

`tests/init.test.ts` (scripts → files, the empty workspace, the
overwrite guard, the `vx migrate` pointer, `delegatedScript`);
`packages/vx-migrate/tests/` (Turbo and Nx end to end through the seam).
