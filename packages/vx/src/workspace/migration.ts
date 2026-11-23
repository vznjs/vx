// The migration seam: what any adoption tool needs once it has a plan (shape,
// TS emission, the overwrite guard, writes, report), so a generated config
// reads the same whoever wrote it. Core knows no source format: a mapper
// returns a `MigrationPlan` and this does the rest.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
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
 * Whether `file` is `vx init`'s starter, untouched: a project config with no
 * task or a `.vx/workspace` file with no plugin. A migration maps over it as
 * over no file, so the scripts `vx init` pointed at become tasks and the
 * workspace file declares the lockfile plugin their `^build` needs. A CRLF
 * checkout (`eol=crlf`, `core.autocrlf`) of one is the same starter.
 */
export function isStarterConfig(file: string): boolean {
  try {
    // By extension: the mjs starter's text in a.ts file is a user's config.
    const format = file.endsWith('.ts') ? 'ts' : 'mjs'
    let starter = starterProject(format)
    if (
      path.basename(path.dirname(file)) === '.vx' &&
      path.basename(file).startsWith('workspace.')
    ) {
      // vx init writes only these two names.
      if (!file.endsWith('.ts') && !file.endsWith('.mjs')) return false
      starter = renderWorkspace(format, [])
    }
    return readFileSync(file, 'utf8').replaceAll('\r\n', '\n') === starter
  } catch {
    return false
  }
}

/** A C0 or C1 control, or DEL. */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/**
 * A string as a single-quoted TS literal, escaping backslash, quote and raw
 * newlines/CR, so values with newlines or quotes round-trip through the loader.
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

// The readiness note on a persistent task is moot when nothing depends on it.
// Every mapper runs this last, over the whole mapping, since a dependent may be
// in another project.

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
   * Whether tsc reads a `.ts` in `dir` as ESM. Where a `tsconfig.json` sits
   * beside it and not, the config is written as `vx.config.mts`.
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
   * A migration `vx init` hands over still has work on an empty workspace (the
   * workspace file, an example); any other migration with nothing to convert is
   * an error. Default false.
   */
  init?: boolean
  /** The report's `note` lines (e.g. "turbo.json found and not read"). */
  notes?: readonly string[]
  /**
   * Why the plan is empty: the `tasks` row of an `init` report, or another
   * migration's refusal. Default `no tasks in <source>`.
   */
  emptyReason?: string
  /** An empty `init` plan's report shows a worked example config. Default: when `emptyReason` is unset. */
  example?: boolean
  /**
   * Run after the files are written (not under `dry`), with their paths: a
   * tool's own step, such as the repo's formatter. Its lines join the notes.
   */
  written?: (relPaths: readonly string[]) => readonly string[]
  /**
   * `ts` (default) writes `vx.config.ts` typed with `satisfies`; `mjs` the same
   * object untyped, for a project whose `tsc --build` would compile the config
   * into its output.
   */
  format?: MigrationFormat
  /**
   * With `dry`: one JSON document on stdout (`schemas/init.json`) in place
   * of the files and the report, so an agent reads the plan as data.
   */
  json?: boolean
  /**
   * Run after the files are written (not under `dry`): `vx lock`, so the
   * workspace gets its lock and graph checks. Success is the report's `lock`
   * row; a refusal prints above, the files stay, and the exit is 1: a run reads
   * only the lock, so the migration is not done.
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

type TscJudge = {
  /** The tsconfigs in the config's directory that compile it, workspace-relative. */
  readonly configs: readonly string[]
  readonly how: 'all' | 'include'
  /** The first one's `rootDir`, when the config lies outside it. */
  readonly outsideRoot: string | undefined
}

/**
 * Which `tsconfig*.json` beside a written config would compile it: one with
 * no `include` or `files` takes every `.ts` beside it, so an emitting
 * build's output moves (`dist/main.js` becomes `dist/src/main.js`, and a
 * NestJS app no longer starts) or, under `rootDir`, stops with TS6059. An
 * `include` that reaches it (cal.com's `["."]`) takes it too, and emits it
 * beside the build. Not only `tsconfig.json`: an Nx library's is a solution
 * file (`"files": []`), and its `tsconfig.lib.json`, which `ngc -p` builds
 * with `isolatedDeclarations`, stopped on the config (analog, TS9037).
 * Compiler options follow `extends`; `include`, `exclude` and `files` only
 * within the directory, since a base elsewhere resolves them from there.
 */
