// The migration seam: what any adoption tool needs once it has a plan —
// the plan's shape, TS emission, the overwrite guard, the writes and the
// report. Every migrator shares it, so a generated config reads the same
// whichever tool wrote it. Core knows no source format or ecosystem here:
// a mapper returns a `MigrationPlan` and this file does the rest.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { workspaceFileWritten } from '../handoff.js'
import {
  checkIgnoreSync,
  DOT_VX_GITIGNORE,
  executablePath,
  gitEnv,
  refuseSymlink,
  relPosix,
  UserError,
  writeNoFollow,
} from '../util/index.js'
import { WORKSPACE_CONFIG_FILENAMES } from './project-loader.js'
import { PROJECT_CONFIG_FILENAMES } from './workspace.js'

/**
 * The nearest existing directory at or above `dir` (under `root`) and its
 * real path when that path is outside `realRoot`; none when it is inside.
 */
function linkOut(
  root: string,
  realRoot: string,
  dir: string,
): [link: string | undefined, real: string] {
  for (let at = dir; ; at = path.dirname(at)) {
    let real: string
    try {
      real = realpathSync(at)
    } catch {
      // quiet: not made yet; mkdir makes it a real directory under its parent
      if (at === root) return [undefined, realRoot]
      continue
    }
    const rel = path.relative(realRoot, real)
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      ? [at, real]
      : [undefined, real]
  }
}

/** The root config `vx init` writes when no migrator maps the workspace: no task yet. */
export function starterProject(format: MigrationFormat): string {
  return format === 'ts'
    ? "import type { ProjectConfig } from '@vzn/vx/config'\n\nexport default { tasks: {} } satisfies ProjectConfig\n"
    : 'export default { tasks: {} }\n'
}

/**
 * Whether `file` is `vx init`'s starter, untouched: a migration maps over it
 * as over no config, so the scripts `vx init` pointed at become tasks.
 */
export function isStarterConfig(file: string): boolean {
  try {
    // By extension: the mjs starter's text in a .ts file is a user's config.
    return readFileSync(file, 'utf8') === starterProject(file.endsWith('.ts') ? 'ts' : 'mjs')
  } catch {
    return false
  }
}

/** A C0 or C1 control, or DEL. */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

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
    .replaceAll('\r', '\\r')
    // Any other control as its escape: a script's raw ESC landed in the
    // file as the byte, and `cat vx.config.ts` retitled the terminal.
    .replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`
}

const isCacheTodo = (todo: string): boolean => todo.startsWith('cache: add `inputs: {')

/** The one wording every mapper emits for a task it made persistent. */
export const PERSISTENT_TODO =
  'persistent task — set persistent.readyWhen (regex matched against output) so ' +
  'dependents unblock on readiness, and consider exec.timeout to bound the wait'

// The readiness note a persistent task carries ("add `readyWhen` to gate
// dependents") is moot for a task nothing depends on: no one waits for it,
// so there is nothing to gate. Every mapper runs this last, over the
// whole mapping, since a dependent may sit in another project.

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
  /** Rendered as `// TODO(<verb>): …` above the task + listed in the report. */
  todos: string[]
  /** TaskConfig-shaped object; arrays may contain RawExpr splices.
   *  null = target has no vx representation (skipped; todos explain). */
  task: Record<string, unknown> | null
}

export interface GeneratedProject {
  /** The project's name. */
  name: string
  /** absolute project dir */
  dir: string
  importLines: string[]
  /** The project's `tags`; none written when empty. */
  tags?: readonly string[]
  /** Writes `name`: no manifest names the project, so its path would. */
  writeName?: boolean
  tasks: GeneratedTask[]
}

export interface MigrationPlan {
  /** report lines printed right under the source line */
  headerNotes: string[]
  projects: GeneratedProject[]
  /** extra root-relative files (e.g. the preset) */
  extraFiles: { relPath: string; contents: string }[]
  /** trailing report lines (e.g. what the source holds that vx has no place for) */
  notes: string[]
}

/** A project the adoption tool found: its name, directory and the vx config it already has. */
export interface MigrationMember {
  readonly name: string
  readonly dir: string
  readonly configPath: string | null
  /**
   * Whether tsc reads a `.ts` file in `dir` as an ES module. Where a
   * `tsconfig.json` sits beside it and this is not true, the config is
   * written as `vx.config.mts`, which tsc always reads as one.
   */
  readonly esModule?: boolean
}

