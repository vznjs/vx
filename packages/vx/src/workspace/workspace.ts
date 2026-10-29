// What a project is (2026-10-14): a directory holding a
// `vx.config.*`. `vx lock` finds them (`findProjectConfigs`) and records
// each by directory; a run takes them from the lock (`lockedProjects`) and
// never walks. A project is named by `name` in its config, else by a
// `discover` plugin, else by its root-relative path, `//` for the root.
// Design: docs/design/language-agnostic-core-2026-10.md.
import type { Dirent } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import {
  executablePath,
  gitEnv,
  gitSpawnRefusal,
  hasControl,
  isExecutableMissing,
  isOutOfFds,
  printable,
  refusal,
  relPosix,
  UserError,
} from '../util/index.js'
import { gitTop, WORKSPACE_CONFIG_FILENAMES, workspaceFile, workspaceRootOf } from '../handoff.js'
import { canonicalDir } from './canonical-dir.js'
import { parseFilter } from './filter.js'
import { repoIdOf } from './repo-id.js'

export interface ProjectMeta {
  /** `name` in its config, else a `discover` plugin's, else its root-relative path (`//` for the root). */
  name: string
  /** Absolute path to the project directory. */
  dir: string
  /** Absolute path to vx.config.{ts,mts,js,mjs,cts,cjs}; null for a project a plugin added. */
  configPath: string | null
  /** Projects a `discover` plugin says this one builds after (order and reach). */
  deps?: readonly string[]
  /** Projects a `discover` plugin says a change reaches this one through, with no order. */
  reach?: readonly string[]
}

/** A discovered project joined with its loaded vx config. */
export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

export const PROJECT_CONFIG_FILENAMES = [
  'vx.config.ts',
  'vx.config.mts',
  'vx.config.js',
  'vx.config.mjs',
  // A CommonJS config (`module.exports = …`), as Vite and TS name theirs: it
  // was ignored without a word (D-86).
  'vx.config.cts',
  'vx.config.cjs',
]

/**
 * The workspace root for `start`: the directory holding the first
 * `.vx/workspace.*` from `start` up to the git top-level, or up to `/`
 * outside git ({@link workspaceFile}, shared with the hand-off). Nothing
 * else decides it (2026-10-13: "Workspace file is the ultimate"):
 * not a `package.json`, not `pnpm-workspace.yaml`, not a lockfile. Throws
 * `VX_E_NO_WORKSPACE` when there is none.
 *
 * Outside git, a file another user owns is refused (root aside): a
 * `.vx/workspace.ts` planted in a shared directory above you (`/tmp`) is
 * code that would run as you. The owner is the file's own, a link's
 * included, and its `.vx` directory's. Inside git the walk never leaves your
 * checkout. The directory you run in is yours to judge, and costs no
 * stat. Run as root, vx trusts every owner, as a container over a mounted
 * checkout needs. `uid` is for tests.
 */
export async function findWorkspaceRoot(
  start: string,
  uid: number = process.getuid?.() ?? 0,
): Promise<string> {
  start = path.resolve(start)
  const file = await workspaceFile(start)
  if (file === null) {
    const headline = `no .vx/workspace.ts in ${start} or a parent${(await gitTop(start)) === null ? '' : ' up to the git root'}`
    throw refusal(
      { headline, fix: 'vx init' },
      { code: 'VX_E_NO_WORKSPACE', message: `${headline} — run \`vx init\` to create one` },
    )
  }
  const root = workspaceRootOf(file)
  if (uid !== 0 && root !== start && (await gitTop(start)) === null) {
    // The link itself and the `.vx` holding it, not what a link names: a
    // link another user planted to a root-owned file passed as root's, and
    // its owner could point it at their own code once it had.
    const owners = await Promise.all(
      [lstat(file), stat(path.dirname(file))].map((p) =>
        p.then(
          (st) => st.uid,
          () => uid,
        ),
      ),
    )
    if (owners.some((owner) => owner !== uid && owner !== 0)) {
      throw new UserError(
        `${file} belongs to another user, so vx does not take its directory as your workspace: ` +
          'its config would run as you. Run vx in a checkout you own, or run `vx init` in yours',
        'VX_E_NO_WORKSPACE',
      )
    }
  }
  return root
}

