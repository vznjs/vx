# `src/workspace/migration.ts` — the plan → files seam

## Purpose

What any adoption tool needs once it has decided what a package's tasks
are: the plan's shape, TypeScript emission, the overwrite guard, the
writes (or the `--dry` print), and the report. Core knows no source
format here — a mapper returns a `MigrationPlan` and `applyMigration`
does the rest. `@vzn/vx-migrate` maps package.json scripts, Turbo, Nx
and Vite Task through it. Before 2026-09-10 the Turbo and Nx mappers
lived in `src/cli/`, and the scripts mapper until 2026-10-14; core reads
no `package.json` for an adoption.

## Public surface (exported from `@vzn/vx`)

```ts
export interface MigrationPlan {
  headerNotes: string[]
  projects: GeneratedProject[]
  extraFiles: { relPath: string; contents: string }[]
  notes: string[]
}
export interface GeneratedProject {
  name: string
  dir: string
  importLines: string[]
  tags?: readonly string[] // written as the config's `tags` when non-empty (an Nx project's)
  writeName?: boolean // writes `name`: no manifest names the project (an Nx repo with no package.json)
  tasks: GeneratedTask[]
}
export interface GeneratedTask {
  name: string
  todos: string[] // rendered as `// TODO(vx-migrate): …` (a line break continues the comment) and listed in the report
  task: Record<string, unknown> | null // TaskConfig-shaped; arrays may hold a RawExpr splice
}
export interface RawExpr {
  readonly raw: string
} // a verbatim TS expression
export type MigrationFormat = 'ts' | 'mjs'
// A project the tool found; `packageJson.type` picks `vx.config.mts`.
export interface MigrationMember {
  readonly name: string
  readonly dir: string
  readonly configPath: string | null
  readonly packageJson?: object
}
export interface ApplyMigrationArgs {
  root: string
  metas: readonly MigrationMember[]
  plan: MigrationPlan
  source: string
  verb: string
  dry: boolean
  force: boolean
  init?: boolean
  notes?: readonly string[]
  unmapped?: boolean // init: scripts exist, none became a task (M-59)
  emptyReason?: string // init: why the plan is empty, the report's line in place of the example
  format?: MigrationFormat // default 'ts'
  json?: boolean // with dry: one JSON document (schemas/init.json) for files + report
  lock?: (root: string) => Promise<{ code: number; said: string }> // after the write: vx lock's step, its line the `lock` row; a refusal prints above the report, exit stays 0
  steps?: readonly (readonly [label: string, value: string])[] // what the tool did first, e.g. ['ran', 'bun add -d …']
  plugins?: readonly WorkspacePlugin[] // { pkg, factory }: what the written workspace file declares
}
export function applyMigration(args: ApplyMigrationArgs): Promise<number>
// The files `vx init` writes outside a Turbo or Nx repo (type-only import,
// so a user's tsc checks them against config.ts alone), and whether a file
// is that root config, untouched: a migration maps over it (no conflict).
export function starterProject(format: MigrationFormat): string
export function renderWorkspace(
  format: MigrationFormat,
  plugins: readonly WorkspacePlugin[],
): string
export function isStarterConfig(file: string): boolean
export function quoteTsLiteral(s: string): string
export const PERSISTENT_TODO: string
// Drops `note` from each persistent task no `dependsOn` in the mapping
// names: nothing waits on it, so there is nothing to gate. Every mapper
// runs it last.
export function pruneOrphanPersistentNotes(
  projects: readonly {
    readonly tasks: readonly {
      readonly name: string
      readonly todos: string[]
      readonly task: Record<string, unknown> | null
    }[]
  }[],
  note: string,
): void
// A script with the pre/post hooks npm runs around it, as one sh command:
// each part a subshell, the chain stopping at the first that fails, and the
// forwarded `--` args reaching the body alone (item 905). No hooks: the
// body, verbatim. Every scripts mapper folds through it.
export function foldScriptHooks(
  pre: string | undefined,
  body: string,
  post: string | undefined,
): string
// Why `name` cannot be a task's (the schema's rule), or null: a mapper
// leaves such a script out with a TODO.
export function taskNameProblem(name: string): string | null

// Core-internal (src/workspace/index.ts): how the user runs vx, for a
// `next` row — the runner in `npm_config_user_agent`, else `vx`.
export function vxInvocation(userAgent: string | undefined, installed: boolean): string
```

## Rules

- A generated config is `import type { ProjectConfig } from '@vzn/vx/config'` plus
  `satisfies ProjectConfig`: the type-only form loads in a workspace that
  runs the binary without the package installed. `format: 'mjs'`
  (`--mjs`) writes the same object untyped as `vx.config.mjs`, for a
  package whose `tsconfig` `include` would not cover a `.ts` config.
- A `ts` config is `vx.config.mts` in a package with a `tsconfig.json`
  and no `"type": "module"`: tsc reads a `.ts` there as CommonJS and its
  type import of the ESM `@vzn/vx/config` fails (TS1479, TS1541). An
  output's `!vx.config.ts` take-back there becomes `!vx.config.mts`.
- After the write, the files go through the first formatter the root's
  `node_modules/.bin` holds (prettier, biome, oxfmt, dprint), as Nx's
  generators do, so the repo's own format check passes them; a `note`
  row says which, or the error a failing one printed. Not under `dry`.
- A written file `.gitignore` drops gets a `note`: the `!file` line
  that keeps it, or, inside an ignored directory (an old `/.vx/` line),
  that directory, since no `!` line re-includes a file there. vx never
  edits `.gitignore`.
- An empty plan in a single-project workspace whose root `package.json`
  has no `workspaces` field, while packages with scripts sit beneath it,
  is reported as such: the report names the packages the missing field
  never reaches (item 248) instead of "nothing to migrate".
- The workspace file is written when no `.vx/workspace.{ts,mts,js,mjs,cts,cjs}` exists:
  a migrated workspace declares its plugins (`plugins`; vx-migrate's
  scripts path passes the lockfile's `@vzn/vx-lockfile` one), and an empty list is a
  complete workspace (the floor). A plan that brings its own (vx-migrate's,
  declaring plugins) replaces it. Neither the configs nor the workspace
  file carries a "generated by" header or explanatory comment.
- Nothing is overwritten without `force`. Under a scripts migration (`init`) a
  project that already has a config keeps it, untouched, and the report
  lists it under `kept`; the rest are written (M-52). For a migration, a
  discovered project with any existing config, and under either caller
  every actual write target (a synthesized root project, the Turbo
  preset), abort the whole run before a byte lands.
- No write goes through a symlink (`src/util/write-file.ts`, shared with
  `vx init` and `vx lock`): `refuseSymlink` refuses every target that is a
  link before the first write, so a refusal leaves none half-made, and
  `writeNoFollow` writes a temp beside the file, renamed over it, so a
  link put there after the check is replaced, not followed.
- `init` distinguishes the two callers on an empty plan: a scripts
  migration of a workspace with no scripts still writes the workspace
  file and shows a worked example (or `emptyReason`); a migration with
  nothing to convert is an error.
- `quoteTsLiteral` escapes backslash, quote and raw newlines — a value with
  an embedded newline (legal JSON) must round-trip through the loader.

## What it does NOT do

- Read `package.json`, `turbo.json`, an Nx graph, or any other runner's
  format. That is `@vzn/vx-migrate`, whose `turbo()` and `nx()` plugins
  run the same mappings live.

## Tests

`tests/migration.test.ts` (rendering, the overwrite guard, the report);
`packages/vx-migrate/tests/` (scripts, Turbo, Nx and Vite Task end to
end through the seam).