export interface ApplyMigrationArgs {
  root: string
  metas: readonly MigrationMember[]
  plan: MigrationPlan
  /** What the plan was read from, named in the report, e.g. `turbo.json`. */
  source: string
  /** The tool's name: the report's title and each task's `TODO(<verb>)`. */
  verb: string
  dry: boolean
  force: boolean
  /**
   * A migration `vx init` hands over still has a job on a workspace with
   * nothing to convert (the workspace file, and a worked example); any
   * other migration with nothing to convert is an error. Default false.
   */
  init?: boolean
  /** The report's `note` lines (e.g. "turbo.json found and not read"). */
  notes?: readonly string[]
  /**
   * Why the plan is empty, in the tool's words: the `tasks` row of an
   * `init` report, or the refusal of any other migration. Default
   * `no tasks in <source>`.
   */
  emptyReason?: string
  /** An empty `init` plan's report shows a worked example config. Default: when `emptyReason` is unset. */
  example?: boolean
  /**
   * Run after the files are written (not under `dry`), with their
   * root-relative paths: a tool's own step over them, such as the repo's
   * formatter. Its lines join the report's notes.
   */
  written?: (relPaths: readonly string[]) => readonly string[]
  /**
   * `ts` (default) writes `vx.config.ts` with the type-only import and
   * `satisfies`; `mjs` writes `vx.config.mjs` — the same object, untyped —
   * for a project whose own `tsc --build` includes every `.ts` under it
   * and would compile the config into its output.
   */
  format?: MigrationFormat
  /**
   * With `dry`: one JSON document on stdout (`schemas/init.json`) in place
   * of the files and the report, so an agent reads the plan as data.
   */
  json?: boolean
  /**
   * Run after the files are written (not under `dry`): `vx lock`'s step, so
   * the migrated workspace has its .vx/projects.lock.json and its graph
   * rules checked. On success `said` is its line, shown as the
   * report's `lock` row; a refusal (a graph rule, a plugin not installed
   * yet) prints above the report, the files stay written, `vx lock` is the
   * step to re-run, and the exit is 1: a run reads only the lock, so the
   * migration is not done (as `vx init`'s own path exits).
   */
  lock?: (root: string) => Promise<{ code: number; said: string }>
  /** Rows of what the tool did before the write, e.g. `['ran', 'bun add -d …']`. */
  steps?: readonly (readonly [label: string, value: string])[]
  /** The plugins the written workspace file declares. */
  plugins?: readonly WorkspacePlugin[]
}

export interface WorkspacePlugin {
  readonly pkg: string
  readonly factory: string
}

export type MigrationFormat = 'ts' | 'mjs'

/**
 * What a migration did, for `report` to draw: the files a dry run shows,
 * the counts and lines of each row, the lock's answer, the next step.
 */
export interface MigrationReport {
  readonly verb: string
  readonly source: string
  readonly dry: boolean
  /** Under `dry`, each file as it would be written. */
  readonly shown: readonly { readonly relPath: string; readonly contents: string }[]
  readonly steps: readonly (readonly [label: string, value: string])[]
  /** Why the plan holds no task; none when it holds some. */
  readonly empty: string | undefined
  readonly clean: number
  readonly todo: number
  /** Each TODO reason and the task ids it holds. */
  readonly todos: readonly (readonly [reason: string, ids: readonly string[]])[]
  readonly files: readonly string[]
  readonly kept: readonly string[]
  readonly replaced: readonly string[]
  /** The lock step's answer; none under `dry` or with no lock step. */
  readonly lock?: { readonly code: number; readonly said: string }
  readonly notes: readonly string[]
  /** An empty plan's worked example: its label and the config. */
  readonly example?: readonly [label: string, config: string]
  readonly next: string
}

/**
 * Render a plan to files, refuse to overwrite without `force`, write them
 * (not under `dry`) and run the lock step. Returns what `report` draws, or
 * under `json` the one document a dry run prints.
 */
