import { constants, type Dirent } from 'node:fs'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import {
  BUN_GLOB_WILDCARDS,
  EXTGLOB,
  isOutOfFds,
  isPermissionError,
  relPosix,
  slashBraceExpansions,
  UserError,
  normalizeBunGlob,
} from '../util/index.js'
import { type LoadReads, readOnce, unreadable } from './load-reads.js'
import { repoIdOf } from './repo-id.js'

export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** npm / yarn / bun workspaces. May be a glob array or { packages: [...] }. */
  workspaces?: string[] | { packages?: string[] }
}

export interface Workspace {
  root: string
  /** Glob patterns relative to root that match project directories. */
  packageGlobs: string[]
}

export interface ProjectMeta {
  /** Canonical name from package.json. */
  name: string
  /** Absolute path to the project directory. */
  dir: string
  packageJson: PackageJson
  /** Absolute path to vx.config.{ts,mts,js,mjs,cts,cjs} or null. */
  configPath: string | null
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

const decoder = new TextDecoder()

/**
 * Walk up from `start` to find the workspace root. A directory is a root
 * CANDIDATE when it contains `pnpm-workspace.yaml` or a `package.json`.
 *
 * The nearest candidate that CLAIMS `start` wins — one of the directories
 * between it and `start` matches one of its package globs. Every workspace
 * member has its own `package.json`, so stopping at the first candidate would
 * make a run from inside a package treat that package as the whole workspace:
 * `^task` edges vanish, upstream hashes drop out of the cache key (stale
 * hits), and a second cache dir appears under the member. Claiming is decided
 * with the same globs `loadWorkspace` applies, so "the root that claims me"
 * and "the root that lists me as a project" cannot diverge. An outer root
 * that lists both the claimer and the claimed member outranks the claimer:
 * from the claimer's own directory the walk reaches the outer root too.
 *
 * When no candidate claims `start` — a standalone package, or a subdirectory
 * of a single-project repo — the nearest candidate wins (the root itself IS
 * the project). Throws a `UserError` when there is no candidate before `/`.
 * A load that goes on to `loadWorkspace` passes its `reads`, so the
 * root's manifest is read once for both.
 */
export async function findWorkspaceRoot(
  start: string,
  reads: LoadReads = new Map(),
): Promise<string> {
  let dir = path.resolve(start)
  const below: string[] = []
  let nearest: string | null = null
  // The nearest manifest with workspace globs of its own, once passed: an
  // outer root claims the tree only by listing this directory itself.
  let inner: string | null = null
  // The root that claims `start`, and the members it claimed it through.
  let claimed: string | null = null
  let members: string[] = []
  while (true) {
    let globs: string[] | null
    try {
      globs = await readPackageGlobs(dir, reads)
    } catch (err) {
      if (isOutOfFds(err)) throw err
      // An unparseable manifest is still a root SIGNAL (the pre-existing
      // behaviour probed only for existence); it just can't claim members.
      // `loadWorkspace` surfaces the parse error if this dir is chosen.
      globs = []
    }
    if (globs !== null) {
      nearest ??= dir
      if (claimed !== null) {
        // An outer root that lists both the claimer and the member owns
        // them: `packages/**` holding `packages/inner` (with `workspaces:
        // ['sub']`) and `packages/inner/sub` resolved `sub` to `inner` and
        // `inner` to the outer root, two roots and two keys for one tree.
        if (
          (await claimsMember(dir, [claimed], globs)) &&
          (await claimsMember(dir, members, globs))
        )
          claimed = dir
      } else if (await claimsMember(dir, inner === null ? below : [inner], globs)) {
        claimed = dir
        members = inner === null ? [...below] : [inner]
      }
      // pnpm takes the nearest `pnpm-workspace.yaml` as the root, listed or
      // not. Walking past it, `apps/inner` resolved to the outer workspace
      // while `apps/inner/pkgs/x` resolved to the inner one: two roots and
      // two caches for one tree (item 990). Already read: `reads` holds it.
      if ((await readOnce(reads, path.join(dir, 'pnpm-workspace.yaml'))) !== null) {
        return claimed ?? dir
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    // Only a directory holding a manifest can be a member: a glob that
    // matched `packages/tools`, which has none, claimed the standalone
    // package below it, and `packages/tools/standalone` ran as a stranger
    // in a workspace that does not list it (item 989).
    if (globs !== null) below.push(dir)
    // `apps/tool/workspace` with its own `workspaces`, under a root listing
    // `apps/*`, resolved to the outer root through `apps/tool`, and its
    // members ran in a workspace that does not list them (D-137). npm makes
    // an outer root own a nested one only when it lists that directory.
    if (inner === null && globs !== null && globs.length > 0) inner = dir
    dir = parent
  }
  if (claimed !== null) return claimed
  if (nearest !== null) return nearest
  throw new UserError(
    `Could not find a workspace root in any parent of ${start} ` +
      `(looked for pnpm-workspace.yaml or package.json): run vx inside a project, ` +
      `or create a package.json (\`bun init\` or \`npm init -y\`) and run \`vx init\``,
  )
}

/** True when one of `below` (dirs under `root`, toward `start`) is a member. */
async function claimsMember(
  root: string,
  below: readonly string[],
  globs: readonly string[],
): Promise<boolean> {
  if (below.length === 0 || globs.length === 0) return false
  const { positive, negative } = splitPackageGlobs(globs)
  const rels = below.map((d) => relPosix(root, d)).filter((rel) => !excludedBy(rel, negative))
  for (const pattern of positive) {
    const normalized = pattern.replace(/\/+$/, '')
    // `.` means the root itself is the project — never a directory below it.
    if (normalized === '' || normalized === '.') continue
    const glob = new Bun.Glob(normalized)
    for (const rel of rels) {
      if (!glob.match(rel)) continue
      // `match` has no `dot: false`: `packages/*` matched `packages/.tpl`,
      // which discovery skips, and a run from inside it found a workspace
      // that does not list it. Such a path asks discovery's own walk.
      if (!SKIPPED_SEGMENT.test(rel)) return true
      const dirs = await memberDirs(root, pattern)
      if (dirs.includes(path.join(root, rel))) return true
    }
  }
  return false
}

const SKIPPED_SEGMENT = /(^|\/)(\.|node_modules(\/|$))/

/**
 * pnpm, npm, yarn and Bun all take `!packages/fixtures` in the package
 * list. Handed to `Bun.Glob` raw, a leading `!` negates the WHOLE pattern,
 * so `!packages/fixtures/package.json` matched every manifest in the tree
 * and every directory holding one became a project — the excluded package
 * ran under `--all`, and a fixture repeating a name killed the run with
 * "Duplicate package name". Negations subtract from what the positive
 * globs found; a literal one excludes its tree.
 */
function splitPackageGlobs(globs: readonly string[]): { positive: string[]; negative: string[] } {
  const positive: string[] = []
  const negative: string[] = []
  // `!./packages/legacy` and `!packages//legacy` excluded nothing, silently
  // (2026-09-10): the same spellings the input globs normalize.
  for (const raw of globs) {
    // A member glob names directories, so a trailing slash says nothing:
    // npm and pnpm read `packages/*/` as `packages/*`. `normalizeBunGlob`
    // gives it a task glob's meaning, `/**`, and `packages/*/` found every
    // example and fixture package at any depth below the members (item 985).
    const g = normalizeBunGlob(raw.replace(/(.)\/+$/, '$1'))
    if (g.startsWith('!')) negative.push(g.slice(1).replace(/\/+$/, ''))
    else positive.push(g)
  }
  return { positive, negative }
}

function excludedBy(rel: string, negative: readonly string[]): boolean {
  for (const neg of negative) {
    if (neg.length === 0) continue
    if (rel === neg || rel.startsWith(`${neg}/`)) return true
    if (!BUN_GLOB_WILDCARDS.test(neg)) continue
    if (new Bun.Glob(neg).match(rel)) return true
    // pnpm matches the MANIFEST (`<pattern>/package.json`), so its documented
    // `!**/test/**` excludes `packages/test` itself; matched against the
    // directory, `**/test/**` needs something below `test` and the package
    // stayed a member (item 986).
    if (new Bun.Glob(`${neg}/package.json`).match(`${rel}/package.json`)) return true
  }
  return false
}

/**
 * Package globs declared by `dir`, or `null` when `dir` is not a root
 * candidate. A bare `package.json` (no `workspaces`) is single-project mode:
 * the root itself is the only project, hence `['.']`.
 */
async function readPackageGlobs(dir: string, reads?: LoadReads): Promise<string[] | null> {
  const yamlPath = path.join(dir, 'pnpm-workspace.yaml')
  const yaml = await readOnce(reads, yamlPath)
  let yamlWithoutPackages = false
  if (yaml !== null) {
    const parsed = parseManifest(decoder.decode(yaml), yamlPath, Bun.YAML.parse)
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new UserError(`${yamlPath}: must be a mapping (\`packages:\` and pnpm's settings)`)
      }
      const packages = (parsed as { packages?: unknown }).packages
      if (packages !== undefined) return assertGlobList(packages, yamlPath, 'packages')
    }
    // No `packages:`: pnpm 10 keeps its settings and catalogs in this file
    // for a single-package repo too. The root's package.json decides, as it
    // would without the file; read as an empty list, the root found zero
    // projects and every verb ran nothing and exited 0 (item 984).
    yamlWithoutPackages = true
  }
  const pkgPath = path.join(dir, 'package.json')
  const pkgBytes = await readOnce(reads, pkgPath)
  if (pkgBytes === null) return yamlWithoutPackages ? [] : null
  const pkg = parsePackageJson(decoder.decode(pkgBytes), pkgPath)
  const ws = pkg.workspaces as unknown
  if (ws === undefined || ws === null) return ['.']
  if (ws && typeof ws === 'object' && !Array.isArray(ws) && 'packages' in ws) {
    return assertGlobList(
      (ws as { packages?: unknown }).packages ?? [],
      pkgPath,
      'workspaces.packages',
    )
  }
  return assertGlobList(ws, pkgPath, 'workspaces')
}

/**
 * Package manifests the globs never reach, in single-project mode only: a
 * root `package.json` with no `workspaces` field makes the root the one
 * project, and a `packages/app/package.json` full of scripts beside it is
 * then invisible — `vx init` said "no package.json scripts" and `vx run`
 * said "run vx init" (2026-09-16). One shallow scan, two levels, on the
 * failure path only; `node_modules` and dot directories are skipped.
 */
export async function unreachedPackages(workspace: Workspace): Promise<string[]> {
  if (workspace.packageGlobs.length !== 1 || workspace.packageGlobs[0] !== '.') return []
  const found: string[] = []
  // Two scans: Bun.Glob does not expand a brace whose alternatives hold a
  // slash (`{*,*/*}/package.json` matched nothing, measured 2026-09-16).
  for (const pattern of ['*/package.json', '*/*/package.json']) {
    for await (const rel of new Bun.Glob(pattern).scan({
      cwd: workspace.root,
      onlyFiles: true,
      dot: false,
    })) {
      const posix = rel.split(path.sep).join('/')
      if (posix.startsWith('node_modules/') || posix.includes('/node_modules/')) continue
      found.push(posix.slice(0, -'/package.json'.length))
    }
  }
  return found.sort()
}

/** The line for `unreachedPackages`' finding: the cause, the packages, the glob to add. */
export function unreachedHint(unreached: readonly string[]): string {
  const n = unreached.length
  const shown = unreached.slice(0, 3).join(', ') + (n > 3 ? ` and ${n - 3} more` : '')
  const globs = [
    ...new Set(unreached.map((d) => (d.includes('/') ? `${path.posix.dirname(d)}/*` : d))),
  ]
    .map((g) => `"${g}"`)
    .join(', ')
  return (
    `package.json declares no \`workspaces\` (and there is no pnpm-workspace.yaml), so the root is the only project ` +
    `and ${n} package.json below it ${n === 1 ? 'is' : 'are'} not: ${shown}. ` +
    `Add \`"workspaces": [${globs}]\` to package.json and re-run.`
  )
}

/**
 * Parse a workspace manifest, naming the FILE on failure. The raw parser
 * errors (`Failed to parse JSON`) carry no path, so in a 1000-package
 * monorepo they say nothing about which manifest is broken.
 */
function parseManifest(text: string, file: string, parse: (t: string) => unknown): unknown {
  try {
    return parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${file}: ${msg}`)
  }
}

/**
 * A `package.json` as discovery reads it: a JSON object whose `name`, when
 * present, is a string with no surrounding whitespace (npm refuses one).
 * Parsed and cast unchecked, `null` crashed with a TypeError and a stack,
 * `{"name":123}` planned `123#build`, and `" a"` beside `"a"` made two
 * projects (item 988).
 */
function parsePackageJson(text: string, file: string): PackageJson {
  const pkg = parseManifest(text, file, JSON.parse)
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new UserError(`${file}: must be a JSON object`)
  }
  const name = (pkg as { name?: unknown }).name
  if (name !== undefined && (typeof name !== 'string' || name.trim() !== name)) {
    throw new UserError(`${file}: "name" must be a string with no surrounding whitespace`)
  }
  // A task is `<project>#<task>` split at the first `#`: `"a#b"` planned
  // under `--all` but no run spec or dependsOn could reach it (D-130).
  if (typeof name === 'string' && name.includes('#')) {
    throw new UserError(`${file}: "name" cannot hold "#" — vx addresses a task as <name>#<task>`)
  }
  return pkg as PackageJson
}

/**
 * A glob list is user input from a manifest: `packages: "packages/*"`
 * (a bare string instead of a list) is an easy YAML slip, and without
 * this it surfaces as `workspace.packageGlobs.map is not a function`.
 */
function assertGlobList(value: unknown, file: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string')) {
    throw new UserError(`${file}: \`${field}\` must be an array of glob strings`)
  }
  for (const pattern of value as string[]) {
    if (EXTGLOB.test(pattern)) throw extglobRefusal(pattern, file, field)
  }
  return value as string[]
}

function extglobRefusal(pattern: string, file: string, field: string): UserError {
  const head = `${file}: \`${field}\` entry "${pattern}" is an extglob, which vx's glob engine does not read`
  // The common shape, a whole segment excluding plain names, has an exact
  // rewrite in the `!` entries every package manager takes.
  const segments = pattern.split('/')
  const at = segments.findIndex((s) => /^!\([^()]*\)$/.test(s))
  const names = at === -1 ? [] : segments[at]!.slice(2, -1).split('|')
  const plain = names.every((n) => n !== '' && !BUN_GLOB_WILDCARDS.test(n) && !/[()!@+]/.test(n))
  const rest = segments.filter((_s, i) => i !== at).join('/')
  if (at === -1 || !plain || EXTGLOB.test(rest)) {
    return new UserError(
      `${head}. List the members with \`*\`, braces or \`!\` exclusions instead.`,
    )
  }
  const before = segments.slice(0, at)
  const rewrite = [
    [...before, '*', ...segments.slice(at + 1)].join('/'),
    ...names.map((n) => `!${[...before, n].join('/')}`),
  ]
  return new UserError(
    `${head} (npm and yarn read \`!(…)\` as an exclusion). List the exclusion as its own entry: [${rewrite.map((r) => JSON.stringify(r)).join(', ')}].`,
  )
}

/**
 * The workspace's own cache directory (index, history, memos): the
 * workspace's `cacheDir`, else `VX_CACHE_DIR`, else `.vx/cache`, relative
 * to the workspace root.
 */
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string {
  const rel = config?.cacheDir ?? (process.env['VX_CACHE_DIR'] || path.join('.vx', 'cache'))
  // No shell expands `~` in a config string or a quoted variable, and
  // `'~/.cache/vx'` made a directory named `~` in the workspace.
  if (rel.startsWith('~/')) {
    return path.join(process.env['HOME'] || homedir(), rel.slice(1))
  }
  return path.resolve(root, rel)
}

/**
 * Where this repository's shared store lives: `~/.vx/<repo id>/cache`, as
 * Nx 23 keeps `~/.nx/<id>/cache` (owner, 2026-10-06), so every checkout of
 * the repository hits what another saved and no other repository shares
 * it (`repoIdOf`). Null when the workspace names its cache (`cacheDir`,
 * `VX_CACHE_DIR`): that directory then holds everything, as one
 * workspace's alone. Null with no repository identity or no home.
 */
export async function resolveStoreRoot(
  root: string,
  config: WorkspaceConfig | null,
): Promise<string | null> {
  if (config?.cacheDir !== undefined || process.env['VX_CACHE_DIR']) return null
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
 * Read the workspace's package-glob list, supporting all common
 * package managers:
 *   - `pnpm-workspace.yaml` (pnpm)
 *   - `package.json` `workspaces` array (npm / yarn / bun)
 *   - `package.json` `workspaces.packages` array (yarn legacy)
 *
 * If a `package.json` exists with no `workspaces` field, the root
 * itself is treated as a single-project workspace.
 */
export async function loadWorkspace(root: string, reads?: LoadReads): Promise<Workspace> {
  const packageGlobs = await readPackageGlobs(root, reads)
  if (packageGlobs === null) {
    // The CLI never lands here (findWorkspaceRoot returns only a dir that
    // passes one of the two checks); a direct call of this public function
    // on a bare dir does (D-58).
    throw new UserError(`workspace root ${root} has neither pnpm-workspace.yaml nor package.json`)
  }
  return { root, packageGlobs }
}

// `<dir>/*` — the shape of nearly every workspace glob. Anything with another
// glob character (`**`, `{a,b}`, `?`, `[`) or a negation takes the general
// path.
const SIMPLE_STAR_RE = /^[^*?{}[\]!]+\/\*$/

/**
 * The directory each `<dir>/*` package glob names — where a member comes
 * and goes as one directory entry, so `vx watch` can hear a package added
 * or removed without walking anything. A glob of another shape (`apps/**`)
 * has no such directory and contributes none.
 */
export function memberBaseDirs(workspace: Workspace): string[] {
  const bases = new Set<string>()
  for (const pattern of splitPackageGlobs(workspace.packageGlobs).positive) {
    const normalized = pattern === '.' ? '' : pattern.replace(/\/$/, '')
    if (SIMPLE_STAR_RE.test(normalized)) {
      bases.add(path.resolve(workspace.root, normalized.slice(0, -2)))
    }
  }
  return [...bases]
}

/**
 * True when a member glob reaches a `package.json` other than the root's,
 * addressable or not: a nameless manifest, or two sharing a name, is
 * matched and left out, not unmatched (M-46).
 */
export async function reachesManifest(workspace: Workspace): Promise<boolean> {
  const { positive, negative } = splitPackageGlobs(workspace.packageGlobs)
  const root = path.resolve(workspace.root)
  for (const pattern of positive) {
    for (const dir of await memberDirs(workspace.root, pattern)) {
      if (path.resolve(dir) === root) continue
      if (negative.length > 0 && excludedBy(relPosix(workspace.root, dir), negative)) continue
      try {
        if ((await stat(path.join(dir, 'package.json'))).isFile()) return true
      } catch (err) {
        absent(err, undefined)
      }
    }
  }
  return false
}

/**
 * The directories a workspace glob names. For the `<dir>/*` shape this is
 * one readdir of `<dir>` — the same answer `Bun.Glob` gives, at a third of
 * the cost (measured 2026-09-02: 25 ms → ~2 ms for 1000 members). A
 * symlinked member is followed when it points at a directory, and so is
 * it by the scan any other shape takes, unless the glob holds `**` (item
 * 987). Dot-directories are skipped (`dot: false`), so are `node_modules`.
 */
async function memberDirs(root: string, pattern: string): Promise<string[]> {
  // Normalize: `"."` -> the root itself; `"foo/"` -> `"foo"`.
  const normalized = pattern === '.' ? '' : pattern.replace(/\/$/, '')
  if (SIMPLE_STAR_RE.test(normalized)) {
    const base = path.resolve(root, normalized.slice(0, -2))
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (err) {
      return absent(err, [])
    }
    const dirs: string[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.isDirectory()) dirs.push(path.join(base, e.name))
      else if (e.isSymbolicLink()) {
        try {
          if ((await stat(path.join(base, e.name))).isDirectory())
            dirs.push(path.join(base, e.name))
        } catch (err) {
          absent(err, undefined) // dangling link: not a member
        }
      }
    }
    return dirs
  }
  const dirs: string[] = []
  // `Bun.Glob`'s scan finds nothing for a brace whose alternatives hold a
  // slash, though its `match` reads one: `packages/{a,nested/b}` listed
  // neither package, and both ran under no verb while the root still
  // claimed them (D-2). Such a pattern is scanned as its expansions.
  for (const expanded of slashBraceExpansions(normalized)) {
    const globPattern = expanded === '' ? 'package.json' : `${expanded}/package.json`
    const glob = new Bun.Glob(globPattern)
    // A linked member is a member, as the readdir path above has it:
    // `packages/*` found `packages/b -> ../ext/b` while `packages/{a,b}` and
    // `pack*/*` did not (item 987). Followed only where the depth is bounded:
    // under `**` the scan would walk every pnpm `node_modules` link.
    const followSymlinks = !expanded.includes('**')
    try {
      for await (const rel of glob.scan({
        cwd: root,
        onlyFiles: true,
        dot: false,
        followSymlinks,
      })) {
        // Skip nested node_modules — workspace package globs shouldn't
        // ever reach into them, but a pathological pattern like `**`
        // would. Avoid splitting the path on the hot loop.
        if (rel.includes(`${path.sep}node_modules${path.sep}`)) continue
        if (rel.startsWith(`node_modules${path.sep}`)) continue
        dirs.push(path.dirname(path.resolve(root, rel)))
      }
    } catch (err) {
      // The scan stops at a directory it may not open and cannot skip it,
      // so the readdir path's skip is not on offer here (D-132).
      if (!isPermissionError(err)) throw err
      const where = relPosix(root, path.resolve(root, err.path ?? ''))
      throw new UserError(
        `${where}: not readable by this user (${err.code}), and the workspace glob "${pattern}" walks into it`,
      )
    }
  }
  return dirs
}

/**
 * The project's config file, by `PROJECT_CONFIG_FILENAMES` precedence, or null.
 *
 * Two shapes, one per platform, each the measured winner there across
 * 1,000 projects with the manifest read in flight alongside:
 *   - macOS stats the candidates in order: a readdir each cost 9.6 ms
 *     against 6.3 ms of stats even with the config at the LAST name
 *     (2026-09-03), and a `.ts` config — the first name — pays one stat.
 *   - Linux lists the directory once: a readdir each is 12 ms against
 *     43 ms of stats at the last name and ties the one-stat case
 *     (2026-09-09, a `vx.config.mjs` workspace; stats there cost a
 *     thread-pool round trip apiece).
 * Both answer identically: a directory or dangling link under a config
 * name is skipped for the next name, a symlink to a file counts.
 */
async function findConfigFile(dir: string): Promise<string | null> {
  if (process.platform === 'linux') {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      return absent(err, null)
    }
    // By precedence slot, not a Map per directory, and no `path.join`: at
    // 5,000 projects that cut `listProjects` from 53.5 to 47.7 ms (min of
    // 15, six interleaved rounds, A/A 54.7).
    const found: Dirent[] = []
    for (const e of entries) {
      const rank = CONFIG_RANK.get(e.name)
      if (rank !== undefined) found[rank] = e
    }
    for (const entry of found) {
      if (entry === undefined) continue
      const candidate = dir + path.sep + entry.name
      if (entry.isFile()) return candidate
      if (entry.isSymbolicLink() && (await isFile(candidate))) return candidate
    }
    return null
  }
  for (const name of PROJECT_CONFIG_FILENAMES) {
    const candidate = path.join(dir, name)
    if (await isFile(candidate)) return candidate
  }
  return null
}

