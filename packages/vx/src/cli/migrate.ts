// `vx migrate [--dry] [--force]` — generate per-package vx.config.ts
// from an existing Turbo or Nx setup. Source auto-detect: turbo.json →
// Turbo; .nx/workspace-data/project-graph.json → Nx (the resolved
// snapshot). Mappers live in migrate-turbo.ts / migrate-nx.ts and
// return an IR; this file owns detection, TS emission, the overwrite
// guard, and the final report.

import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import { findWorkspaceRoot, listProjects, loadWorkspace } from '../workspace/index.js'
import { quote } from './migrate-emit.js'
import { migrateNx } from './migrate-nx.js'
import { migrateScripts } from './migrate-scripts.js'
import { migrateTurbo } from './migrate-turbo.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  from?: 'turbo' | 'nx' | 'scripts'
  error?: string
}

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--from' || a?.startsWith('--from=')) {
      const v = a === '--from' ? args[++i] : a.slice('--from='.length)
      if (v !== 'turbo' && v !== 'nx' && v !== 'scripts') {
        return { ...out, error: `--from must be turbo, nx or scripts` }
      }
      out.from = v
    } else if (a?.startsWith('-')) return { ...out, error: `unknown flag: ${a}` }
    else return { ...out, error: `unexpected argument: ${a}` }
  }
  return out
}

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

export async function migrateCmd(
  args: readonly string[],
  opts: { init?: boolean } = {},
): Promise<number> {
  const parsed = parseMigrateArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx migrate: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await listProjects(await loadWorkspace(root))

  const hasTurbo = await Bun.file(path.join(root, 'turbo.json')).exists()
  const graphRel = path.join('.nx', 'workspace-data', 'project-graph.json')
  const hasGraph = await Bun.file(path.join(root, graphRel)).exists()
  const hasNxJson = await Bun.file(path.join(root, 'nx.json')).exists()

  // Evaluating teams routinely have both runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  if (parsed.from === undefined && hasTurbo && (hasGraph || hasNxJson)) {
    throw new UserError(
      'both turbo.json and an nx workspace are present — pass --from turbo or --from nx',
    )
  }
  if (parsed.from === 'turbo' && !hasTurbo) {
    throw new UserError('--from turbo, but no turbo.json at the workspace root')
  }

  let source: string
  let plan: MigrationPlan
  if (parsed.from === 'scripts') {
    source = 'package.json scripts'
    plan = migrateScripts(metas)
  } else if (parsed.from === 'nx' || (parsed.from === undefined && !hasTurbo)) {
    if (hasGraph) {
      source = '.nx/workspace-data/project-graph.json'
      plan = await migrateNx(root, metas)
    } else if (hasNxJson || parsed.from === 'nx') {
      // Modern Nx stores the graph in SQLite — the JSON snapshot only
      // exists when exported explicitly.
      throw new UserError(
        'no resolved Nx graph found — export one with ' +
          '`nx graph --file=.nx/workspace-data/project-graph.json`, then re-run vx migrate',
      )
    } else {
      // A workspace from nowhere: the scripts are the source (`vx init`).
      source = 'package.json scripts'
      plan = migrateScripts(metas)
    }
  } else {
    source = 'turbo.json'
    plan = await migrateTurbo(root, metas)
  }
  // `vx init` on a workspace with no scripts still has a job: the
  // workspace file, which every run needs, and a worked example of the
  // config the user writes next. `vx migrate` with nothing to convert is
  // an error: the user asked for a conversion that has no input.
  const empty = plan.projects.length === 0
  if (empty && opts.init !== true) {
    throw new UserError(
      `nothing to migrate: no ${source === 'package.json scripts' ? 'package.json scripts in any workspace member' : 'tasks in ' + source}`,
    )
  }

  const files: { relPath: string; abs: string; contents: string }[] = []
  for (const p of plan.projects) {
    if (p.tasks.length === 0) continue
    const abs = path.join(p.dir, 'vx.config.ts')
    files.push({ relPath: relPosix(root, abs), abs, contents: renderConfigFile(source, p) })
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

  if (!parsed.dry && !parsed.force) {
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

  if (parsed.dry) {
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
      'vx init: no package.json scripts to turn into tasks.',
      hasWorkspaceFile ? 'vx.workspace.ts already exists.' : 'wrote vx.workspace.ts.',
      'Declare tasks in a vx.config.ts beside a package.json, for example:',
      '',
      ...EXAMPLE_CONFIG.trimEnd()
        .split('\n')
        .map((l) => `  ${l}`),
    )
  } else {
    report.push(`vx migrate: ${source} → vx.config.ts`)
    for (const n of plan.headerNotes) report.push(`note: ${n}`)
    report.push(
      '',
      `${clean} task${clean === 1 ? '' : 's'} migrated clean, ` +
        `${todoList.length} TODO${todoList.length === 1 ? '' : 's'}${todoList.length > 0 ? ':' : ''}`,
    )
    for (const line of todoList) report.push(`  ${line}`)
    report.push(...plan.notes)
    report.push(parsed.dry ? 'files (dry run, nothing written):' : 'files written:')
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

const WORKSPACE_FILE = `import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

// Nothing runs that is not declared here. Put a remote executor or cache
// plugin BEFORE the local one to prefer it.
export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
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
  if (typeof v === 'string') return quote(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map((x) => renderValue(x, indent)).join(', ')}]`
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (entries.length === 0) return '{}'
  const inner = `${indent}  `
  const body = entries.map(
    ([k, x]) => `${inner}${IDENT.test(k) ? k : quote(k)}: ${renderValue(x, inner)},`,
  )
  return `{\n${body.join('\n')}\n${indent}}`
}

function renderConfigFile(source: string, p: GeneratedProject): string {
  // A type-only import: the editor type-checks against the installed
  // package, and Bun erases it, so the config loads in a workspace that
  // runs the vx binary without the package installed.
  const lines: string[] = [
    `// Generated by \`vx migrate\` from ${source}. Review the TODO(vx-migrate) comments.`,
    "import type { ProjectConfig } from '@vzn/vx'",
  ]
  if (p.importLines.length > 0) lines.push(...p.importLines)
  lines.push('', 'export default {', '  tasks: {')
  for (const t of p.tasks) {
    for (const todo of t.todos) lines.push(`    // TODO(vx-migrate): ${todo}`)
    if (t.task === null) continue // skipped target — the TODO above explains
    const key = IDENT.test(t.name) ? t.name : quote(t.name)
    lines.push(`    ${key}: ${renderValue(t.task, '    ')},`)
  }
  lines.push('  },', '} satisfies ProjectConfig', '')
  return lines.join('\n')
}