export async function writeMigration(
  args: ApplyMigrationArgs,
): Promise<MigrationReport | { readonly json: string }> {
  const { root, metas, plan, source, verb, dry, force } = args
  const init = args.init === true
  const format: MigrationFormat = args.format ?? 'ts'
  const configName = `vx.config.${format}`
  const workspaceName = `.vx/workspace.${format}`
  const empty = plan.projects.length === 0
  // An `init` migration never overwrites a member's config: a half-adopted workspace
  // keeps each one it has, by name, and gets the rest; `--force` still
  // replaces, as asked.
  const kept: string[] = []
  // Every project gets a config, a task-less one too: one left with none
  // reads as a project whose tasks are not locked.
  const planned = new Set(plan.projects.map((p) => p.dir))
  const unplanned: GeneratedProject[] = metas
    .filter((m) => !planned.has(m.dir))
    .map((m) => ({ name: m.name, dir: m.dir, importLines: [], tasks: [] }))
  const projects = [...plan.projects, ...unplanned].filter((p) => {
    // An empty config never replaces one a project has, --force or not.
    if (p.tasks.length === 0) return !metas.some((m) => m.dir === p.dir && m.configPath)
    if (!init || force) return true
    const existing = metas.find((m) => m.dir === p.dir)?.configPath
    if (!existing) return true
    kept.push(relPosix(root, existing))
    return false
  })
  // A plan never maps a workspace root that has a config, even under
  // `--force`; its file stays, so it is named with the rest.
  const rootConfig = metas.find((m) => m.dir === root)?.configPath
  // A one-project workspace's root is a mapped member too: the filter kept it already.
  if (
    init &&
    rootConfig &&
    !kept.includes(relPosix(root, rootConfig)) &&
    !projects.some((p) => p.dir === root && p.tasks.length > 0)
  ) {
    kept.push(relPosix(root, rootConfig))
  }
  if (empty && !init) {
    throw new UserError(`nothing to migrate: ${args.emptyReason ?? `no tasks in ${source}`}`)
  }

  const names = new Map(projects.map((p) => [p.dir, projectConfigName(p.dir, metas, format)]))
  const files: { relPath: string; abs: string; contents: string }[] = []
  for (const p of projects) {
    const abs = path.join(p.dir, names.get(p.dir)!)
    files.push({
      relPath: relPosix(root, abs),
      abs,
      contents: renderConfigFile(ownConfigNamed(p, names.get(p.dir)!, format), format, verb),
    })
  }
  for (const f of plan.extraFiles) {
    files.push({ relPath: f.relPath, abs: path.join(root, f.relPath), contents: f.contents })
  }
  // A migrated workspace must declare its executor and cache — nothing is
  // applied by default. Emit the workspace file unless the repo already has
  // one in any extension the loader reads: a `.ts` written beside a
  // hand-written `.mts` would win by load order.
  const hasWorkspaceFile = (
    await Promise.all(WORKSPACE_CONFIG_FILENAMES.map((n) => Bun.file(path.join(root, n)).exists()))
  ).some(Boolean)
  // A plan may bring its own.
  if (!hasWorkspaceFile && !plan.extraFiles.some((f) => f.relPath === workspaceName)) {
    const abs = path.join(root, workspaceName)
    files.push({
      relPath: relPosix(root, abs),
      abs,
      contents: renderWorkspace(format, args.plugins ?? []),
    })
  }
  // `.vx/.gitignore` keeps the machine-local `.vx/cache` out of git and the
  // workspace config and lock in; one already there is the user's.
  const dotVxIgnore = path.join(root, '.vx', '.gitignore')
  if (!(await Bun.file(dotVxIgnore).exists())) {
    files.push({ relPath: '.vx/.gitignore', abs: dotVxIgnore, contents: DOT_VX_GITIGNORE })
  }

  // A plan is a mapper's reading of the repo's own files (a project's
  // declared root, a workspace glob): one that names `../x` wrote outside it.
  // A member directory linked out of the root is spelled inside it, so the
  // real directory is asked too: core's discovery never loads a config
  // there. `.vx` is not a project: its files are refused outside the
  // root at the write (`refuseSymlink`).
  const realRoot = realpathSync(root)
  for (const f of files) {
    const rel = relPosix(root, f.abs)
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new UserError(`${f.relPath}: outside the workspace root`)
    }
    if (rel.startsWith('.vx/')) continue
    const [link, real] = linkOut(root, realRoot, path.dirname(f.abs))
    if (link !== undefined) {
      throw new UserError(
        `${f.relPath}: outside the workspace root (${relPosix(root, link)} resolves to ${real}); vx loads no project there`,
      )
    }
  }

  if (!dry && !force) {
    const conflicts = new Set<string>()
    // A discovered project with ANY existing vx config (.ts/.mjs/.js) — refuse
    // so we never shadow a hand-written config with a fresh .ts.
    for (const p of projects) {
      const meta = metas.find((m) => m.dir === p.dir)
      if (meta?.configPath) conflicts.add(relPosix(root, meta.configPath))
    }
    // ALSO stat every actual write target. A SYNTHESIZED project (a
    // workspace-root node, dir === root) has no discovered meta, so the meta
    // scan alone would miss an existing vx.config.ts at that path and clobber
    // it. This also covers the extraFiles.
    for (const f of files) {
      if ((await Bun.file(f.abs).exists()) && !isStarterConfig(f.abs)) conflicts.add(f.relPath)
    }
    if (conflicts.size > 0) {
      throw new UserError(
        'refusing to overwrite existing files (pass --force to overwrite):\n' +
          `  ${[...conflicts].join('\n  ')}`,
      )
    }
  }

  // Under --force a project's config of another extension is REPLACED:
  // beside the new one, the loader would read one of the two by its order.
  const replaced: string[] = []
  for (const p of projects) {
    const existing = metas.find((m) => m.dir === p.dir)?.configPath
    if (existing && existing !== path.join(p.dir, names.get(p.dir)!)) replaced.push(existing)
  }
  // `vx init`'s starter is mapped as no config, so no meta names it: one of
  // another extension stayed beside the root's new config, and the loader
  // read the starter, not the root's tasks.
  if (projects.some((p) => p.dir === root)) {
    const target = path.join(root, names.get(root)!)
    for (const n of PROJECT_CONFIG_FILENAMES) {
      const f = path.join(root, n)
      if (f !== target && !replaced.includes(f) && isStarterConfig(f)) replaced.push(f)
    }
  }
  if (!dry) {
    for (const f of files) refuseSymlink(f.abs, root)
    for (const f of files) await writeNoFollow(f.abs, f.contents, root)
    for (const f of replaced) await unlink(f)
    // The lock that follows loads its plugins from the file just written.
    workspaceFileWritten()
  }
  const formatted =
    dry || args.written === undefined ? [] : args.written(files.map((f) => f.relPath))

  // One reason, its tasks: the same TODO repeated per task reads as noise.
  // A file .gitignore drops is lost at the first commit, unnoticed.
  const ignored = gitIgnored(
    root,
    files.map((f) => f.relPath),
  )
  const ignoredNote = ignored.length === 0 ? [] : [ignoreAdvice(root, ignored, dry)]
  const todos = new Map<string, string[]>()
  let clean = 0
  let todo = 0
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.todos.length === 0 && t.task !== null) clean++
      if (t.todos.length > 0) todo++
      for (const reason of t.todos) {
        const ids = todos.get(reason) ?? []
        ids.push(`${p.name}#${t.name}`)
        todos.set(reason, ids)
      }
    }
  }
  const firstTask = nextTask(plan.projects.flatMap((p) => p.tasks))
  // The line is the next thing to type, so it names what that run would
  // refuse without: a git work tree (vx keys inputs on git's view) and,
  // with nothing mapped, a task to run. It names vx alone: vx owns the command.
  const run = `vx run ${firstTask} --all`
  // A run reads configs only from the lock; with no lock step here
  // that run would stop with "no lock: run `vx lock`".
  const steps = [
    ...(inGitWorkTree(root) ? [] : ['git init']),
    ...(empty ? [`declare a task as the example shows`] : []),
    ...(!dry && args.lock === undefined ? ['vx lock'] : []),
  ]
  const next = steps.length === 0 ? run : `${steps.join(', ')}, then ${run}`
  const emptyReason = empty ? args.emptyReason : undefined
  const example = empty && (args.example ?? emptyReason === undefined)
  const notes = [
    ...(args.notes ?? []),
    ...ignoredNote,
    ...formatted,
    ...plan.headerNotes,
    ...plan.notes,
  ]
  if (args.json === true) {
    return {
      json: `${JSON.stringify({
        dry,
        source,
        files: files.map((f) => ({ path: f.relPath, contents: f.contents })),
        kept,
        replaced: replaced.map((f) => relPosix(root, f)),
        todos: [...todos].map(([reason, tasks]) => ({ reason, tasks })),
        notes: [
          ...(emptyReason === undefined || example ? [] : [emptyReason]),
          ...(args.steps ?? []).map(([label, value]) => `${label}: ${value}`),
          ...notes,
        ],
        next,
      })}\n`,
    }
  }

  const lock = dry || args.lock === undefined ? undefined : lockAnswer(await args.lock(root))
  return {
    verb,
    source,
    dry,
    shown: dry ? files.map((f) => ({ relPath: f.relPath, contents: f.contents })) : [],
    steps: args.steps ?? [],
    empty: empty ? (emptyReason ?? `no tasks in ${source}`) : undefined,
    clean,
    todo,
    todos: [...todos],
    files: files.map((f) => f.relPath),
    kept: [
      ...kept.map((f) => `${f} (has a vx config)`),
      ...(empty && hasWorkspaceFile ? [workspaceName] : []),
    ],
    replaced: replaced.map((f) => relPosix(root, f)),
    ...(lock === undefined ? {} : { lock }),
    notes,
    ...(example
      ? {
          example: [
            `a ${configName} in a project directory, with your own command:`,
            exampleConfig(format).trimEnd(),
          ] as const,
        }
      : {}),
    next,
  }
}