const CONFIG_RANK = new Map(PROJECT_CONFIG_FILENAMES.map((n, i) => [n, i]))

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch (err) {
    return absent(err, false)
  }
}

/**
 * A read that found nothing is absent; one the process could not make is
 * not. Out of descriptors (`EMFILE`), every member read failed, and the
 * catches here read the workspace as empty: "No package matched the
 * workspace's package globs" (D-60).
 */
function absent<T>(err: unknown, value: T): T {
  if (isOutOfFds(err)) throw err
  return value
}

/**
 * A member's manifest text, or null when there is none. A manifest this
 * user may not read is refused, not skipped: its project dropped out of
 * `--all` and the run went green without it (D-132). A directory it may
 * not search hides whether a manifest is there at all, so that one is
 * named and skipped (a service's data directory under `packages/*`).
 */
async function readManifest(root: string, dir: string, file: string): Promise<string | null> {
  try {
    return await Bun.file(file).text()
  } catch (err) {
    if (!isPermissionError(err)) return absent(err, null)
    const searchable = await access(dir, constants.X_OK).then(
      () => true,
      () => false,
    )
    if (searchable) unreadable(err, file)
    process.stderr.write(
      `vx: ${relPosix(root, dir)} is not readable by this user — skipped, with any project in it\n`,
    )
    return null
  }
}

