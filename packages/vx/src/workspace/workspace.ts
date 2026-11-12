// A project is a directory holding a `vx.config.*`. `vx lock` finds them
// (`findProjectConfigs`); a run takes them from the lock and never walks. Named
// by its config's `name`, else a `discover` plugin, else its root-relative path
// (`//` for the root). docs/design/language-agnostic-core-2026-10.md.
import { type Dirent, lstatSync, realpathSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import {
  executablePath,
  gitCaseArgs,
  gitEnv,
  gitSpawnRefusal,
  hasControl,
  isExecutableMissing,
  isOutOfFds,
  printable,
  refusal,
  relPosix,
  skipWorktreeSync,
  UserError,
} from '../util/index.js'
import {
  gitTop,
  WORKSPACE_CONFIG_FILENAMES,
  workspaceFile,
  workspaceFileBroken,
  workspaceRootOf,
} from '../handoff.js'
import { canonicalDir } from './canonical-dir.js'
import { parseFilter } from './filter.js'
import { locateGitDir, repoIdOf } from './repo-id.js'

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
  // was ignored without a word.
  'vx.config.cts',
  'vx.config.cjs',
]

/**
 * The workspace root for `start`: the directory holding the first
 * `.vx/workspace.*` up to the git top-level (or `/` outside git) ({@link
 * workspaceFile}). Nothing else decides it. Throws `VX_E_NO_WORKSPACE`, naming
 * `git sparse-checkout add` when a sparse checkout left it out.
 *
 * Outside git, a file another user owns is refused (unless run as root, as
 * containers need): one planted in a shared dir above you (`/tmp`) would run as
 * you. The owner checked is the file's (a link's included) and its `.vx`'s.
 * Inside git the walk never leaves your checkout. `uid` is for tests.
 */