function tscTakers(root: string, abs: string): TscJudge | undefined {
  const name = path.basename(abs)
  if (!/\.[mc]?ts$/.test(name)) return undefined
  const dir = path.dirname(abs)
  const read = (file: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = Bun.JSONC.parse(readFileSync(file, 'utf8'))
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  // tsc reads an entry with no wildcard and no extension as a directory.
  const reaches = (entry: unknown): boolean => {
    if (typeof entry !== 'string') return false
    const e = entry.replace(/^\.\//, '').replace(/\/$/, '')
    const glob =
      e === '' || e === '.' ? '**/*' : /[*?]/.test(e) || path.extname(e) !== '' ? e : `${e}/**/*`
    return new Bun.Glob(glob).match(name)
  }
  const judge = (
    file: string,
  ): { how: 'all' | 'include'; outsideRoot: string | undefined } | undefined => {
    const options: Record<string, unknown> = {}
    const lists: Record<string, unknown> = {}
    let foreign = false
    const seen = new Set<string>()
    for (let at: string | undefined = file; at !== undefined && !seen.has(at);) {
      seen.add(at)
      const c = read(at)
      if (c === undefined) {
        if (at === file) return undefined
        break
      }
      for (const [k, v] of Object.entries((c['compilerOptions'] ?? {}) as Record<string, unknown>))
        if (!(k in options)) options[k] = v
      for (const k of ['include', 'exclude', 'files'])
        if (!(k in lists) && c[k] !== undefined) {
          lists[k] = c[k]
          if (path.dirname(at) !== dir) foreign = true
        }
      const ext = c['extends']
      at =
        typeof ext === 'string' && (ext.startsWith('.') || path.isAbsolute(ext))
          ? path.resolve(path.dirname(at), ext.endsWith('.json') ? ext : `${ext}.json`)
          : undefined
    }
    if (foreign) return undefined
    // A `rootDir` the config lies outside stops tsc even with `noEmit`:
    // vercel/ai's 80 packages set `rootDir: "src"`, and every
    // `tsc --noEmit` type-check failed on the written config.
    const rootDir = options['rootDir']
    const outsideRoot =
      typeof rootDir === 'string' &&
      !(
        path.resolve(dir, rootDir) === dir ||
        dir.startsWith(`${path.resolve(dir, rootDir)}${path.sep}`)
      )
    const emits =
      options['noEmit'] !== true &&
      (typeof options['outDir'] === 'string' || typeof rootDir === 'string')
    if (!emits && !outsideRoot) return undefined
    const exclude = lists['exclude']
    if (Array.isArray(exclude) && exclude.some((e) => e === name || e === `./${name}`))
      return undefined
    const include = lists['include']
    const how =
      include === undefined
        ? lists['files'] === undefined
          ? 'all'
          : undefined
        : Array.isArray(include) && include.some(reaches)
          ? 'include'
          : undefined
    return how === undefined
      ? undefined
      : { how, outsideRoot: outsideRoot ? (rootDir as string) : undefined }
  }
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => /^tsconfig.*\.json$/.test(n))
  } catch {
    return undefined
  }
  const first = ['tsconfig.json', 'tsconfig.build.json']
  names.sort((x, y) => {
    const [i, j] = [first.indexOf(x), first.indexOf(y)]
    return (i < 0 ? first.length : i) - (j < 0 ? first.length : j) || (x < y ? -1 : x > y ? 1 : 0)
  })
  // A base the directory's other tsconfigs extend, each naming its own
  // files, is what an editor reads, not what a build compiles: an Angular
  // app's tsconfig.json under tsconfig.app.json and tsconfig.spec.json
  // (TanStack/store, TanStack/form: ten false notes).
  const extenders = (n: string): Record<string, unknown>[] =>
    names.flatMap((m) => {
      const c = m === n ? undefined : read(path.join(dir, m))
      const ext = c?.['extends']
      if (typeof ext !== 'string' || !ext.startsWith('.')) return []
      const to = path.resolve(dir, ext.endsWith('.json') ? ext : `${ext}.json`)
      return to === path.join(dir, n) ? [c!] : []
    })
  const base = (n: string): boolean => {
    const ext = extenders(n)
    return (
      ext.length > 0 && ext.every((c) => c['files'] !== undefined || c['include'] !== undefined)
    )
  }
  const takers = names.flatMap((n) => {
    const v = judge(path.join(dir, n))
    return v === undefined || (v.how === 'all' && v.outsideRoot === undefined && base(n))
      ? []
      : [{ file: n, ...v }]
  })
  const lead = takers[0]
  if (lead === undefined) return undefined
  return {
    configs: takers.map((t) => relPosix(root, path.join(dir, t.file))),
    how: lead.how,
    outsideRoot: lead.outsideRoot,
  }
}