export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]> {
  return discoverProjects(workspace)
}

/**
 * `listProjects`, and `nameless` collects each member directory whose
 * manifest has no `name`: `vx init` names them, since their scripts map to
 * nothing.
 */
export async function discoverProjects(
  workspace: Workspace,
  nameless?: string[],
): Promise<ProjectMeta[]> {
  // Run all package globs concurrently. Disk-bound walks parallelize
  // well; serializing them just stretches the discovery phase by N×.
  const { positive, negative } = splitPackageGlobs(workspace.packageGlobs)
  // A root the globs do not list is a project when it holds a vx config
  // (D-39): the package manager's member list stays the manager's, and
  // the root's globs stop at every member as any parent project's do.
  const [perPattern, rootConfig] = await Promise.all([
    Promise.all(positive.map((pattern) => memberDirs(workspace.root, pattern))),
    findConfigFile(workspace.root),
  ])
  const matches = new Set<string>()
  for (const arr of perPattern) {
    for (const m of arr) {
      if (negative.length > 0 && excludedBy(relPosix(workspace.root, m), negative)) continue
      matches.add(m)
    }
  }
  if (rootConfig !== null) matches.add(workspace.root)

  // Per-project discovery: the manifest read answers "is there a
  // package.json" (an ENOENT is the "not a member" answer, at the cost of
  // one failed open) and `findConfigFile` answers "which config file", both
  // in flight together. All async and all in flight at once — the thread
  // pool runs them in parallel, and a sync read here measured 2× slower on
  // a 1000-member workspace.
  const loaded = await Promise.all(
    [...matches].map(async (dir) => {
      const pkgJsonPath = dir + path.sep + 'package.json'
      const [configPath, text] = await Promise.all([
        findConfigFile(dir),
        readManifest(workspace.root, dir, pkgJsonPath),
      ])
      if (text === null) {
        // A member dir with a vx config and no manifest was skipped without
        // a word: `--all` said no package matched, and a run from inside
        // it "not inside a project" (D-128). The config was found in the
        // same flight as the failed read, so naming it costs nothing.
        if (configPath !== null) {
          process.stderr.write(
            `vx: ${relPosix(workspace.root, dir)} has a vx config but no package.json — skipped: vx names a project by its package.json "name"\n`,
          )
        }
        return null
      }
      const pkg = parsePackageJson(text, pkgJsonPath)
      return { dir, pkg, configPath }
    }),
  )

  const byName = new Map<string, NonNullable<(typeof loaded)[number]>[]>()
  for (const entry of loaded) {
    if (entry === null) continue
    const { dir, pkg, configPath } = entry
    // npm and pnpm take `../ext/*`, but `--affected` asks git from the root
    // and sees nothing outside it: an edit there moved the task's key and
    // selected nothing, green.
    const rel = relPosix(workspace.root, dir)
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new UserError(
        `workspace member ${rel} (${dir}) is outside the workspace root ${workspace.root}: ` +
          'vx keeps every project under the root. Move the workspace root up to a directory that holds every member.',
      )
    }
    if (!pkg.name) {
      nameless?.push(dir)
      // A nameless manifest can't be addressed, filtered, or made affected —
      // and vx identifies projects by name, so it simply vanishes. Silent is
      // fine for a dir that declares no tasks; a dir with a vx config was
      // meant to run.
      if (configPath !== null) {
        const rel = relPosix(workspace.root, dir)
        process.stderr.write(
          `vx: ${rel === '' ? 'the workspace root' : rel} has a vx config but its package.json has no "name" — skipped\n`,
        )
      }
      continue
    }
    const group = byName.get(pkg.name)
    if (group === undefined) byName.set(pkg.name, [entry])
    else group.push(entry)
  }
  const projects: ProjectMeta[] = []
  const shared: string[] = []
  let rootReal: string | undefined
  for (const [name, found] of byName) {
    // One package reached by two paths (a member and a link to it) is one
    // project, not a name two packages share: `apps/docs -> ../packages/docs`
    // was refused as a duplicate and told to rename one (D-135). Resolved
    // only here, so a workspace without a shared name pays nothing.
    let group = found
    if (group.length > 1) {
      rootReal ??= await realpath(workspace.root)
      group = await oneEntryPerPackage(group, workspace.root, rootReal)
    }
    if (group.length === 1) {
      const { dir, pkg, configPath } = group[0]!
      projects.push({ name, dir, packageJson: pkg, configPath })
      continue
    }
    // The root's own manifest is '' relative to itself, and the refusal read
    // "in workspace:  and packages/a" (D-127).
    const dirs = group
      .map((e) => relPosix(workspace.root, e.dir))
      .sort()
      .map((d) => (d === '' ? 'the workspace root' : d))
    // pnpm accepts two manifests of one name (vite's playground, sveltejs/kit's
    // test apps); vx cannot, since a project is addressed by it. Like a
    // nameless one, a pair that declares no vx tasks is left out, so the
    // rest of the workspace runs (vite was refused whole, 2026-10-01); one
    // with a vx config was meant to run, and is refused with the way on.
    if (group.some((e) => e.configPath !== null)) {
      throw new UserError(
        `Duplicate package name "${name}" in workspace: ${dirs.join(' and ')}; ` +
          'vx names a project by its package name — rename one, or leave one out with a `!` pattern in the workspace globs',
      )
    }
    shared.push(`${name} (${dirs.join(', ')})`)
  }
  if (shared.length > 0) {
    shared.sort()
    const shown =
      shared.slice(0, 2).join('; ') + (shared.length > 2 ? `; and ${shared.length - 2} more` : '')
    process.stderr.write(
      `vx: left out, as no project can be addressed by a name several manifests share (none has a vx config): ${shown}\n`,
    )
  }

  // Code-unit order, not `localeCompare`: ICU collation cost 28 ms of a
  // 300 ms warm run at 1000 projects, and a stable deterministic order is
  // all any consumer needs.
  return projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The entries of a name group, one per real directory. Of several paths to
 * one package, the one that reaches it through no link inside the
 * workspace is kept, else the first in path order.
 */
