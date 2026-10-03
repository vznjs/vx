// The migration seam: what any adoption tool needs once it has a plan —
// the plan's shape, TS emission, the overwrite guard, the writes and the
// report. `vx init` (package.json scripts, in core) and `@vzn/vx-migrate`
// (Turbo, Nx) share it, so a generated config reads the same whichever
// tool wrote it. Core knows no source format here: a mapper returns a
// `MigrationPlan` and this file does the rest.

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { executablePath, relPosix, UserError } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'
import { loadWorkspace, reachesManifest, unreachedHint, unreachedPackages } from './workspace.js'
import { WORKSPACE_CONFIG_FILENAMES } from './project-loader.js'

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

/**
 * A package.json script with the `pre<name>` / `post<name>` hooks npm runs
 * around it, as ONE sh command. Each part runs in its own subshell, so a
 * `;` or an `exit` in one ends that part alone, and the chain stops at the
 * first that fails, as npm stops. The parts sit in a function the
 * forwarded `--` args are appended to, and only the body takes them, as
 * npm appends them to the script and never to its hooks. A plain ` && `
 * join handed them to the post hook, and `test -f x && echo A; echo B` ran
 * `echo B` after a failed pre hook and went green (item 905). Each part
 * ends on its own line, so a trailing `# comment` cannot swallow the
 * paren. A script with no hooks is its body, verbatim.
 */
export function foldScriptHooks(
  pre: string | undefined,
  body: string,
  post: string | undefined,
): string {
  if (pre === undefined && post === undefined) return body
  const parts = [
    ...(pre === undefined ? [] : [`(${pre}\n)`]),
    `(${body} "$@"\n)`,
    ...(post === undefined ? [] : [`(${post}\n)`]),
  ]
  return `vx_script() {\n${parts.join(' && ')}\n}\nvx_script`
}

/**
 * Where a framework's build writes by default, for the cache TODO: the
 * hint said `dist/**` to every build, `next build` included, which writes
 * `.next`. Each tool's documented default; anything else keeps `dist/**`.
 */
const BUILD_OUTPUTS: readonly [RegExp, readonly string[]][] = [
  [/\snext build\s/, ['.next/**', '!.next/cache/**']],
  [/\snux[ti] build\s/, ['.output/**']],
  [/\s(?:remix|react-router|react-scripts|docusaurus) build\s/, ['build/**']],
  [/\sgatsby build\s/, ['public/**']],
  [/\s(?:storybook build|build-storybook)\s/, ['storybook-static/**']],
]

/** A directory a TODO may name: relative, plain, no hidden or tool dir. */
const OUTPUT_DIR = /^(?:\.\/)?((?![./])[\w@-][\w@./-]*?)\/?$/

/**
 * The directory the command says it writes, when no tool above names one:
 * an out-dir flag (`tsc --outDir lib`, `babel -d lib`), else the
 * directories it cleans first (`del-cli distribution`, `rimraf dist
 * types`). ky's build writes `distribution/`, and the TODO said `dist/**`
 * (D-90). A file (`tsconfig.tsbuildinfo`) and `node_modules` are no output.
 */
