// The migration seam: what any adoption tool needs once it has a plan —
// the plan's shape, TS emission, the overwrite guard, the writes and the
// report. `@vzn/vx-migrate` (package.json scripts, Turbo, Nx) and any
// other adoption tool share it, so a generated config reads the same
// whichever tool wrote it. Core knows no source format here: a mapper returns a
// `MigrationPlan` and this file does the rest.

import { existsSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { workspaceFileWritten } from '../handoff.js'
import { DOT_VX_GITIGNORE, executablePath, gitEnv, relPosix, UserError, ui } from '../util/index.js'
import { VERSION } from '../version.js'
import { WORKSPACE_CONFIG_FILENAMES } from './project-loader.js'

/** The root config `vx init` writes outside a Turbo or Nx repo: no task yet. */
export const STARTER_PROJECT =
  "import { defineProject } from '@vzn/vx'\n\nexport default defineProject({ tasks: {} })\n"

/**
 * Whether `file` is `vx init`'s starter, untouched: a migration maps over it
 * as over no config, so the scripts `vx init` pointed at become tasks.
 */
export function isStarterConfig(file: string): boolean {
  try {
    return readFileSync(file, 'utf8') === STARTER_PROJECT
  } catch {
    return false
  }
}

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
 * A package.json script with the `pre<name>` / `post<name>` hooks npm runs
 * around it, as ONE sh command. Each part runs in its own subshell, so a
 * `;` or an `exit` in one ends that part alone, and the chain stops at the
 * first that fails, as npm stops. The parts sit in a function the
 * forwarded `--` args are appended to, and only the body takes them, as
 * npm appends them to the script and never to its hooks. A plain ` && `
 * join handed them to the post hook, and `test -f x && echo A; echo B` ran
 * `echo B` after a failed pre hook and went green (item 905). npm appends
 * them as TEXT: no part sees them as `$1`…, so the function quotes them
 * into `vx_a`, clears its positional parameters, and evals the body with
 * `vx_a` after it; `"$@"` on the body made a script's `$1` the first
 * forwarded arg and its `$*` print them twice. Each part ends on its own
 * line, so a trailing `# comment` cannot swallow the paren. A script with
 * no hooks is its body, verbatim.
 */
export function foldScriptHooks(
  pre: string | undefined,
  body: string,
  post: string | undefined,
): string {
  if (pre === undefined && post === undefined) return body
  const quoted = `'${body.replaceAll("'", `'\\''`)}'`
  const parts = [
    ...(pre === undefined ? [] : [`(${pre}\n)`]),
    `(eval ${quoted}"$vx_a"\n)`,
    ...(post === undefined ? [] : [`(${post}\n)`]),
  ]
  return `vx_script() {\n${QUOTE_ARGS}\nset --\n${parts.join(' && ')}\n}\nvx_script`
}

/** Each argument single-quoted into `vx_a`, in sh alone (no spawn per arg). */
const QUOTE_ARGS =
  `vx_q="'" vx_a=\n` +
  `for vx_s in "$@"; do vx_r=; while :; do case $vx_s in *"$vx_q"*) ` +
  `vx_r="$vx_r\${vx_s%%"$vx_q"*}'\\''"; vx_s=\${vx_s#*"$vx_q"};; *) break;; esac; done; ` +
  `vx_a="$vx_a '$vx_r$vx_s'"; done`

const isCacheTodo = (todo: string): boolean => todo.startsWith('cache: add `inputs: {')

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
  /** The project's `tags` (an Nx project's); none written when empty. */
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
  /** trailing report lines (e.g. what a turbo.json holds that vx has no place for) */
  notes: string[]
}

/**
 * A project the adoption tool found: its name, directory and the vx config
 * it already has. `packageJson.type` picks `vx.config.mts` for a CommonJS
 * TypeScript package.
 */
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
  /** Named in the report and the generated header, e.g. `turbo.json`. */
  source: string
  /** The command the user typed, e.g. `vx init` — named in the report. */
  verb: string
  dry: boolean
  force: boolean
  /**
   * A scripts migration (what `vx init` hands over) on a workspace with no
   * scripts still has a job (the workspace file, and a worked example); a
   * migration with nothing to convert is an error. Default false.
   */
  init?: boolean
  /** The report's `note` lines (e.g. "turbo.json found and not read"). */
  notes?: readonly string[]
  /**
   * Scripts exist but no project can carry them (a member without a
   * `name`): the empty report said "no package.json scripts" of a repo full
   * of them (M-59).
   */
  unmapped?: boolean
  /**
   * Why an `init` plan is empty, when the tool knows (members its globs
   * never reach): the report's one line in place of the example config.
   */
  emptyReason?: string
  /**
   * `ts` (default) writes `vx.config.ts` with the type-only import and
   * `satisfies`; `mjs` writes `vx.config.mjs` — the same object, untyped —
   * for a package whose own `tsc --build` includes every `.ts` under it
   * and compiled the config into its dist (TanStack/query, 2026-09-11).
   */
  format?: MigrationFormat
  /**
   * With `dry`: one JSON document on stdout (`schemas/init.json`) in place
   * of the files and the report, so an agent reads the plan as data.
   */
  json?: boolean
  /**
   * Run after the files are written (not under `dry`): `vx lock`'s step, so
   * the migrated workspace has its .vx/projects.lock.json and its graph rules checked
   * (2026-10-14). On success `said` is its line, shown as the
   * report's `lock` row; a refusal (a graph rule, a plugin not installed
   * yet) prints above the report and the migration still succeeds: its
   * files are written, and `vx lock` is the step to re-run.
   */
  lock?: (root: string) => Promise<{ code: number; said: string }>
  /** Rows of what the tool did before the write, e.g. `['ran', 'bun add -d …']`. */
  steps?: readonly (readonly [label: string, value: string])[]
  /** What the written workspace file declares, e.g. `pnpm()` from `@vzn/vx-lockfile`. */
  plugins?: readonly WorkspacePlugin[]
}

