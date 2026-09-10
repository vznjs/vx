// The migration seam: what any adoption tool needs once it has a plan —
// the plan's shape, TS emission, the overwrite guard, the writes and the
// report. `vx init` (package.json scripts, in core) and `@vzn/vx-migrate`
// (Turbo, Nx) share it, so a generated config reads the same whichever
// tool wrote it. Core knows no source format here: a mapper returns a
// `MigrationPlan` and this file does the rest.

import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'

/**
 * Escape an arbitrary string into a single-quoted TS literal. Escapes
 * backslash + quote AND raw newlines/CR — a value with an embedded newline
 * (legal JSON, e.g. a script `"echo a\necho b"`, or a glob with a `'`) would
 * otherwise splice into a single-quoted literal as an unterminated / malformed
 * string that fails to load (generated files must round-trip through the
 * loader).
 */
export function quoteTsLiteral(s: string): string {
  return `'${s
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}'`
}

/**
 * Task names that conventionally never exit. Every mapper guesses the same
 * way from a name — a source that SAYS a task is long-running (turbo's
 * `persistent: true`, an Nx dev-server executor) is believed instead.
 */
export const PERSISTENT_TASK_NAMES: ReadonlySet<string> = new Set([
  'dev',
  'start',
  'serve',
  'watch',
  'preview',
])

/** The one wording every mapper emits for a task it made persistent. */
export const PERSISTENT_TODO =
  'persistent task — set persistent.readyWhen (regex matched against output) so ' +
  'dependents unblock on readiness, and consider exec.timeout to bound the wait'

/** Verbatim TS expression spliced into a generated array (preset spreads). */
export interface RawExpr {
  readonly raw: string
}

export interface GeneratedTask {
  name: string
  /** Rendered as `// TODO(vx-migrate): …` above the task + listed in the report. */
  todos: string[]
  /** TaskConfig-shaped object; arrays may contain RawExpr splices.
   *  null = target has no vx representation (skipped; todos explain). */
  task: Record<string, unknown> | null
}

export interface GeneratedProject {
  /** package.json name */
  name: string
  /** absolute project dir */
  dir: string
  importLines: string[]
  tasks: GeneratedTask[]
}

export interface MigrationPlan {
  /** report lines printed right under the source line */
  headerNotes: string[]
  projects: GeneratedProject[]
  /** extra root-relative files (e.g. the preset) */
  extraFiles: { relPath: string; contents: string }[]
  /** trailing report lines (e.g. implicit Nx deps) */
  notes: string[]
}

export interface ApplyMigrationArgs {
  root: string
  metas: readonly ProjectMeta[]
  plan: MigrationPlan
  /** Named in the report and the generated header, e.g. `turbo.json`. */
  source: string
  /** The command the user typed, e.g. `vx init` — named in the report. */
  verb: string
  dry: boolean
  force: boolean
  /**
   * `vx init` on a workspace with no scripts still has a job (the workspace
   * file, and a worked example); a migration with nothing to convert is an
   * error. Default false.
   */
  init?: boolean
  /** Report lines printed under the source line (e.g. "turbo.json found and not read"). */
  notes?: readonly string[]
}

/**
 * Render a plan to files, refuse to overwrite without `force`, write (or
 * print, under `dry`), and report. Returns the process exit code.
 */