/** The note for each directory whose `tsc` would compile the config written there (`tscTakers`). */
export function tscCompilesConfigNotes(root: string, written: readonly string[]): string[] {
  const notes: string[] = []
  for (const abs of written) {
    const t = tscTakers(root, abs)
    if (t === undefined) continue
    const name = path.basename(abs)
    const where = t.configs.join(' and ')
    const one = t.configs.length === 1
    notes.push(
      t.outsideRoot !== undefined
        ? (t.how === 'all'
            ? `${where} ${one ? 'names' : 'name'} no "include", so tsc compiles `
            : `${where}'s "include" takes `) +
            `${relPosix(root, abs)}, outside its "rootDir" ${JSON.stringify(t.outsideRoot)}, and stops ` +
            `(TS6059): add "${name}" to "exclude" there`
        : t.how === 'all'
          ? `${where} ${one ? 'names' : 'name'} no "include", so tsc compiles ` +
            `${relPosix(root, abs)} too and its output moves (dist/main.js becomes dist/src/main.js): ` +
            `add "${name}" to "exclude" there`
          : `${where}'s "include" takes ${relPosix(root, abs)}, so tsc compiles it into the ` +
            `build's output: add "${name}" to "exclude" there`,
    )
  }
  return notes
}

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
 * Render a plan, refuse to overwrite without `force`, write (not under `dry`)
 * and lock. Returns what `report` draws, or under `json` the dry run's
 * document.
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
  // An `init` migration never overwrites a member's config; `--force` still
  // replaces.
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
  // A migrated workspace must declare its executor and cache. Emit the
  // workspace file unless one exists in any extension: a `.ts` beside a
  // hand-written `.mts` would win by load order.
  const hasWorkspaceFile = (
    await Promise.all(
      WORKSPACE_CONFIG_FILENAMES.map(async (n) => {
        const f = path.join(root, n)
        return (await Bun.file(f).exists()) && !isStarterConfig(f)
      }),
    )
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

  // A plan is a mapper's reading of the repo (a declared root, a member glob):
  // one naming `../x` wrote outside it. A member linked out of the root is
  // checked by its real dir too: core never loads a config there. `.vx` outside
  // the root is refused at the write (`refuseSymlink`).
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
    // so we never shadow a hand-written config with a fresh.ts.
    for (const p of projects) {
      const meta = metas.find((m) => m.dir === p.dir)
      if (meta?.configPath) conflicts.add(relPosix(root, meta.configPath))
    }
    // Also stat every write target: a synthesized project (dir === root) has no
    // meta, so the meta scan would clobber an existing config there. Covers
    // extraFiles too.
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
  // `vx init`'s starter is mapped as no config: one of another extension stayed
  // beside the new config and the loader read it instead.
  if (projects.some((p) => p.dir === root)) {
    const target = path.join(root, names.get(root)!)
    for (const n of PROJECT_CONFIG_FILENAMES) {
      const f = path.join(root, n)
      if (f !== target && !replaced.includes(f) && isStarterConfig(f)) replaced.push(f)
    }
  }
  const workspaceTarget = path.join(root, workspaceName)
  if (files.some((f) => f.abs === workspaceTarget)) {
    for (const n of WORKSPACE_CONFIG_FILENAMES) {
      const f = path.join(root, n)
      if (f !== workspaceTarget && isStarterConfig(f)) replaced.push(f)
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
  const formatIgnored = dry ? [] : [...formatterIgnore(root), ...biomeNote(root)]

  // One reason, its tasks: the same TODO repeated per task reads as noise. A
  // file.gitignore drops is lost at the first commit, unnoticed.
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
  // The line is the next thing to type, naming what that run would refuse
  // without: a git work tree and, with nothing mapped, a task.
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
  const excluded = dry
    ? []
    : excludeFromTsc(
        root,
        files.map((f) => f.abs),
      )
  const notes = [
    ...(args.notes ?? []),
    ...excluded,
    ...tscCompilesConfigNotes(
      root,
      files.map((f) => f.abs),
    ),
    ...ignoredNote,
    ...formatted,
    ...formatIgnored,
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
 * Adds a written config to the `exclude` its package's tsconfig already
 * lists, where tsc would compile it: tldraw's editor (`rootDir: src`, no
 * `include`) stopped at TS6059 on the first `vx run`. A tsconfig with no
 * `exclude` keeps tsc's default one, which a new list would replace: there
 * the note says what to add. Returns what it changed.
 */
function excludeFromTsc(root: string, written: readonly string[]): string[] {
  const changed: string[] = []
  for (const abs of written) {
    const name = path.basename(abs)
    for (const rel of tscTakers(root, abs)?.configs ?? []) {
      const file = path.join(root, rel)
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) continue
      const text = readFileSync(file, 'utf8')
      const next = withExcluded(text, name)
      if (next === undefined) continue
      writeFileSync(file, next)
      changed.push(relPosix(root, file))
    }
  }
  return changed.length === 0
    ? []
    : [`added the config to "exclude" in ${changed.join(', ')}, so tsc does not compile it`]
}

/** `text` with `name` first in its one `"exclude"` array; undefined where that is not certain. */
function withExcluded(text: string, name: string): string | undefined {
  const at = [...text.matchAll(/"exclude"\s*:\s*\[/g)]
  if (at.length !== 1) return undefined
  const open = at[0]!.index + at[0]![0].length
  const indent = /^\r?\n([ \t]*)\S/.exec(text.slice(open))
  const rest = text.slice(open).trimStart()
  const entry = JSON.stringify(name)
  const insert =
    indent !== null ? `\n${indent[1]}${entry},` : rest.startsWith(']') ? entry : `${entry}, `
  const next = text.slice(0, open) + insert + text.slice(open)
  try {
    const parsed = Bun.JSONC.parse(next) as { exclude?: unknown }
    const before = Bun.JSONC.parse(text) as { exclude?: unknown }
    if (!Array.isArray(before.exclude) || before.exclude.includes(name)) return undefined
    return Array.isArray(parsed.exclude) && parsed.exclude[0] === name ? next : undefined
  } catch {
    return undefined
  }
}

/** What `vx lock` and a run write, which no formatter should check. */
const FORMATTER_IGNORED = [
  '.vx/cache',
  '.vx/tmp',
  '.vx/projects.lock',
  '.vx/dependencies.lock',
  'vx.lock.json',
]

/**
 * prettier and oxfmt read the root `.gitignore` and `.prettierignore` alone:
 * `prettier --check .` failed on every lock and on `.vx/cache`, which only
 * `.vx/.gitignore` drops (vuejs/core). Adds the missing lines, as `nx init`
 * adds its cache; returns the note.
 */
function formatterIgnore(root: string): string[] {
  const file = path.join(root, '.prettierignore')
  const had = existsSync(file)
  // Declared at the root, not merely hoisted: documenso's biome repo got a
  // .prettierignore because a dependency's prettier sat in node_modules/.bin.
  const declared = rootDeclared(root)
  const bins = ['prettier', 'oxfmt'].some(
    (n) => declared.has(n) && existsSync(path.join(root, 'node_modules', '.bin', n)),
  )
  if (!had && !bins) return []
  // One linked elsewhere is not the workspace's to write.
  if (had && lstatSync(file).isSymbolicLink()) return []
  const text = had ? readFileSync(file, 'utf8') : ''
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()))
  const missing = FORMATTER_IGNORED.filter((l) => !present.has(l))
  if (missing.length === 0) return []
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  writeFileSync(
    file,
    `${text}${sep}${text === '' ? '' : '\n'}# vx: what vx lock and runs write\n${missing.join('\n')}\n`,
  )
  return [
    `${had ? 'added' : 'wrote'} .prettierignore lines for vx's locks and cache, which prettier and oxfmt would check`,
  ]
}

/** What the root package.json lists in its dependencies and devDependencies. */
function rootDeclared(root: string): Set<string> {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
    ) as Record<string, unknown> | null
    return new Set(
      ['dependencies', 'devDependencies'].flatMap((f) => {
        const deps = pkg?.[f]
        return deps !== null && typeof deps === 'object' ? Object.keys(deps) : []
      }),
    )
  } catch {
    return new Set()
  }
}