/**
 * The workspace's own cache directory (index, history, memos):
 * `VX_CACHE_DIR`, else the workspace's `cache.dir`, else `.vx/cache`,
 * relative to the workspace root (`--cache-dir` is the caller's, above both).
 */
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string {
  const env = process.env['VX_CACHE_DIR']
  // `cache.dir: '   '` is refused at load (X-22); the variable made the same
  // directory named in spaces at the root (D-160).
  if (env !== undefined && env !== '' && env.trim() === '') {
    throw new UserError('VX_CACHE_DIR is only whitespace — name a directory, or unset it')
  }
  const fromEnv = env !== undefined && env !== ''
  const rel = (fromEnv ? env : config?.cache?.dir) ?? path.join('.vx', 'cache')
  const home = process.env['HOME'] || homedir()
  // No shell expands `~` in a config string or a quoted variable, and
  // `'~/.cache/vx'` made a directory named `~` in the workspace.
  const dir =
    rel === '~' || rel.startsWith('~/') ? path.join(home, rel.slice(1)) : path.resolve(root, rel)
  // The cache writes a `*` .gitignore beside its index: a bare `~` made a
  // directory named `~`, and expanded it would land in home itself (D-153).
  if (path.resolve(dir) === path.resolve(home)) {
    const source = fromEnv ? 'VX_CACHE_DIR' : 'cache.dir'
    throw new UserError(
      `${source} ${JSON.stringify(rel)} is the home directory itself, where the cache's \`*\` .gitignore and index would land — name a directory under it, like '~/.cache/vx'`,
    )
  }
  return dir
}

/**
 * Where this repository's shared store lives: `~/.vx/<repo id>/cache`, as
 * Nx 23 keeps `~/.nx/<id>/cache` (2026-10-06), so every checkout of
 * the repository hits what another saved and no other repository shares
 * it (`repoIdOf`). Null when the workspace names its cache (`cache.dir`,
 * `VX_CACHE_DIR`): that directory then holds everything, as one
 * workspace's alone. Null with no repository identity or no home.
 */
export async function resolveStoreRoot(
  root: string,
  config: WorkspaceConfig | null,
): Promise<string | null> {
  if (config?.cache?.dir !== undefined || process.env['VX_CACHE_DIR']) return null
  // HOME first: Bun's homedir() keeps the HOME the process started with (1.4.2).
  const home = process.env['HOME'] || homedir()
  if (!path.isAbsolute(home)) return null
  let id = repoIds.get(root)
  if (id === undefined) repoIds.set(root, (id = repoIdOf(root)))
  const resolved = await id
  return resolved === null ? null : path.join(home, '.vx', resolved, 'cache')
}

const repoIds = new Map<string, Promise<string | null>>()

/**
 * Sets each project's `deps` / `reach` from the `discover` entries' edge
 * directories, resolved against every project the stage left. A target
 * outside the root or that is no project is refused naming the plugin.
 */
export function linkDiscoveredEdges(
  root: string,
  projects: readonly ProjectMeta[],
  edges: ReadonlyArray<{
    readonly by: string
    readonly meta: ProjectMeta
    readonly deps: readonly string[] | undefined
    readonly reach: readonly string[]
  }>,
): void {
  if (edges.length === 0) return
  const byDir = new Map(projects.map((p) => [p.dir, p.name]))
  const deps = new Map<ProjectMeta, Set<string>>()
  const reach = new Map<ProjectMeta, Set<string>>()
  for (const edge of edges) {
    // An entry carrying `deps`, even none, makes its project a leaf of an
    // edge source rather than a project no plugin spoke for.
    if (edge.deps !== undefined && !deps.has(edge.meta)) deps.set(edge.meta, new Set())
    for (const [kind, into] of [
      [edge.deps ?? [], deps],
      [edge.reach, reach],
    ] as const) {
      for (const target of kind) {
        // Every project lies inside the root (`discoveredProject` refuses
        // one that does not), so a target naming one needs no other check:
        // a plugin hands project dirs as they are, absolute, and resolving
        // and judging each of 5,000 edges was ~15 ms at 1,000 projects.
        let name = byDir.get(target) ?? byDir.get(path.resolve(root, target))
        if (name === undefined) {
          const real = canonicalDir(root, path.resolve(root, target))
          if (real !== null) name = byDir.get(real)
        }
        if (name === undefined) {
          const rel = relPosix(root, path.resolve(root, target))
          const where = `plugin '${edge.by}' gave project "${edge.meta.name}" an edge to ${target}`
          if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
            throw new UserError(`${where}: outside the workspace root`)
          }
          throw new UserError(`${where}: not a project`)
        }
        let set = into.get(edge.meta)
        if (set === undefined) into.set(edge.meta, (set = new Set()))
        set.add(name)
      }
    }
  }
  for (const [meta, names] of deps) meta.deps = [...names].sort()
  for (const [meta, names] of reach) meta.reach = [...names].sort()
}