export interface WorkspacePlugin {
  readonly pkg: string
  readonly factory: string
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
  const workspaceName = `.vx/workspace.${format}`
  const empty = plan.projects.length === 0
  // An `init` migration never overwrites a member's config: a half-adopted workspace
  // keeps each one it has, by name, and gets the rest (M-52). It refused
  // the whole workspace, and `--force` would have replaced the hand-written
  // file; `--force` still replaces, as asked.
  const kept: string[] = []
  // Every project gets a config, a task-less one too (2026-10-14:
  // "no skips. every project gets a config"): solidjs/solid's solid-ssr,
  // with no script Turbo runs, was left with none and read as a project
  // whose tasks are not locked.
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
  // A plan never maps a workspace root that has a config (D-45), even
  // under `--force`; its file stays, so it is named with the rest (X-27).
  const rootConfig = metas.find((m) => m.dir === root)?.configPath
  // A one-package repo's root is a mapped member too: the filter kept it already.
  if (
    init &&
    rootConfig &&
    !kept.includes(relPosix(root, rootConfig)) &&
    !projects.some((p) => p.dir === root && p.tasks.length > 0)
  ) {
    kept.push(relPosix(root, rootConfig))
  }
  if (empty && !init) {
    throw new UserError(
      `nothing to migrate: no ${source === 'package.json scripts' ? 'package.json scripts in any workspace member' : 'tasks in ' + source}`,
    )
  }