/**
 * biome reads no `.prettierignore`, and `biome check` failed on every lock
 * (prisma). Its config is the user's JSONC, maybe one per package, so the
 * lines are named, not written.
 */
function biomeNote(root: string): string[] {
  const config = ['biome.json', 'biome.jsonc'].find((n) => existsSync(path.join(root, n)))
  if (config === undefined) return []
  if (readFileSync(path.join(root, config), 'utf8').includes('vx.lock.json')) return []
  return [
    `biome checks vx's locks: add "!**/vx.lock.json", "!**/.vx/*.lock.json" to files.includes in ${config} (files.ignore before biome 2), and in any package's own biome config that sets its files`,
  ]
}

/**
 * What to do about written files `.gitignore` drops. A `!file` line cures a
 * file, but git re-includes nothing inside an ignored directory: an old `/.vx/`
 * line hides config and lock, so that advice names the directory.
 */
function ignoreAdvice(root: string, ignored: readonly string[], dry: boolean): string {
  const ancestors = (f: string): string[] =>
    f
      .split('/')
      .slice(0, -1)
      .map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`)
  const dirs = new Set(checkIgnoreSync(root, [...new Set(ignored.flatMap(ancestors))], true))
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

/** Files a.gitignore drops, named in its note. */
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

// Type-only import plus `satisfies`: Bun erases it, so the file loads with
// nothing installed, and tsc checks it against config.ts alone. `vx init`
// writes the same. No explanatory comment: the file is the user's.
export function renderWorkspace(
  format: MigrationFormat,
  plugins: readonly WorkspacePlugin[],
): string {
  // Sorted by package, as biome's organizeImports wants; the plugins keep their order.
  const imports = [...plugins]
    .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0))
    .map((p) => `import { ${p.factory} } from '${p.pkg}'\n`)
    .join('')
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
  // `Object.entries(null)` would abort mid-write with a raw stack; mappers
  // produce none, but a literal is a readable leftover if one ever does.
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
  // A type-only import: the editor checks against the installed package and Bun
  // erases it, so the config loads without it. `mjs` is the same object. No
  // "generated by" header: the file is the user's.
  const lines: string[] = []
  if (format === 'ts') lines.push("import type { ProjectConfig } from '@vzn/vx/config'")
  // A plan's lines may declare too (vx-migrate's `const buildEnv`): a blank
  // line after the imports, as biome's organizeImports wants.
  const imports = p.importLines.filter((l) => l.startsWith('import '))
  const decls = p.importLines.filter((l) => !l.startsWith('import '))
  lines.push(...imports)
  if (lines.length > 0 && decls.length > 0) lines.push('')
  lines.push(...decls)
  if (lines.length > 0) lines.push('')
  lines.push('export default {')
  if (p.writeName === true) lines.push(`  name: ${quoteTsLiteral(p.name)},`)
  if (p.tags !== undefined && p.tags.length > 0) lines.push(`  tags: ${renderValue(p.tags, '  ')},`)
  lines.push(p.tasks.length === 0 ? '  tasks: {},' : '  tasks: {')
  for (const t of p.tasks) {
    // A reason can quote a manifest's text, and a line break ended the comment,
    // leaving code the next run evaluates. Each line stays commented.
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
 * `vx.config.mts` beside a `tsconfig.json` where tsc reads `.ts` as CommonJS
 * (node16/nodenext): its type-only import of ESM `@vzn/vx/config` fails there
 * (TS1479, TS1541).
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
 * The plan takes the config back from an output as `!vx.config.<format>`; for
 * `.mts` the take-back names it, or a `*` output covers it and `vx lock`
 * refuses.
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