export async function applyMigration(args: ApplyMigrationArgs): Promise<number> {
  const { root, metas, plan, source, verb, dry, force } = args
  const init = args.init === true
  const empty = plan.projects.length === 0
  if (empty && !init) {
    throw new UserError(
      `nothing to migrate: no ${source === 'package.json scripts' ? 'package.json scripts in any workspace member' : 'tasks in ' + source}`,
    )
  }

  const files: { relPath: string; abs: string; contents: string }[] = []
  for (const p of plan.projects) {
    if (p.tasks.length === 0) continue
    const abs = path.join(p.dir, 'vx.config.ts')
    files.push({ relPath: relPosix(root, abs), abs, contents: renderConfigFile(source, p, verb) })
  }
  for (const f of plan.extraFiles) {
    files.push({ relPath: f.relPath, abs: path.join(root, f.relPath), contents: f.contents })
  }
  // A migrated workspace must declare its executor and cache — nothing is
  // applied by default. Emit the workspace file unless the repo already has
  // one in any supported extension.
  const hasWorkspaceFile = (
    await Promise.all(
      ['vx.workspace.ts', 'vx.workspace.mjs', 'vx.workspace.js'].map((n) =>
        Bun.file(path.join(root, n)).exists(),
      ),
    )
  ).some(Boolean)
  if (!hasWorkspaceFile) {
    const abs = path.join(root, 'vx.workspace.ts')
    files.push({ relPath: relPosix(root, abs), abs, contents: WORKSPACE_FILE })
  }

  if (!dry && !force) {
    const conflicts = new Set<string>()
    // A discovered project with ANY existing vx config (.ts/.mjs/.js) — refuse
    // so we never shadow a hand-written config with a fresh .ts.
    for (const p of plan.projects) {
      if (p.tasks.length === 0) continue
      const meta = metas.find((m) => m.dir === p.dir)
      if (meta?.configPath) conflicts.add(relPosix(root, meta.configPath))
    }
    // ALSO stat every actual write target. A SYNTHESIZED project (e.g. the Nx
    // workspace-root node, dir === root) has no discovered meta, so the meta
    // scan alone would miss an existing vx.config.ts at that path and clobber
    // it. This also covers the extraFiles (vx-preset.ts).
    for (const f of files) {
      if (await Bun.file(f.abs).exists()) conflicts.add(f.relPath)
    }
    if (conflicts.size > 0) {
      throw new UserError(
        'refusing to overwrite existing files (pass --force to overwrite):\n' +
          `  ${[...conflicts].join('\n  ')}`,
      )
    }
  }

  if (dry) {
    for (const f of files) {
      process.stdout.write(`── ${f.relPath} ──\n${f.contents}\n`)
    }
  } else {
    for (const f of files) await Bun.write(f.abs, f.contents)
  }

  const todoList: string[] = []
  let clean = 0
  for (const p of plan.projects) {
    for (const t of p.tasks) {
      if (t.todos.length === 0 && t.task !== null) clean++
      for (const reason of t.todos) todoList.push(`${p.name}#${t.name}: ${reason}`)
    }
  }
  const report: string[] = []
  if (empty) {
    report.push(
      `${verb}: no package.json scripts to turn into tasks.`,
      hasWorkspaceFile
        ? 'vx.workspace.ts already exists.'
        : dry
          ? 'would write vx.workspace.ts (dry run, nothing written).'
          : 'wrote vx.workspace.ts.',
      'Declare tasks in a vx.config.ts beside a package.json — your own command, for example:',
      '',
      ...EXAMPLE_CONFIG.trimEnd()
        .split('\n')
        .map((l) => `  ${l}`),
    )
  } else {
    report.push(`${verb}: ${source} → vx.config.ts`)
    for (const n of args.notes ?? []) report.push(`note: ${n}`)
    for (const n of plan.headerNotes) report.push(`note: ${n}`)
    report.push(
      '',
      `${clean} task${clean === 1 ? '' : 's'} migrated clean, ` +
        `${todoList.length} TODO${todoList.length === 1 ? '' : 's'}${todoList.length > 0 ? ':' : ''}`,
    )
    for (const line of todoList) report.push(`  ${line}`)
    report.push(...plan.notes)
    report.push(dry ? 'files (dry run, nothing written):' : 'files written:')
    for (const f of files) report.push(`  ${f.relPath}`)
  }
  const firstTask =
    plan.projects.flatMap((p) => p.tasks.map((t) => t.name)).find((n) => n === 'build') ??
    plan.projects[0]?.tasks[0]?.name ??
    'build'
  report.push('', `next: vx run ${firstTask} --all`)
  process.stdout.write(`${report.join('\n')}\n`)
  return 0
}

const EXAMPLE_CONFIG = `import type { ProjectConfig } from '@vzn/vx'

export default {
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
} satisfies ProjectConfig
`

// ─── TS emission ──────────────────────────────────────────────────────

// Type-only import + `satisfies`, like the project configs: a runtime
// `import { defineWorkspace } from '@vzn/vx'` loads a SECOND copy of core
// into every run — measured 2026-09-09 at ~17 ms on a two-package
// workspace, a fifth of the whole run — for an identity function.
const WORKSPACE_FILE = `import type { WorkspaceConfig } from '@vzn/vx'

// Plugins are consulted in this order; running here and caching in
// .vx/cache are the floor under all of them, so an empty list is a
// complete workspace. Add a remote cache, a remote executor or telemetry
// as one entry each — those imports are the runtime ones.
export default { plugins: [] } satisfies WorkspaceConfig
`

const IDENT = /^[A-Za-z_$][\w$]*$/

function isRawExpr(v: unknown): v is RawExpr {
  return typeof v === 'object' && v !== null && typeof (v as RawExpr).raw === 'string'
}

function renderValue(v: unknown, indent: string): string {
  if (isRawExpr(v)) return v.raw
  // `Object.entries(null)` throws, which would abort the whole migration
  // with a raw stack mid-write. Mappers no longer produce a null, but a
  // literal is a readable thing to leave behind if one ever does.
  if (v === null) return 'null'
  if (typeof v === 'string') return quoteTsLiteral(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map((x) => renderValue(x, indent)).join(', ')}]`
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (entries.length === 0) return '{}'
  const inner = `${indent}  `
  const body = entries.map(
    ([k, x]) => `${inner}${IDENT.test(k) ? k : quoteTsLiteral(k)}: ${renderValue(x, inner)},`,
  )
  return `{\n${body.join('\n')}\n${indent}}`
}

function renderConfigFile(source: string, p: GeneratedProject, verb: string): string {
  // A type-only import: the editor type-checks against the installed
  // package, and Bun erases it, so the config loads in a workspace that
  // runs the vx binary without the package installed.
  const lines: string[] = [
    `// Generated by \`${verb}\` from ${source}. Review the TODO(vx-migrate) comments.`,
    "import type { ProjectConfig } from '@vzn/vx'",
  ]
  if (p.importLines.length > 0) lines.push(...p.importLines)
  lines.push('', 'export default {', '  tasks: {')
  for (const t of p.tasks) {
    for (const todo of t.todos) lines.push(`    // TODO(vx-migrate): ${todo}`)
    if (t.task === null) continue // skipped target — the TODO above explains
    const key = IDENT.test(t.name) ? t.name : quoteTsLiteral(t.name)
    lines.push(`    ${key}: ${renderValue(t.task, '    ')},`)
  }
  lines.push('  },', '} satisfies ProjectConfig', '')
  return lines.join('\n')
}