  const names = new Map(projects.map((p) => [p.dir, projectConfigName(p.dir, metas, format)]))
  const files: { relPath: string; abs: string; contents: string }[] = []
  for (const p of projects) {
    const abs = path.join(p.dir, names.get(p.dir)!)
    files.push({
      relPath: relPosix(root, abs),
      abs,
      contents: renderConfigFile(ownConfigNamed(p, names.get(p.dir)!, format), format),
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
  // A plan may bring its own (vx-migrate declares the plugins it detects).
  if (!hasWorkspaceFile && !plan.extraFiles.some((f) => f.relPath === workspaceName)) {
    const abs = path.join(root, workspaceName)
    files.push({
      relPath: relPosix(root, abs),
      abs,
      contents: workspaceFile(format, args.plugins ?? []),
    })
  }
  // `.vx/.gitignore` keeps the machine-local `.vx/cache` out of git and the
  // workspace config and lock in; one already there is the user's.
  const dotVxIgnore = path.join(root, '.vx', '.gitignore')
  if (!(await Bun.file(dotVxIgnore).exists())) {
    files.push({ relPath: '.vx/.gitignore', abs: dotVxIgnore, contents: DOT_VX_GITIGNORE })
  }

  // A plan is a mapper's reading of the repo's own files (an Nx node's
  // `root`, a workspace glob): one that names `../x` wrote outside it.
  for (const f of files) {
    const rel = relPosix(root, f.abs)
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new UserError(`${f.relPath}: outside the workspace root`)
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
    // ALSO stat every actual write target. A SYNTHESIZED project (e.g. the Nx
    // workspace-root node, dir === root) has no discovered meta, so the meta
    // scan alone would miss an existing vx.config.ts at that path and clobber
    // it. This also covers the extraFiles (vx-preset.ts).
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

  // Under --force a project's config of another extension is REPLACED: the
  // new one was written beside it, the loader read one of the two by its
  // order, and the report said "written" for a file the run never loaded
  // (item 1033).
  const replaced: string[] = []
  for (const p of projects) {
    const existing = metas.find((m) => m.dir === p.dir)?.configPath
    if (existing && existing !== path.join(p.dir, names.get(p.dir)!)) replaced.push(existing)
  }
  if (dry && args.json !== true) {
    for (const f of files) {
      ui.print('out', ui.excerpt(f.relPath, f.contents))
    }
  } else if (!dry) {
    for (const f of files) await Bun.write(f.abs, f.contents)
    for (const f of replaced) await unlink(f)
    // The lock that follows loads its plugins from the file just written.
    workspaceFileWritten()
  }
  const formatted = dry
    ? []
    : formatWritten(
        root,
        // A formatter has no parser for `.vx/.gitignore`.
        files.map((f) => f.relPath).filter((f) => /\.[cm]?[jt]s$/.test(f)),
      )

  // One reason, its tasks: on a Turbo template the same two-line cache TODO
  // printed five times and the persistent one eight (the first-five-minutes
  // walk, 2026-09-28), and the list read as noise.
  // A file .gitignore drops is lost at the first commit, unnoticed: vueuse
  // ignores `packages/**/*.mjs`, so `--mjs` wrote configs git never saw.
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
  // with no scripts mapped, a task to run.
  // `vx init` installs vx globally first: the line names vx alone, never
  // a package manager's runner (2026-10-22: vx owns the command).
  const run = `vx run ${firstTask} --all`
  // A run reads configs only from the lock; with no lock step here
  // (`--no-install`), that run stopped with "no lock: run `vx lock`".
  const steps = [
    ...(inGitWorkTree(root) ? [] : ['git init']),
    ...(empty ? [`declare a task as the example shows`] : []),
    ...(!dry && args.lock === undefined ? ['vx lock'] : []),
  ]
  const next = steps.length === 0 ? run : `${steps.join(', ')}, then ${run}`
  const emptyReason = empty ? args.emptyReason : undefined
  const notes = [
    ...(args.notes ?? []),
    ...ignoredNote,
    ...formatted,
    ...plan.headerNotes,
    ...plan.notes,
  ]
  if (args.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        dry,
        source,
        files: files.map((f) => ({ path: f.relPath, contents: f.contents })),
        kept,
        replaced: replaced.map((f) => relPosix(root, f)),
        todos: [...todos].map(([reason, tasks]) => ({ reason, tasks })),
        notes: [
          ...(emptyReason === undefined ? [] : [emptyReason]),
          ...(args.steps ?? []).map(([label, value]) => `${label}: ${value}`),
          ...notes,
        ],
        next,
      })}\n`,
    )
    return 0
  }

  // The lock's own words become a row; a refusal prints above the report.
  const lock = dry || args.lock === undefined ? undefined : lockAnswer(await args.lock(root))
  if (lock !== undefined && lock.code !== 0) process.stderr.write(lock.said)

  const rows: ui.FieldRow[] = [['from', source]]
  if (dry) rows.push(['dry run', 'nothing written'])
  for (const [label, value] of args.steps ?? []) rows.push([label, value])
  if (empty) {
    const why =
      emptyReason ??
      (args.unmapped === true
        ? 'no package.json script became a task'
        : 'no package.json scripts to turn into tasks')
    rows.push(['tasks', [ui.dim('none'), `: ${why}`]])
  } else {
    const parts = [
      ...(clean > 0 ? [ui.tone('ok', `${clean} clean`)] : []),
      ...(todo > 0 ? [ui.tone('warn', `${todo} todo`)] : []),
    ]
    if (parts.length > 0)
      rows.push(['tasks', parts.flatMap((p, i) => (i === 0 ? [p] : [ui.dim(' · '), p]))])
    const todoLines: string[] = []
    for (const [reason, ids] of todos) {
      if (ids.length === 1) todoLines.push(`${ids[0]}: ${reason}`)
      else {
        const shown = ids.slice(0, TODO_IDS_SHOWN).join(', ')
        const more = ids.length - TODO_IDS_SHOWN
        todoLines.push(`${shown}${more > 0 ? ` and ${more} more` : ''}:`, `  ${reason}`)
      }
    }
    if (todoLines.length > 0) rows.push(['todo', ...todoLines])
  }
  if (files.length > 0) rows.push(['files', ...fileLines(files.map((f) => f.relPath))])
  const keptLines = [
    ...kept.map((f) => `${f} (has a vx config)`),
    ...(empty && hasWorkspaceFile ? [workspaceName] : []),
  ]
  if (keptLines.length > 0) rows.push(['kept', ...keptLines])
  if (replaced.length > 0) rows.push(['replaced', ...replaced.map((f) => relPosix(root, f))])
  if (lock !== undefined) {
    rows.push([
      'lock',
      lock.code === 0
        ? lock.said.trim().replace(/^✓ vx lock\s+/, '')
        : ui.tone('error', 'not written'),
    ])
  }
  if (notes.length > 0) rows.push(['note', ...notes])
  if (empty && emptyReason === undefined) {
    rows.push([
      'example',
      `a ${configName} beside a package.json, with your own command:`,
      '',
      exampleConfig(format).trimEnd(),
    ])
  }
  const said =
    lock === undefined || lock.code === 0 ? next : `fix the above, then vx lock and ${next}`
  rows.push(null, ['next', said])
  ui.print('out', ui.report(`${verb} ${VERSION}`, rows))
  return 0
}

/**
 * The lock step's answer, checked: the tool calling this seam is another
 * package and may be another version (vx-migrate 0.0.637's answered its
 * exit code, which crashed the report).
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
  return `.gitignore drops ${ignored.length} file${ignored.length === 1 ? '' : 's'} this ${dry ? 'would write' : 'wrote'} (${ignored.slice(0, TODO_IDS_SHOWN).join(', ')}${ignored.length > TODO_IDS_SHOWN ? ', …' : ''}): ${cures.join(', ')}, or commit them with git add -f`
}

/** The paths (root-relative) git's ignore rules drop; none outside a work tree. */
function gitIgnored(root: string, relPaths: readonly string[]): string[] {
  if (relPaths.length === 0) return []
  try {
    const r = Bun.spawnSync({
      cmd: [executablePath('git'), 'check-ignore', '--stdin', '-z'],
      env: gitEnv(),
      cwd: root,
      stdin: Buffer.from(relPaths.map((p) => `${p}\0`).join('')),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    // 0: some ignored; 1: none; anything else (no work tree): nothing to say.
    if (r.exitCode !== 0) return []
    return r.stdout
      .toString()
      .split('\0')
      .filter((p) => p !== '')
  } catch {
    return []
  }
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

/** Files named one per line; past this, the root's and a count (TanStack form: 97). */
const FILES_SHOWN = 10

function fileLines(paths: readonly string[]): string[] {
  if (paths.length <= FILES_SHOWN) return [...paths]
  const root = paths.filter((p) => !p.includes('/') || p.startsWith('.vx/'))
  return [...root, `and ${paths.length - root.length} more in package directories`]
}

/** Ids named per shared TODO; the files carry each one (sveltejs/kit: 92 persistent tasks). */
const TODO_IDS_SHOWN = 5

const EXAMPLE_BODY = `export default {
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
// No explanatory comment: the file is the user's (2026-10-06).
function workspaceFile(format: MigrationFormat, plugins: readonly WorkspacePlugin[]): string {
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

function renderConfigFile(p: GeneratedProject, format: MigrationFormat): string {
  // A type-only import: the editor type-checks against the installed
  // package, and Bun erases it, so the config loads in a workspace that
  // runs the vx binary without the package installed. `mjs` is the same
  // object with nothing to erase.
  // No "generated by" header: the file is the user's from here
  // (2026-10-06), and each TODO(vx-migrate) sits on its own task.
  const lines: string[] = []
  if (format === 'ts') lines.push("import type { ProjectConfig } from '@vzn/vx/config'")
  if (p.importLines.length > 0) lines.push(...p.importLines)
  if (lines.length > 0) lines.push('')
  lines.push('export default {')
  if (p.writeName === true) lines.push(`  name: ${quoteTsLiteral(p.name)},`)
  if (p.tags !== undefined && p.tags.length > 0) lines.push(`  tags: ${renderValue(p.tags, '  ')},`)
  lines.push(p.tasks.length === 0 ? '  tasks: {},' : '  tasks: {')
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
    const rendered = renderValue(t.task, '    ')
    // The suggested block sits in the task, commented: deleting `// `
    // after setting the real globs caches it, no copying from the TODO.
    const block =
      t.task['cache'] === undefined
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
 * `vx.config.mts` in a TypeScript package that is CommonJS: tsc (node16 /
 * nodenext) reads a `.ts` there as CommonJS, and its type-only import of
 * the ESM `@vzn/vx/config` fails (TS1479, TS1541: medusa's plugin builds).
 */
function projectConfigName(
  dir: string,
  metas: readonly MigrationMember[],
  format: MigrationFormat,
): string {
  if (format !== 'ts' || !existsSync(path.join(dir, 'tsconfig.json'))) return `vx.config.${format}`
  const meta = metas.find((m) => m.dir === dir)
  const manifest = (meta?.packageJson as { type?: unknown } | undefined) ?? readManifest(dir)
  return manifest?.type === 'module' ? 'vx.config.ts' : 'vx.config.mts'
}

/**
 * The plan takes the config back from an output as `!vx.config.<format>`;
 * where the file written is the `.mts`, the take-back names it, or a `*`
 * output covers it and `vx lock` refuses the config (medusa, 80 of 84).
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
      const outputs = (t.task?.['cache'] as { outputs?: { files?: unknown } } | undefined)?.outputs
      if (!Array.isArray(outputs?.files) || !outputs.files.includes(planned)) return t
      const cache = t.task!['cache'] as Record<string, unknown>
      const files = outputs.files.map((f: unknown) => (f === planned ? `!${name}` : f))
      return { ...t, task: { ...t.task, cache: { ...cache, outputs: { ...outputs, files } } } }
    }),
  }
}

function readManifest(dir: string): { type?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { type?: unknown }
  } catch {
    return undefined
  }
}

/** The formatters a repo installs at its root, each with its write command. */
const FORMATTERS: readonly (readonly [string, readonly string[]])[] = [
  ['prettier', ['--write']],
  ['biome', ['format', '--write']],
  ['oxfmt', []],
  ['dprint', ['fmt']],
]

/**
 * Runs the repo's own formatter over the files just written, as Nx's
 * generators do: create-t3-turbo's `prettier --check` failed on the quotes
 * of a config vx wrote. Returns the report's note.
 */
function formatWritten(root: string, relPaths: readonly string[]): string[] {
  if (relPaths.length === 0) return []
  for (const [name, args] of FORMATTERS) {
    const bin = path.join(root, 'node_modules', '.bin', name)
    if (!existsSync(bin)) continue
    const r = Bun.spawnSync({
      cmd: [bin, ...args, ...relPaths],
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    if (r.exitCode === 0) {
      return [`formatted ${relPaths.length} file${relPaths.length === 1 ? '' : 's'} with ${name}`]
    }
    const why = (r.stderr.toString() || r.stdout.toString()).trim().split('\n')[0] ?? ''
    return [`${name} did not format the written files (exit ${r.exitCode ?? 'signal'}): ${why}`]
  }
  return []
}