function namedOutputs(command: string): string[] | undefined {
  const dir = (w: string | undefined): string | undefined => {
    const m = w === undefined ? null : OUTPUT_DIR.exec(w.replace(/^(["'])(.*)\1$/, '$2'))
    if (m === null) return undefined
    const d = m[1]!
    return /\.[a-z]+$/i.test(d) || d.split('/').includes('node_modules') ? undefined : d
  }
  const flag = /\s(?:--outDir|--out-dir|--outdir|-d)[\s=](\S+)/.exec(` ${command} `)
  const out = dir(flag?.[1])
  if (out !== undefined) return [`${out}/**`]
  for (const segment of command.split(/[;&|()]+/)) {
    const words = segment.trim().split(/\s+/)
    const at =
      words[0] === 'rimraf' || words[0] === 'del-cli' || words[0] === 'del'
        ? 1
        : words[0] === 'rm' || (words[0] === 'shx' && words[1] === 'rm')
          ? words.indexOf('rm') + 1
          : -1
    if (at < 0) continue
    const args = words.slice(at).filter((w) => !w.startsWith('-'))
    // A dir the command makes again (kit's `rm -rf ./missing_ids && mkdir
    // ./missing_ids && vite build`) is a scratch dir it prepares, not output.
    const made = new Set([...command.matchAll(/\bmkdir\s+(?:-p\s+)?(\S+)/g)].map((m) => dir(m[1])))
    const dirs = args
      .map(dir)
      .filter((d): d is string => d !== undefined)
      .filter((d) => !made.has(d))
    // Every cleaned path a directory vx can name, or the guess is not this.
    return dirs.length > 0 && dirs.length === args.filter((w) => !/\.[a-z]+$/i.test(w)).length
      ? dirs.map((d) => `${d}/**`)
      : undefined
  }
  return undefined
}

/** The cache block the task that builds `command` should declare, as a TODO on it. */
export function cacheTodo(command: string): string {
  // Padded, separators as spaces: `next build && …` and `(next build)` match.
  const words = ` ${command.replace(/[;&|()]/g, ' ')} `
  const hit = BUILD_OUTPUTS.find(([re]) => re.test(words))
  const outputs = (hit?.[1] ?? namedOutputs(command) ?? ['dist/**']).map((o) => `'${o}'`).join(', ')
  return `cache: add \`cache: { inputs: { files: ['src/**'] }, outputs: { files: [${outputs}] } }\` with this package's real inputs and outputs — without it the task always runs and every file here, what it writes included, folds into the key its dependents fold; a block with EMPTY outputs would be a cached no-op, not an uncached task`
}

const isCacheTodo = (todo: string): boolean => todo.startsWith('cache: add `cache: {')

/** The one wording every mapper emits for a task it made persistent. */
export const PERSISTENT_TODO =
  'persistent task — set persistent.readyWhen (regex matched against output) so ' +
  'dependents unblock on readiness, and consider exec.timeout to bound the wait'

// The readiness note a persistent task carries ("add `readyWhen` to gate
// dependents") is moot for a task nothing depends on: no one waits for it,
// so there is nothing to gate. refine printed it for 375 `dev` and `start`
// tasks on every run, none of them anyone's dependency (item 602), and
// `vx init` wrote it on hoppscotch's 24 `dev`-shaped scripts. Every mapper
// runs this last, over the whole mapping, since a dependent may sit in
// another package.

/** Strips the note from every persistent task no `dependsOn` in the mapping names. */
export function pruneOrphanPersistentNotes(
  projects: readonly {
    readonly tasks: readonly {
      readonly name: string
      readonly todos: string[]
      readonly task: Record<string, unknown> | null
    }[]
  }[],
  note: string,
): void {
  const referenced = new Set<string>()
  for (const project of projects) {
    for (const t of project.tasks) {
      const deps = t.task?.['dependsOn']
      if (!Array.isArray(deps)) continue
      for (const d of deps) {
        if (typeof d !== 'string') continue
        // `^name`, `pkg#name` and `name` all name the same task.
        const hash = d.indexOf('#')
        referenced.add(hash === -1 ? d.replace(/^\^/, '') : d.slice(hash + 1))
      }
    }
  }
  for (const project of projects) {
    for (const t of project.tasks) {
      if (referenced.has(t.name)) continue
      const at = t.todos.indexOf(note)
      if (at !== -1) t.todos.splice(at, 1)
    }
  }
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
  /** trailing report lines (e.g. what a turbo.json holds that vx has no place for) */
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
  /**
   * `ts` (default) writes `vx.config.ts` with the type-only import and
   * `satisfies`; `mjs` writes `vx.config.mjs` — the same object, untyped —
   * for a package whose own `tsc --build` includes every `.ts` under it
   * and compiled the config into its dist (TanStack/query, 2026-09-11).
   */
  format?: MigrationFormat
}

export type MigrationFormat = 'ts' | 'mjs'

/**
 * Render a plan to files, refuse to overwrite without `force`, write (or
 * print, under `dry`), and report. Returns the process exit code.
 */
export async function applyMigration(args: ApplyMigrationArgs): Promise<number> {
  const { root, metas, plan, source, verb, dry, force } = args
  const init = args.init === true
  const format: MigrationFormat = args.format ?? 'ts'
  const configName = `vx.config.${format}`
  const workspaceName = `vx.workspace.${format}`
  const empty = plan.projects.length === 0
  if (empty && !init) {
    throw new UserError(
      `nothing to migrate: no ${source === 'package.json scripts' ? 'package.json scripts in any workspace member' : 'tasks in ' + source}`,
    )
  }

  const files: { relPath: string; abs: string; contents: string }[] = []
  for (const p of plan.projects) {
    if (p.tasks.length === 0) continue
    const abs = path.join(p.dir, configName)
    files.push({
      relPath: relPosix(root, abs),
      abs,
      contents: renderConfigFile(source, p, verb, format),
    })
  }
  for (const f of plan.extraFiles) {
    files.push({ relPath: f.relPath, abs: path.join(root, f.relPath), contents: f.contents })
  }
  // A migrated workspace must declare its executor and cache — nothing is
  // applied by default. Emit the workspace file unless the repo already has
  // one in any extension the loader reads: a hand-written `.mts` was missed,
  // and the `.ts` written beside it won by load order (item 1033).
  const hasWorkspaceFile = (
    await Promise.all(WORKSPACE_CONFIG_FILENAMES.map((n) => Bun.file(path.join(root, n)).exists()))
  ).some(Boolean)
  if (!hasWorkspaceFile) {
    const abs = path.join(root, workspaceName)
    files.push({ relPath: relPosix(root, abs), abs, contents: workspaceFile(format) })
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

  // Under --force a project's config of another extension is REPLACED: the
  // new one was written beside it, the loader read one of the two by its
  // order, and the report said "written" for a file the run never loaded
  // (item 1033).
  const replaced: string[] = []
  for (const p of plan.projects) {
    if (p.tasks.length === 0) continue
    const existing = metas.find((m) => m.dir === p.dir)?.configPath
    if (existing && existing !== path.join(p.dir, configName)) replaced.push(existing)
  }
  if (dry) {
    for (const f of files) {
      process.stdout.write(`── ${f.relPath} ──\n${f.contents}\n`)
    }
  } else {
    for (const f of files) await Bun.write(f.abs, f.contents)
    for (const f of replaced) await unlink(f)
  }

  // One reason, its tasks: on a Turbo template the same two-line cache TODO
  // printed five times and the persistent one eight (the first-five-minutes
  // walk, 2026-09-28), and the list read as noise.
  const todos = new Map<string, string[]>()
  let todoCount = 0
  let clean = 0
  let cached = false
  for (const p of plan.projects) {
    for (const t of p.tasks) {
      if (t.todos.length === 0 && t.task !== null) clean++
      if (t.task !== null && 'cache' in t.task) cached = true
      for (const reason of t.todos) {
        todoCount++
        const ids = todos.get(reason) ?? []
        ids.push(`${p.name}#${t.name}`)
        todos.set(reason, ids)
      }
    }
  }
  const report: string[] = []
  // Single-project mode with packages the root's missing `workspaces` never
  // reaches: the scripts exist, the globs do not (item 248).
  const workspace = empty ? await loadWorkspace(root) : undefined
  const unreached = workspace === undefined ? [] : await unreachedPackages(workspace)
  // Globs that reach no package: "no scripts" was true and named nothing
  // to fix (M-42).
  const globs = workspace?.packageGlobs.filter((g) => g !== '.') ?? []
  // Asked of the globs, not of `metas`: a nameless or shared-name member
  // is matched yet absent from `metas` (M-46).
  const noMembers =
    workspace !== undefined && globs.length > 0 && !(await reachesManifest(workspace))
      ? [
          `the workspace globs (${globs.map((g) => `"${g}"`).join(', ')}) match no package.json: add a package under one, or fix the glob`,
        ]
      : []
  if (empty && unreached.length > 0) {
    report.push(
      `${verb}: ${unreachedHint(unreached)}`,
      hasWorkspaceFile
        ? `${workspaceName} already exists.`
        : dry
          ? `would write ${workspaceName} (dry run, nothing written).`
          : `wrote ${workspaceName}.`,
    )
  } else if (empty) {
    report.push(
      `${verb}: no package.json scripts to turn into tasks.`,
      ...[...noMembers, ...(args.notes ?? [])].map((n) => `note: ${n}`),
      hasWorkspaceFile
        ? `${workspaceName} already exists.`
        : dry
          ? `would write ${workspaceName} (dry run, nothing written).`
          : `wrote ${workspaceName}.`,
      `Declare tasks in a ${configName} beside a package.json — your own command, for example:`,
      '',
      ...exampleConfig(format)
        .trimEnd()
        .split('\n')
        .map((l) => `  ${l}`),
    )
  } else {
    report.push(`${verb}: ${source} → ${configName}`)
    for (const n of args.notes ?? []) report.push(`note: ${n}`)
    for (const n of plan.headerNotes) report.push(`note: ${n}`)
    report.push(
      '',
      `${clean} task${clean === 1 ? '' : 's'} migrated clean, ` +
        `${todoCount} TODO${todoCount === 1 ? '' : 's'}${todoCount > 0 ? ':' : ''}`,
    )
    for (const [reason, ids] of todos) {
      if (ids.length === 1) report.push(`  ${ids[0]}: ${reason}`)
      else {
        const shown = ids.slice(0, TODO_IDS_SHOWN).join(', ')
        const more = ids.length - TODO_IDS_SHOWN
        report.push(`  ${shown}${more > 0 ? ` and ${more} more` : ''}:`, `    ${reason}`)
      }
    }
    report.push(...plan.notes)
    report.push(dry ? 'files (dry run, nothing written):' : 'files written:')
    for (const f of files) report.push(`  ${f.relPath}`)
    if (replaced.length > 0) {
      report.push(dry ? 'would replace (dry run):' : 'replaced:')
      for (const f of replaced) report.push(`  ${relPosix(root, f)}`)
    }
  }
  const firstTask = nextTask(plan.projects.flatMap((p) => p.tasks))
  // A run of tasks none of which caches is never a hit, and a first try
  // that runs twice to see the cache work saw it run twice.
  if (!cached && [...todos.keys()].some(isCacheTodo)) {
    report.push('', 'no task caches yet: add the cache block a TODO shows, and a second run hits')
  }
  const installed = existsSync(path.join(root, 'node_modules', '@vzn', 'vx', 'package.json'))
  // The line is the next thing to type, so it names what that run would
  // refuse without: a git work tree (vx keys inputs on git's view) and,
  // with no scripts mapped, a task to run.
  const run = `${vxInvocation(process.env['npm_config_user_agent'], installed)} run ${firstTask} --all`
  const steps = [
    ...(inGitWorkTree(root) ? [] : ['git init']),
    ...(empty ? [`declare a task as the example shows`] : []),
  ]
  report.push('', `next: ${steps.length === 0 ? run : `${steps.join(', ')}, then ${run}`}`)
  process.stdout.write(`${report.join('\n')}\n`)
  return 0
}

function inGitWorkTree(root: string): boolean {
  try {
    return (
      Bun.spawnSync({
        cmd: [executablePath('git'), 'rev-parse', '--is-inside-work-tree'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'ignore',
      })
        .stdout.toString()
        .trim() === 'true'
    )
  } catch {
    return false
  }
}

/** Names that change the repo or the world rather than check it. */
const NOT_A_TRY = /^(clean|reset|nuke|release|publish|deploy|version|format|fix)(?:$|[:\-_.])/

/**
 * The task the `next:` line runs: `build`, else the first task that
 * neither serves nor changes anything, else the first. react-navigation, whose
 * packages build in `prepack`, was told `vx run clean --all` (D-105).
 */
function nextTask(tasks: readonly GeneratedTask[]): string {
  const names = tasks.filter((t) => t.task !== null).map((t) => t.name)
  const fit = tasks.find(
    (t) =>
      t.task !== null &&
      !NOT_A_TRY.test(t.name) &&
      (t.task['exec'] as { persistent?: unknown } | undefined)?.persistent === undefined,
  )
  return names.includes('build') ? 'build' : (fit?.name ?? names[0] ?? 'build')
}

/**
 * How the user runs vx, for the report's `next:` line. After `npx vx init`
 * or `bunx @vzn/vx init` a bare `vx` is on no PATH (the first-five-minutes
 * walk, 2026-09-28), so the line names the runner that started this
 * process — npx, pnpm, yarn and Bun each set `npm_config_user_agent` — and
 * the spec it resolves: the installed bin, else the package, since a bare
 * `bunx vx` or `npx vx` would fetch an unrelated package named `vx`. No
 * runner (a global install, the compiled binary): `vx`.
 */
export function vxInvocation(userAgent: string | undefined, installed: boolean): string {
  const runner = /^(npm|pnpm|yarn|bun)\//.exec(userAgent ?? '')?.[1]
  switch (runner) {
    case 'npm':
      return installed ? 'npx vx' : 'npx @vzn/vx'
    case 'bun':
      return installed ? 'bunx vx' : 'bunx @vzn/vx'
    case 'pnpm':
      return installed ? 'pnpm vx' : 'pnpm dlx @vzn/vx'
    case 'yarn':
      // `dlx` is Yarn 2+; Yarn 1 answers `Command "dlx" not found`.
      if (installed) return 'yarn vx'
      return userAgent!.startsWith('yarn/1.') ? 'npx @vzn/vx' : 'yarn dlx @vzn/vx'
    default:
      return 'vx'
  }
}

/** Ids named per shared TODO; the files carry each one (sveltejs/kit: 92 persistent tasks). */
const TODO_IDS_SHOWN = 5

const EXAMPLE_BODY = `export default {
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
}`

function exampleConfig(format: MigrationFormat): string {
  return format === 'ts'
    ? `import type { ProjectConfig } from '@vzn/vx/config'\n\n${EXAMPLE_BODY} satisfies ProjectConfig\n`
    : `${EXAMPLE_BODY}\n`
}

// ─── TS emission ──────────────────────────────────────────────────────

// Type-only import + `satisfies`, like the project configs: a runtime
// `import { defineWorkspace } from '@vzn/vx'` loads a SECOND copy of core
// into every run — measured 2026-09-09 at ~17 ms on a two-package
// workspace, a fifth of the whole run — for an identity function.
const WORKSPACE_BODY = `// Plugins are consulted in this order; running here and caching in
// .vx/cache are the floor under all of them, so an empty list is a
// complete workspace. Add a remote cache, a remote executor or telemetry
// as one entry each — those imports are the runtime ones.
export default { plugins: [] }`

function workspaceFile(format: MigrationFormat): string {
  return format === 'ts'
    ? `import type { WorkspaceConfig } from '@vzn/vx/config'\n\n${WORKSPACE_BODY} satisfies WorkspaceConfig\n`
    : `${WORKSPACE_BODY}\n`
}

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

function renderConfigFile(
  source: string,
  p: GeneratedProject,
  verb: string,
  format: MigrationFormat,
): string {
  // A type-only import: the editor type-checks against the installed
  // package, and Bun erases it, so the config loads in a workspace that
  // runs the vx binary without the package installed. `mjs` is the same
  // object with nothing to erase.
  const lines: string[] = [
    `// Generated by \`${verb}\` from ${source}. Review the TODO(vx-migrate) comments.`,
  ]
  if (format === 'ts') lines.push("import type { ProjectConfig } from '@vzn/vx/config'")
  if (p.importLines.length > 0) lines.push(...p.importLines)
  lines.push('', 'export default {', '  tasks: {')
  for (const t of p.tasks) {
    // A reason can quote a manifest's own text (an Nx `env` key), and a
    // line break there ended the comment: the rest was code in the file
    // the next run evaluates (D-21). Each line stays inside the comment.
    for (const todo of t.todos) {
      const [first, ...rest] = todo.split(/\r\n|[\n\r\u2028\u2029]/)
      lines.push(`    // TODO(vx-migrate): ${first}`, ...rest.map((l) => `    //   ${l}`))
    }
    if (t.task === null) continue // skipped target — the TODO above explains
    // `__proto__: {…}` in a literal SETS the prototype, quoted or not, and
    // the run refused the config (item 1033); a computed key is a property.
    const key =
      t.name === '__proto__'
        ? `[${quoteTsLiteral(t.name)}]`
        : IDENT.test(t.name)
          ? t.name
          : quoteTsLiteral(t.name)
    lines.push(`    ${key}: ${renderValue(t.task, '    ')},`)
  }
  lines.push('  },', format === 'ts' ? '} satisfies ProjectConfig' : '}', '')
  return lines.join('\n')
}