/**
 * The lock step's answer, checked: the tool calling this seam is another
 * package and may be another version, answering another shape.
 */
function lockAnswer(answer: unknown): { code: number; said: string } {
  const a = answer as { code?: unknown; said?: unknown } | null
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof a.code === 'number' &&
    typeof a.said === 'string'
  )
    return { code: a.code, said: a.said }
  return { code: 1, said: 'vx lock: the migration tool answered no result: run `vx lock`\n' }
}
/**
 * What to do about written files .gitignore drops. A `!file` line cures a
 * file, but git re-includes nothing inside an ignored directory: an
 * old-layout `/.vx/` line (when `.vx` held only the cache) hides the
 * workspace config and lock, so that advice names the directory instead.
 */
function ignoreAdvice(root: string, ignored: readonly string[], dry: boolean): string {
  const ancestors = (f: string): string[] =>
    f
      .split('/')
      .slice(0, -1)
      .map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`)
  const dirs = new Set(gitIgnored(root, [...new Set(ignored.flatMap(ancestors))]))
  const blocking = new Set<string>()
  const names = new Set<string>()
  for (const f of ignored) {
    const dir = ancestors(f).find((d) => dirs.has(d))
    if (dir === undefined) names.add(`!${path.posix.basename(f)}`)
    else blocking.add(dir)
  }
  const cures = [
    ...(names.size === 0 ? [] : [`add ${[...names].join(' and ')} to .gitignore`]),
    ...(blocking.size === 0
      ? []
      : [
          `stop ignoring ${[...blocking].join(' and ')} (a ! line cannot re-include a file inside an ignored directory)`,
        ]),
  ]
  return `.gitignore drops ${ignored.length} file${ignored.length === 1 ? '' : 's'} this ${dry ? 'would write' : 'wrote'} (${ignored.slice(0, IGNORED_SHOWN).join(', ')}${ignored.length > IGNORED_SHOWN ? ', …' : ''}): ${cures.join(', ')}, or commit them with git add -f`
}

/** The paths (root-relative) git's ignore rules drop; none outside a work tree. */
function gitIgnored(root: string, relPaths: readonly string[]): string[] {
  return [...(checkIgnoreSync(root, relPaths) ?? [])]
}

function inGitWorkTree(root: string): boolean {
  try {
    return (
      Bun.spawnSync({
        cmd: [executablePath('git'), 'rev-parse', '--is-inside-work-tree'],
        env: gitEnv(),
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
 * neither serves nor changes anything, else the first.
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

/** Files a .gitignore drops, named in its note. */
const IGNORED_SHOWN = 5

const EXAMPLE_BODY = `export default {
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    },
  },
}`

function exampleConfig(format: MigrationFormat): string {
  return format === 'ts'
    ? `import type { ProjectConfig } from '@vzn/vx/config'\n\n${EXAMPLE_BODY} satisfies ProjectConfig\n`
    : `${EXAMPLE_BODY}\n`
}

// ─── TS emission ──────────────────────────────────────────────────────

// Type-only import + `satisfies`, like the project configs: Bun erases it,
// so the file loads with nothing installed, and a user's tsc checks it
// against config.ts alone, where `@vzn/vx` walks core's Bun-only sources.
// `vx init` writes the same file. No explanatory comment: the file is the user's.
export function renderWorkspace(
  format: MigrationFormat,
  plugins: readonly WorkspacePlugin[],
): string {
  const imports = plugins.map((p) => `import { ${p.factory} } from '${p.pkg}'\n`).join('')
  const body = `export default { plugins: [${plugins.map((p) => `${p.factory}()`).join(', ')}] }`
  return format === 'ts'
    ? `import type { WorkspaceConfig } from '@vzn/vx/config'\n${imports}\n${body} satisfies WorkspaceConfig\n`
    : `${imports}${imports === '' ? '' : '\n'}${body}\n`
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

function renderConfigFile(p: GeneratedProject, format: MigrationFormat, verb: string): string {
  // A type-only import: the editor type-checks against the installed
  // package, and Bun erases it, so the config loads in a workspace that
  // runs the vx binary without the package installed. `mjs` is the same
  // object with nothing to erase.
  // No "generated by" header: the file is the user's from here, and each
  // TODO sits on its own task.
  const lines: string[] = []
  if (format === 'ts') lines.push("import type { ProjectConfig } from '@vzn/vx/config'")
  if (p.importLines.length > 0) lines.push(...p.importLines)
  if (lines.length > 0) lines.push('')
  lines.push('export default {')
  if (p.writeName === true) lines.push(`  name: ${quoteTsLiteral(p.name)},`)
  if (p.tags !== undefined && p.tags.length > 0) lines.push(`  tags: ${renderValue(p.tags, '  ')},`)
  lines.push(p.tasks.length === 0 ? '  tasks: {},' : '  tasks: {')
  for (const t of p.tasks) {
    // A reason can quote a manifest's own text (an `env` key), and a
    // line break there ended the comment: the rest was code in the file
    // the next run evaluates. Each line stays inside the comment.
    for (const todo of t.todos) {
      const [first, ...rest] = todo.split(/\r\n|[\n\r\u2028\u2029]/)
      lines.push(`    // TODO(${verb}): ${first}`, ...rest.map((l) => `    //   ${l}`))
    }
    if (t.task === null) continue // skipped target — the TODO above explains
    // `__proto__: {…}` in a literal SETS the prototype, quoted or not, and
    // the run refuses the config; a computed key is a property.
    const key =
      t.name === '__proto__'
        ? `[${quoteTsLiteral(t.name)}]`
        : IDENT.test(t.name)
          ? t.name
          : quoteTsLiteral(t.name)
    const rendered = renderValue(t.task, '    ')
    // The suggested block sits in the task, commented: deleting `// `
    // after setting the real globs caches it, no copying from the TODO.
    const block =
      t.task['cache'] !== true
        ? t.todos.find(isCacheTodo)?.match(/^cache: add `(.+?)`/)?.[1]
        : undefined
    lines.push(
      `    ${key}: ${block === undefined ? rendered : rendered.replace('{\n', `{\n      // ${block},\n`)},`,
    )
  }
  if (p.tasks.length > 0) lines.push('  },')
  lines.push(format === 'ts' ? '} satisfies ProjectConfig' : '}', '')
  return lines.join('\n')
}