/** The root project's name when nothing names it: Turbo's spelling, and the root alias in filters and `dependsOn`. */
export const ROOT_NAME = '//'

/** A project's name when nothing names it: its root-relative POSIX path, `//` for the root. */
export function pathName(root: string, dir: string): string {
  return relPosix(root, dir) || ROOT_NAME
}

const CONFIG_RANK = new Map(PROJECT_CONFIG_FILENAMES.map((n, i) => [n, i]))
const WORKSPACE_RANK = new Map(WORKSPACE_CONFIG_FILENAMES.map((n, i) => [n, i]))

/** A directory holding a vx config, and the config file precedence picked there. */
export interface ConfigDir {
  /** Absolute. */
  readonly dir: string
  readonly configPath: string
}

/** `vx lock`'s review copy of a project's resolved config, beside its `vx.config`. */
export const REVIEW_FILE = 'vx.lock.json'

export interface ProjectConfigs {
  readonly configs: ConfigDir[]
  /** Absolute: review copies in a directory with no config, which no `vx lock` rewrites. */
  readonly strayReviews: string[]
  /** Absolute: config files a higher-precedence one beside them hides, the root's workspace config among them, by the one read. */
  readonly shadowed: { file: string; read: string }[]
}

/**
 * Every project directory under `root`, for `vx lock` (a run reads the
 * lock and never walks). In git: `git ls-files` over the config names,
 * tracked and untracked, git's ignore rules applied, none under
 * `node_modules`, and each nested repository's own listing. Outside git: a walk
 * that skips `node_modules` and vx's own `.vx`, and enters every other
 * dot-directory, as git lists `.github/actions/x`. A config at or under a
 * nested `.vx/workspace.*` belongs to that workspace and is left out.
 * Where a directory holds several, `PROJECT_CONFIG_FILENAMES` order picks
 * the first that is a file.
 */
export async function findProjectConfigs(root: string): Promise<ProjectConfigs> {
  const inGit = (await gitTop(root)) !== null
  const rels = inGit ? await gitConfigs(root) : await scanConfigs(root)
  const nested: string[] = []
  for (const rel of rels) {
    const at = rel.lastIndexOf('/.vx/')
    if (at > 0 && WORKSPACE_RANK.has(rel.slice(at + 1))) nested.push(rel.slice(0, at))
  }
  if (inGit) nested.push(...(await unlistedNested(root, rels, nested)))
  const byDir = new Map<string, string[]>()
  const reviewed: string[] = []
  for (const rel of rels) {
    const slash = rel.lastIndexOf('/')
    const base = rel.slice(slash + 1)
    const dir = slash === -1 ? '' : rel.slice(0, slash)
    if (nested.some((n) => dir === n || dir.startsWith(`${n}/`))) continue
    if (base === REVIEW_FILE) reviewed.push(dir)
    if (!CONFIG_RANK.has(base)) continue
    const names = byDir.get(dir)
    if (names === undefined) byDir.set(dir, [base])
    else names.push(base)
  }
  const shadowed: { file: string; read: string }[] = []
  // The files among `names` (ranked), the first of them the one read: git
  // lists a tracked config deleted from the worktree, and a directory may
  // carry a config's name. Every other file is shadowed, said by `vx lock`.
  const firstFile = async (
    dir: string,
    names: string[],
    rank: ReadonlyMap<string, number>,
  ): Promise<string | null> => {
    names.sort((a, b) => rank.get(a)! - rank.get(b)!)
    const files = (
      await Promise.all(names.map(async (n) => ((await isFile(path.join(dir, n))) ? n : null)))
    ).filter((n) => n !== null)
    for (const n of files.slice(1))
      shadowed.push({ file: path.join(dir, n), read: path.join(dir, files[0]!) })
    return files[0] === undefined ? null : path.join(dir, files[0])
  }
  const found = await Promise.all(
    [...byDir].map(async ([rel, names]) => {
      const dir = rel === '' ? root : path.join(root, rel)
      const configPath = await firstFile(dir, names, CONFIG_RANK)
      return configPath === null ? null : { dir, configPath }
    }),
  )
  // The root's own, asked by name: a walk outside git lists no dot-directory.
  await firstFile(root, [...WORKSPACE_CONFIG_FILENAMES], WORKSPACE_RANK)
  shadowed.sort((a, b) => (a.file < b.file ? -1 : 1))
  const configs = found
    .filter((f): f is ConfigDir => f !== null)
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  const configured = new Set(configs.map((c) => c.dir))
  // On disk only: git lists a tracked copy deleted with its project.
  const strayReviews = (
    await Promise.all(
      reviewed
        .map((rel) => (rel === '' ? root : path.join(root, rel)))
        .filter((dir) => !configured.has(dir))
        .map(async (dir) => {
          const file = path.join(dir, REVIEW_FILE)
          return (await isFile(file)) ? file : null
        }),
    )
  )
    .filter((f) => f !== null)
    .sort()
  return { configs, strayReviews, shadowed }
}