async function oneEntryPerPackage<T extends { dir: string }>(
  group: T[],
  root: string,
  rootReal: string,
): Promise<T[]> {
  const byReal = new Map<string, T[]>()
  for (const entry of group) {
    const real = await realpath(entry.dir)
    const same = byReal.get(real)
    if (same === undefined) byReal.set(real, [entry])
    else same.push(entry)
  }
  if (byReal.size === group.length) return group
  const kept: T[] = []
  for (const [real, paths] of byReal) {
    const direct = paths.find((e) => relPosix(root, e.dir) === relPosix(rootReal, real))
    kept.push(direct ?? paths.sort((a, b) => (a.dir < b.dir ? -1 : 1))[0]!)
  }
  return kept
}

/**
 * A directory a plugin's `discover` hook names, as a project meta; null
 * when `known` already holds it under that name. `by` names the plugin in
 * a refusal. A directory without a `package.json` is a project by the
 * plugin's name alone.
 */
export async function namedProject(
  workspace: Workspace,
  known: readonly ProjectMeta[],
  named: { readonly dir: string; readonly name: string },
  by: string,
): Promise<ProjectMeta | null> {
  const where = `plugin '${by}' named project`
  if (typeof named?.name !== 'string' || named.name === '' || typeof named.dir !== 'string') {
    throw new UserError(`${where} ${JSON.stringify(named)}: expected { dir: string, name: string }`)
  }
  // The rules `parsePackageJson` holds a manifest's name to: a plugin's name
  // for a directory with no `name` of its own skipped them, and `a#b` planned
  // under `--all` while no run spec or dependsOn could reach it.
  if (named.name.trim() !== named.name) {
    throw new UserError(
      `${where} ${JSON.stringify(named.name)}: the name has surrounding whitespace`,
    )
  }
  if (named.name.includes('#')) {
    throw new UserError(
      `${where} "${named.name}": the name holds "#" — vx addresses a task as <name>#<task>`,
    )
  }
  const dir = path.resolve(workspace.root, named.dir)
  const rel = relPosix(workspace.root, dir)
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new UserError(`${where} "${named.name}" at ${dir}: outside the workspace root`)
  }
  const shown = rel === '' ? '.' : rel
  for (const p of known) {
    if (p.dir === dir && p.name === named.name) return null
    if (p.dir === dir) {
      throw new UserError(`${where} "${named.name}" at ${shown}: already the project "${p.name}"`)
    }
    if (p.name === named.name) {
      throw new UserError(
        `${where} "${named.name}" at ${shown}: the name is taken by ${relPosix(workspace.root, p.dir) || '.'}`,
      )
    }
  }
  const pkgJsonPath = dir + path.sep + 'package.json'
  const [configPath, text] = await Promise.all([
    findConfigFile(dir),
    readManifest(workspace.root, dir, pkgJsonPath),
  ])
  if (
    text === null &&
    !(await stat(dir).then(
      (st) => st.isDirectory(),
      () => false,
    ))
  ) {
    throw new UserError(`${where} "${named.name}" at ${shown}: no such directory`)
  }
  const parsed: Partial<PackageJson> = text === null ? {} : parsePackageJson(text, pkgJsonPath)
  // A nameless manifest names nothing to disagree with (Nx's own projects).
  const pkg: PackageJson = { ...parsed, name: parsed.name ?? named.name }
  if (pkg.name !== named.name) {
    throw new UserError(
      `${where} "${named.name}" at ${shown}: its package.json names it "${pkg.name ?? ''}"`,
    )
  }
  return { name: named.name, dir, packageJson: pkg, configPath }
}