/**
 * `vx.config.mts` beside a `tsconfig.json` where tsc reads a `.ts` as
 * CommonJS (node16 / nodenext): its type-only import of the ESM
 * `@vzn/vx/config` fails there (TS1479, TS1541).
 */
function projectConfigName(
  dir: string,
  metas: readonly MigrationMember[],
  format: MigrationFormat,
): string {
  if (format !== 'ts' || !existsSync(path.join(dir, 'tsconfig.json'))) return `vx.config.${format}`
  return metas.find((m) => m.dir === dir)?.esModule === true ? 'vx.config.ts' : 'vx.config.mts'
}

/**
 * The plan takes the config back from an output as `!vx.config.<format>`;
 * where the file written is the `.mts`, the take-back names it, or a `*`
 * output covers it and `vx lock` refuses the config.
 */
function ownConfigNamed(
  p: GeneratedProject,
  name: string,
  format: MigrationFormat,
): GeneratedProject {
  const planned = `!vx.config.${format}`
  if (name === `vx.config.${format}`) return p
  return {
    ...p,
    tasks: p.tasks.map((t) => {
      const outputs = t.task?.['outputs'] as { files?: unknown } | undefined
      if (!Array.isArray(outputs?.files) || !outputs.files.includes(planned)) return t
      const files = outputs.files.map((f: unknown) => (f === planned ? `!${name}` : f))
      return { ...t, task: { ...t.task, outputs: { ...outputs, files } } }
    }),
  }
}