/**
 * The nested workspace roots git did not list (an ignored `.vx/`) among the
 * directories holding `rels` and their ancestors under `root`: a run from
 * under one takes it as its root, so the outer lock must not claim it.
 */
async function unlistedNested(
  root: string,
  rels: readonly string[],
  listed: readonly string[],
): Promise<string[]> {
  const dirs = new Set<string>()
  for (const rel of rels) {
    for (let d = rel.slice(0, Math.max(rel.lastIndexOf('/'), 0)); d !== '';) {
      if (dirs.has(d)) break
      dirs.add(d)
      d = d.slice(0, Math.max(d.lastIndexOf('/'), 0))
    }
  }
  for (const n of listed) dirs.delete(n)
  // A stat, no descriptor: most directories have no `.vx`.
  const found = await Promise.all(
    [...dirs].map(async (d) =>
      (await stat(path.join(root, d, '.vx')).then(
        (st) => st.isDirectory(),
        (err: unknown) => {
          if (isOutOfFds(err)) throw err
          return false
        },
      )) && (await workspaceFileIn(root, d))
        ? d
        : null,
    ),
  )
  return found.filter((d) => d !== null)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch (err) {
    if (isOutOfFds(err)) throw err
    return false
  }
}

/**
 * The config and workspace-file paths git lists under `root`, root-relative.
 * A nested repository is one entry to the outer git, a gitlink (a
 * submodule) or an untracked `dir/` (an embedded repository), and none of
 * its files: its own git lists them, or a walk when it has no `.git`, as
 * the input enumeration expands one.
 */
async function gitConfigs(root: string): Promise<string[]> {
  const [configs, index, untracked] = await Promise.all([
    gitZ(root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ':(glob)**/vx.config.*',
      ':(glob)**/.vx/workspace.*',
      `:(glob)**/${REVIEW_FILE}`,
      NOT_INSTALLS,
    ]),
    gitZ(root, ['ls-files', '-z', '--stage', '--', NOT_INSTALLS]),
    // An embedded repository is the one untracked entry git lists as `dir/`.
    gitZ(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', NOT_INSTALLS]),
  ])
  // A submodule's `.git` is a file, an embedded repository's a directory.
  const isRepo = (rel: string): Promise<boolean> =>
    stat(path.join(root, rel, '.git')).then(
      () => true,
      () => false,
    )
  const gitlinks = index
    .filter((e) => e.startsWith('160000 '))
    .map((e) => e.slice(e.indexOf('\t') + 1))
  const embedded = untracked.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1))
  const inner = await Promise.all([
    ...gitlinks.map(async (rel) =>
      // A submodule never initialised, or vendored with its `.git` removed, is walked.
      (await isRepo(rel)) ? gitConfigs(path.join(root, rel)) : scanConfigs(path.join(root, rel)),
    ),
    ...embedded.map((rel) => gitConfigs(path.join(root, rel))),
  ])
  const nested = [...gitlinks, ...embedded]
  const prefixed = inner.flatMap((files, i) => files.map((f) => `${nested[i]}/${f}`))
  return [...configs, ...prefixed]
}

/**
 * An install is no project, tracked or not, as the walk outside git skips
 * it: a repo whose .gitignore does not name `node_modules` listed each
 * installed package's vx.config as one.
 */
const NOT_INSTALLS = ':(exclude,glob)**/node_modules/**'