export async function findWorkspaceRoot(
  start: string,
  uid: number = process.getuid?.() ?? 0,
): Promise<string> {
  start = path.resolve(start)
  const file = await workspaceFile(start)
  if (file === null) {
    const top = await gitTop(start)
    const sparse = top === null ? null : sparseWorkspaceFile(top)
    if (sparse !== null) {
      const fix = `git sparse-checkout add ${path.posix.dirname(sparse)}`
      throw refusal(
        { headline: `\`${sparse}\` is outside this sparse checkout`, fix },
        {
          code: 'VX_E_NO_WORKSPACE',
          message: `\`${sparse}\` is outside this sparse checkout — run \`${fix}\``,
        },
      )
    }
    const headline = `no .vx/workspace.ts in ${start} or a parent${top === null ? '' : ' up to the git root'}`
    throw refusal(
      { headline, fix: 'vx init' },
      { code: 'VX_E_NO_WORKSPACE', message: `${headline} — run \`vx init\` to create one` },
    )
  }
  if (workspaceFileBroken(file)) await refuseNotAFile(file)
  const root = workspaceRootOf(file)
  if (uid !== 0 && root !== start && (await gitTop(start)) === null) {
    // The link itself and its `.vx`, not the link's target: a link to a
    // root-owned file passed as root's, and its owner could repoint it.
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
 * The workspace file a sparse checkout left out at `top` (skip-worktree; cone
 * mode keeps root files, not `.vx`), else null. Asked only once none was found.
 */
function sparseWorkspaceFile(top: string): string | null {
  for (const name of WORKSPACE_CONFIG_FILENAMES) {
    const at = skipWorktreeSync(top, name)
    if (at !== null) return at
  }
  return null
}

/**
 * Refuses a config path that is no file: skipping it silently ran nothing
 * there. Learned by `lstat`, off the normal path.
 */
async function refuseNotAFile(file: string): Promise<never> {
  const link = await stat(file).then(
    () => false,
    () => true,
  )
  throw new UserError(
    `${file}: is ${link ? 'a broken link' : 'not a file'} — fix or remove it`,
    'VX_E_CONFIG',
  )
}

/**
 * The workspace's cache dir: `VX_CACHE_DIR`, else `cache.dir`, else
 * `.vx/cache`, relative to the root (`--cache-dir` beats both).
 */
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string {
  const env = process.env['VX_CACHE_DIR']
  // `cache.dir: ' '` is refused at load; the variable made the same directory
  // named in spaces at the root.
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
  // The cache writes a `*`.gitignore beside its index: a bare `~` made a
  // directory named `~`, and expanded it would land in home itself.
  if (path.resolve(dir) === path.resolve(home)) {
    const source = fromEnv ? 'VX_CACHE_DIR' : 'cache.dir'
    throw new UserError(
      `${source} ${JSON.stringify(rel)} is the home directory itself, where the cache's \`*\` .gitignore and index would land — name a directory under it, like '~/.cache/vx'`,
    )
  }
  return dir
}

/**
 * The repository's shared store, `~/.vx/<repo id>/cache` (as Nx keeps
 * `~/.nx/<id>/cache`): every checkout hits what another saved, no other repo
 * shares it. Null when the workspace names its cache dir, or with no repo
 * identity or home.
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
  // No identity yet (no commit, no remote) is asked again: the first
  // commit gives one, and `vx watch` runs on in the same process.
  if (resolved === null) repoIds.delete(root)
  return resolved === null ? null : path.join(home, '.vx', resolved, 'cache')
}

const repoIds = new Map<string, Promise<string | null>>()

/**
 * Sets each project's `deps` / `reach` from the `discover` entries' edge dirs.
 * A target outside the root or not a project is refused naming the plugin.
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
        // Every project lies inside the root, so a target naming one needs no
        // other check (resolving 5,000 edges was ~15 ms).
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
  /** Absolute, sorted: the outermost directories holding their own `.vx/workspace.*`. */
  readonly nestedWorkspaces: string[]
  /** Config files git lists that a sparse checkout left out: `file` absolute, `add` what `git sparse-checkout add` takes. */
  readonly sparse: { file: string; add: string }[]
}

/**
 * Every project directory under `root`, for `vx lock`. In git: `git ls-files`
 * over config names (tracked and untracked, ignores applied, none under
 * `node_modules`), plus nested repositories' own listings. Outside git: a walk
 * skipping `node_modules` and `.vx`, entering other dot-dirs. A config under a
 * nested `.vx/workspace.*` belongs to that workspace. Several in one dir:
 * `PROJECT_CONFIG_FILENAMES` order picks the first file.
 */
export async function findProjectConfigs(root: string): Promise<ProjectConfigs> {
  const inGit = (await gitTop(root)) !== null
  const linked = new Map<string, boolean>()
  // The walk outside git never follows a link.
  const rels = inGit
    ? (await gitConfigs(root)).filter((rel) => !behindLink(root, rel, linked))
    : await scanConfigs(root)
  // Each on disk, a broken link included, as the root walk takes one: git
  // lists a tracked one deleted from the worktree, which marks no root.
  const marks = rels.filter((rel) => {
    const at = rel.lastIndexOf('/.vx/')
    return at > 0 && WORKSPACE_RANK.has(rel.slice(at + 1))
  })
  const onDisk = await Promise.all(marks.map((rel) => entryAt(path.join(root, rel))))
  const nested = marks
    .filter((_, i) => onDisk[i])
    .map((rel) => rel.slice(0, rel.lastIndexOf('/.vx/')))
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
  // The files among `names`, ranked; the first is read (git lists a tracked
  // config deleted from the worktree, skipped). The rest are shadowed, said by
  // `vx lock`. With no file, a config-named entry (broken link, directory) is
  // refused, as the walk does.
  const firstFile = async (
    dir: string,
    names: string[],
    rank: ReadonlyMap<string, number>,
  ): Promise<string | null> => {
    names.sort((a, b) => rank.get(a)! - rank.get(b)!)
    const files = (
      await Promise.all(names.map(async (n) => ((await isFile(path.join(dir, n))) ? n : null)))
    ).filter((n) => n !== null)
    if (files.length === 0)
      for (const n of names)
        if (await entryAt(path.join(dir, n))) await refuseNotAFile(path.join(dir, n))
    for (const n of files.slice(1))
      shadowed.push({ file: path.join(dir, n), read: path.join(dir, files[0]!) })
    return files[0] === undefined ? null : path.join(dir, files[0])
  }
  const sparse: { file: string; add: string }[] = []
  const found = await Promise.all(
    [...byDir].map(async ([rel, names]) => {
      const dir = rel === '' ? root : path.join(root, rel)
      const configPath = await firstFile(dir, names, CONFIG_RANK)
      // Skipped, its project left the committed lock unsaid. Asked only of
      // a listed config the worktree lacks, so a full checkout pays nothing.
      if (configPath === null && inGit) {
        for (const n of names) {
          const at = skipWorktreeSync(root, rel === '' ? n : `${rel}/${n}`)
          if (at !== null) sparse.push({ file: path.join(dir, n), add: path.posix.dirname(at) })
        }
      }
      return configPath === null ? null : { dir, configPath }
    }),
  )
  sparse.sort((a, b) => (a.file < b.file ? -1 : 1))
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
  // A project's outputs stop at each, as at a nested project (computeNestedProjectDirs).
  const nestedWorkspaces = nested
    .filter((n) => !nested.some((m) => n.startsWith(`${m}/`)))
    .map((rel) => path.join(root, rel))
    .sort()
  return {
    configs,
    strayReviews,
    shadowed,
    nestedWorkspaces: [...new Set(nestedWorkspaces)],
    sparse,
  }
}

/**
 * Nested workspace roots git did not list (an ignored `.vx/`) among `rels`'
 * directories and ancestors: a run from under one takes it as root, so the
 * outer lock must not claim it.
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

/**
 * Whether a directory on `rel`'s path is a symlink, memoised. Git lists a
 * tracked path a link now fronts (a project moved and linked back) as deleted,
 * while a stat through the link found the config: one directory locked as two.
 * `vx lock` only.
 */
function behindLink(root: string, rel: string, linked: Map<string, boolean>): boolean {
  const slash = rel.lastIndexOf('/')
  if (slash === -1) return false
  const dir = rel.slice(0, slash)
  let is = linked.get(dir)
  if (is === undefined) {
    is =
      behindLink(root, dir, linked) ||
      (lstatSync(path.join(root, dir), { throwIfNoEntry: false })?.isSymbolicLink() ?? false)
    linked.set(dir, is)
  }
  return is
}

/** An entry by that name, whatever it is (`lstat`): a broken link counts. */
async function entryAt(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch (err) {
    if (isOutOfFds(err)) throw err
    return false
  }
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
 * The config and workspace-file paths git lists under `root`. A nested
 * repository is one entry to the outer git (gitlink or untracked `dir/`): its
 * own git lists its files, or a walk when it has no `.git`.
 */
async function gitConfigs(root: string): Promise<string[]> {
  const [configs, index, untracked] = await Promise.all([
    gitZ(
      root,
      [
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
        ...NOT_VX_STATE,
      ],
      true,
    ),
    gitZ(root, ['ls-files', '-z', '--stage', '--', NOT_INSTALLS, NOT_IN_VX]),
    // An embedded repository is the one untracked entry git lists as `dir/`.
    gitZ(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', NOT_INSTALLS, NOT_IN_VX]),
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
  // A linked worktree made inside the repo (`git worktree add .worktrees/x`) is
  // this tree again, not a nested repository: recorded as one, `--check` failed
  // on other checkouts.
  const common = (dir: string): string | null => {
    const at = locateGitDir(dir)?.commonDir
    return at === undefined ? null : realpathSync(at)
  }
  let rootCommon: string | null | undefined
  const embedded = untracked
    .filter((e) => e.endsWith('/'))
    .map((e) => e.slice(0, -1))
    .filter((rel) => {
      const theirs = common(path.join(root, rel))
      return theirs === null || theirs !== (rootCommon ??= common(root))
    })
  const inner = await Promise.all([
    ...gitlinks.map(async (rel) =>
      // A submodule never initialised, or vendored with its `.git` removed, is walked.
      (await isRepo(rel)) ? gitConfigs(path.join(root, rel)) : scanConfigs(path.join(root, rel)),
    ),
    ...embedded.map((rel) => gitConfigs(path.join(root, rel))),
  ])
  const nested = [...gitlinks, ...embedded]
  const prefixed = inner.flatMap((files, i) => files.map((f) => `${nested[i]}/${f}`))
  // Deduplicated: an unmerged path is listed once per stage.
  return [...new Set(configs), ...prefixed]
}

/**
 * An install is no project, tracked or not: a repo not ignoring `node_modules`
 * listed each package's vx.config.
 */
const NOT_INSTALLS = ':(exclude,glob)**/node_modules/**'

/**
 * Nothing under a `.vx` directory is a project, as the walk outside git
 * skips it: a config git listed in `.vx/cache/x` made one only in git.
 */
const NOT_IN_VX = ':(exclude,glob)**/.vx/**'
/** `NOT_IN_VX` that keeps `.vx/workspace.*`, which marks a nested workspace. */
const NOT_VX_STATE = [
  ':(exclude,glob)**/.vx/*/**',
  ':(exclude,glob)**/.vx/vx.config.*',
  `:(exclude,glob)**/.vx/${REVIEW_FILE}`,
]

/** Whether root-relative POSIX `rel` lies under a `.vx` directory, where no project lives. */
export function inVxDir(rel: string): boolean {
  return rel.startsWith('.vx/') || rel.includes('/.vx/')
}

/**
 * `git <args>`'s NUL-separated output at `cwd`. `strict`: a path not valid
 * UTF-8 is refused, as decoding turns it into one no file has.
 */
async function gitZ(cwd: string, args: string[], strict = false): Promise<string[]> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn({
      cmd: [executablePath('git'), ...gitCaseArgs(cwd), ...args],
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
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(out)
  // U+FFFD alone is cheap to look for; a valid name may hold it, so the bytes confirm.
  if (strict && text.includes('\uFFFD')) {
    let start = 0
    for (let i = 0; i <= out.length; i++) {
      if (i < out.length && out[i] !== 0) continue
      const entry = out.subarray(start, i)
      start = i + 1
      if (!isUtf8(entry)) {
        const slash = entry.lastIndexOf(0x2f)
        throw notUtf8(slash === -1 ? entry : entry.subarray(0, slash))
      }
    }
  }
  return text.split('\0').filter((p) => p !== '')
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** `rel`, a root-relative directory, with each byte that is not UTF-8 shown as `\xNN`. */
function notUtf8(rel: Uint8Array): UserError {
  let shown = ''
  for (let i = 0; i < rel.length;) {
    const lead = rel[i]!
    const n =
      lead < 0x80 ? 1 : lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0
    const seq = rel.subarray(i, i + n)
    if (n > 0 && isUtf8(seq)) {
      shown += strictUtf8.decode(seq)
      i += n
    } else {
      shown += `\\x${lead.toString(16).padStart(2, '0')}`
      i++
    }
  }
  return new UserError(
    `${printable(shown)}: the directory's name is not valid UTF-8, which no project path may hold — rename it`,
  )
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
    let lossy = false
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (CONFIG_RANK.has(e.name) || e.name === REVIEW_FILE) out.push(child)
      else if (e.isDirectory() && !SCAN_SKIPS.has(e.name)) {
        below.push(child)
        // A name not valid UTF-8 decodes to one no directory has (a valid one may hold U+FFFD).
        if (e.name.includes('\uFFFD')) lossy = true
      }
    }
    if (lossy) await refuseNotUtf8(root, rel)
    await Promise.all(below.map(walk))
  }
  await walk('')
  return out
}

/**
 * Refuses a directory in `rel` whose name is not valid UTF-8 and that holds
 * a config: walked by bytes, as no string path reaches it.
 */
async function refuseNotUtf8(root: string, rel: string): Promise<void> {
  const dir = Buffer.from(rel === '' ? root : path.join(root, rel))
  for (const name of await readdir(dir, { encoding: 'buffer' })) {
    if (isUtf8(name)) continue
    if (await holdsConfig(Buffer.concat([dir, Buffer.from('/'), name]))) {
      throw notUtf8(rel === '' ? name : Buffer.concat([Buffer.from(`${rel}/`), name]))
    }
  }
}

// Bun 1.4.4 drops `withFileTypes` under `encoding: 'buffer'`, so each entry is an lstat.
async function holdsConfig(dir: Buffer): Promise<boolean> {
  let names: Buffer[]
  try {
    names = await readdir(dir, { encoding: 'buffer' })
  } catch (err) {
    if (isOutOfFds(err)) throw err
    return false
  }
  for (const name of names) {
    const shown = name.toString()
    if (CONFIG_RANK.has(shown)) return true
    if (SCAN_SKIPS.has(shown)) continue
    const at = Buffer.concat([dir, Buffer.from('/'), name])
    if ((await lstat(at)).isDirectory() && (await holdsConfig(at))) return true
  }
  return false
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
 * The projects a lock records, by directory: what a run starts from. Named by
 * the config's `name`, else by path; a `discover` plugin may rename a
 * path-named one.
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
 * The project a `discover` entry names: a new meta (`added`) for a new
 * directory, else the existing project, renamed if its name was its path. A
 * config's `name` beats the plugin's; another plugin's name stays. `known`
 * indexes projects by dir (a scan per entry was 106 ms at 5,000 projects). `by`
 * names the plugin in a refusal.
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
 * Why `dependsOn` or `--filter` cannot name a project called `name`, or null:
 * `^ui#build`, `!ui`, `tag:ui`, `ui...` all read as syntax. Asked of the filter
 * parser itself.
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
  if (f.within !== undefined) return "ends in '{…}', which a filter reads as a directory"
  if (f.gitSince !== undefined)
    return `ends in "[${f.gitSince}]", which a filter reads as a git range`
  if (f.tag === true) return "starts with 'tag:', which a filter reads as a tag selector"
  if (f.isPath) return 'reads as a directory to a filter'
  return null
}

/**
 * Refuses two projects of one name (naming both dirs), a name no task spec can
 * address (`#` or surrounding whitespace in a path name), and `//` off the
 * root. Returns `metas` sorted by name.
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