/** `git <args>`'s NUL-separated output at `cwd`. */
async function gitZ(cwd: string, args: string[]): Promise<string[]> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn({
      cmd: [executablePath('git'), ...args],
      cwd,
      env: gitEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    if (isExecutableMissing(err)) throw gitSpawnRefusal(cwd)
    throw err
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new UserError(`git ls-files failed (exit ${code}): ${err.trim()}`, 'VX_E_GIT')
  return new TextDecoder('utf-8', { ignoreBOM: true })
    .decode(out)
    .split('\0')
    .filter((p) => p !== '')
}

/** The config paths under `root` outside git, root-relative: none under `node_modules`, `.git` or `.vx`. */
async function scanConfigs(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(rel === '' ? root : path.join(root, rel), { withFileTypes: true })
    } catch (err) {
      if (isOutOfFds(err)) throw err
      return
    }
    // A nested workspace's projects are its own.
    if (rel !== '' && entries.some((e) => e.name === '.vx') && (await workspaceFileIn(root, rel)))
      return
    const below: string[] = []
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (CONFIG_RANK.has(e.name) || e.name === REVIEW_FILE) out.push(child)
      else if (e.isDirectory() && !SCAN_SKIPS.has(e.name)) below.push(child)
    }
    await Promise.all(below.map(walk))
  }
  await walk('')
  return out
}

// `.vx` holds vx's state (the cache), which a checkout ignores.
const SCAN_SKIPS = new Set(['node_modules', '.git', '.vx'])

async function workspaceFileIn(root: string, rel: string): Promise<boolean> {
  const names = await readdir(path.join(root, rel, '.vx')).catch(() => [] as string[])
  return names.some((n) => WORKSPACE_RANK.has(`.vx/${n}`))
}

/** How each project got its name, when not by its path: `config`, or the plugin's name. */
const namedBy = new WeakMap<ProjectMeta, string>()

/**
 * The projects a lock records, by directory: what a run starts from. Named
 * by the locked config's `name`, else by path; a `discover` plugin may name
 * a path-named one after this.
 */
export function lockedProjects(
  root: string,
  locked: Readonly<Record<string, { readonly file: string; readonly config: ProjectConfig }>>,
): ProjectMeta[] {
  const metas: ProjectMeta[] = []
  for (const rel of Object.keys(locked)) {
    const entry = locked[rel]!
    const dir = rel === '.' ? root : path.join(root, rel)
    const name = entry.config.name
    const meta: ProjectMeta = {
      name: name ?? pathName(root, dir),
      dir,
      configPath: path.join(dir, entry.file),
    }
    if (name !== undefined) namedBy.set(meta, 'config')
    metas.push(meta)
  }
  return metas
}

/**
 * The project a plugin's `discover` entry names: a new meta (`added`) for a
 * directory that is not a project yet, else the project already there,
 * renamed when its name was its path's. A config's `name` wins over the
 * plugin's; a name another plugin gave is not changed. `known` is the
 * projects by directory: a scan per entry was quadratic, 106 ms of a 5,000
 * project warm run. `by` names the plugin in a refusal.
 */
export async function discoveredProject(
  root: string,
  known: ReadonlyMap<string, ProjectMeta>,
  entry: {
    readonly dir: string
    readonly name?: string
    readonly deps?: readonly string[]
    readonly reach?: readonly string[]
  },
  by: string,
): Promise<{ meta: ProjectMeta; added: boolean }> {
  const where = `plugin '${by}' named project`
  const dirList = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.every((d) => typeof d === 'string'))
  if (
    typeof entry?.dir !== 'string' ||
    (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name === '')) ||
    !dirList(entry.deps) ||
    !dirList(entry.reach)
  ) {
    throw new UserError(
      `${where} ${JSON.stringify(entry)}: expected { dir: string, name?: string, deps?: string[], reach?: string[] }`,
    )
  }
  const name = entry.name
  if (name !== undefined) {
    const bad = nameFault(name)
    if (bad !== null) throw new UserError(`${where} ${JSON.stringify(name)}: ${bad}`)
  }
  let dir = path.resolve(root, entry.dir)
  const rel = relPosix(root, dir)
  const named = name === undefined ? '' : ` "${name}"`
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new UserError(`${where}${named} at ${dir}: outside the workspace root`)
  }
  const shown = rel === '' ? '.' : rel
  // Refused once the stage ended too, but naming no plugin and saying to set a `name`.
  if (name === ROOT_NAME && rel !== '') {
    throw new UserError(`${where} "//" at ${shown}: "//" names the workspace root`)
  }
  let meta = known.get(dir)
  if (meta === undefined) {
    // Only a directory no project holds is resolved: a locked one is
    // already real, and a realpath per entry is a syscall per project.
    dir = canonicalDir(root, dir) ?? dir
    meta = known.get(dir)
  }
  if (meta !== undefined) {
    const from = namedBy.get(meta)
    if (name === undefined || name === meta.name || from === 'config') return { meta, added: false }
    if (from !== undefined) {
      throw new UserError(
        `${where} "${name}" at ${shown}: plugin '${from}' already named it "${meta.name}"`,
      )
    }
    meta.name = name
    namedBy.set(meta, by)
    return { meta, added: false }
  }
  if (
    !(await stat(dir).then(
      (st) => st.isDirectory(),
      () => false,
    ))
  ) {
    throw new UserError(`${where}${named} at ${shown}: no such directory`)
  }
  const added: ProjectMeta = { name: name ?? pathName(root, dir), dir, configPath: null }
  if (name !== undefined) namedBy.set(added, by)
  return { meta: added, added: true }
}

/** Why `name` cannot name a project, or null. */
function nameFault(name: string): string | null {
  if (name.trim() !== name) return 'the name has surrounding whitespace'
  // A task is `<project>#<task>` split at the first `#`.
  if (name.includes('#')) return 'the name holds "#" — vx addresses a task as <name>#<task>'
  // Printed raw by the status line and summary: `ESC ]0;` retitled the terminal.
  if (hasControl(name)) return 'the name holds a control character'
  const why = projectNameProblem(name)
  return why === null ? null : `the name ${why}`
}

/**
 * Why `dependsOn` or `--filter` cannot name a project called `name`, or
 * null; surrounding whitespace and `#` are each caller's own words. Each
 * shape loaded and could not be addressed: `^ui#build` was refused as `^`
 * with `pkg#task`, `--filter '!ui'` excluded it, `tag:ui` and `ui...` read
 * as a tag and a walk. Asked of the filter parser itself, as `tagProblem`.
 */
export function projectNameProblem(name: string): string | null {
  if (name.includes('*')) return "holds '*', which makes it a pattern"
  if (name.startsWith('^')) return "starts with '^', which names dependencies' tasks"
  if (name.startsWith('!')) return "starts with '!', which a filter reads as an exclusion"
  // The root's own name, which the filter reads as the root's directory.
  if (name === ROOT_NAME) return null
  const walk = "starts or ends with '...', which a filter reads as a dependency walk"
  let f: ReturnType<typeof parseFilter>
  try {
    f = parseFilter(name, '/')
  } catch {
    // `...` alone: the walk with no project between.
    return walk
  }
  if (f.withDeps || f.withDependents || f.onlyDeps || f.onlyDependents) return walk
  if (f.gitSince !== undefined)
    return `ends in "[${f.gitSince}]", which a filter reads as a git range`
  if (f.tag === true) return "starts with 'tag:', which a filter reads as a tag selector"
  if (f.isPath) return 'reads as a directory to a filter'
  return null
}

/**
 * Refuses two projects of one name, naming both directories, and a name
 * no task spec can address: a path name holding `#` or surrounding
 * whitespace (set `name`), or `//` on a directory other than the root.
 * Returns `metas` sorted by name.
 */
export function checkProjectNames(root: string, metas: ProjectMeta[]): ProjectMeta[] {
  metas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i]!
    const rel = relPosix(root, meta.dir) || '.'
    if (meta.name === ROOT_NAME && rel !== '.') {
      throw new UserError(`${rel}: "//" names the workspace root — set another \`name\``)
    }
    const fault = namedBy.has(meta) ? null : nameFault(meta.name)
    if (fault !== null) {
      throw new UserError(
        `${printable(rel)}: a project is named by its path unless named, and ${fault.replace('the name', 'this one')} — set \`name\` in its vx.config`,
      )
    }
    const next = metas[i + 1]
    if (next !== undefined && next.name === meta.name) {
      const dirs = [meta, next].map((m) => relPosix(root, m.dir) || '.').sort()
      throw new UserError(
        `two projects are named "${meta.name}": ${dirs[0]} and ${dirs[1]} — give one another \`name\` in its vx.config`,
      )
    }
  }
  return metas
}
