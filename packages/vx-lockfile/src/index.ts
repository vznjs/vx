// @vzn/vx-lockfile — one plugin per package manager, each keying every
// task on its project's own resolved dependency closure from the
// lockfile instead of the whole file, and giving core the project edges
// the lockfile records (`discover`).
//
// Core keys no package file: without a plugin here, no lockfile, install
// setting or `package.json` reaches any key. Each plugin CLAIMS its
// lockfile (`VxPlugin.fingerprint`) through core's `lockfileClaim`: each
// task folds one digest per project — what that project can reach through
// its dependencies, by resolved identity — and `--affected` names the
// projects whose digest moved. This package is the
// parsers; the claim, the per-project key (which folds the root
// importer's digest into every project: the root's tools are on every
// task's PATH), the memo (one parse per file content, edges included),
// the per-run read and the diff are core's. The plugin also claims the
// manager's install settings, folded whole into every task, and adds
// each importer's `package.json` to its tasks' inputs.
//
// Imports core only through the public `@vzn/vx` specifier.
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  refuseUnknownOptions,
  UserError,
  type DiscoveredProject,
  type LockfileClaimHooks,
  type LockfileImporter,
  type PluginOptionKinds,
  type ProjectMeta,
  definePlugin,
  lockfileClaim,
  type VxPlugin,
} from '@vzn/vx'

// Each parser loads when first used: every run evaluates
// `.vx/workspace.ts`, and the four parsers were ~2.5 ms of it for a
// workspace that declares one manager. The digest seam is synchronous,
// so a parser loads by `require`.
const load = createRequire(import.meta.url)
const pnpmLock = (): typeof import('./pnpm.js') => load('./pnpm.js')
const bunLock = (): typeof import('./bun.js') => load('./bun.js')
const npmLock = (): typeof import('./npm.js') => load('./npm.js')
const yarnLock = (): typeof import('./yarn.js') => load('./yarn.js')

export interface LockfileOptions {
  /**
   * `'project'` (default): each task folds its own project's dependency
   * closure — a lockfile change re-keys only the projects it reaches.
   * `'workspace'`: the whole file into every task — the coarse key, for a
   * workspace that wants the claim but not yet the precision (`vx why`
   * names it either way).
   */
  readonly scope?: 'project' | 'workspace'
}

/** Bumps when a digest folds differently or the memo holds more (its identity). */
const DIGEST_VERSION = 15

interface Manager {
  readonly name: string
  /** The lockfiles the manager reads, the one it prefers first: it reads the first present. */
  readonly files: readonly [string, ...string[]]
  /** A lockfile vx cannot parse, refused when none of `files` is present beside it. */
  readonly unreadable?: { readonly file: string; readonly fix: string }
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  readonly importers: (text: string) => ReadonlyMap<string, LockfileImporter>
  readonly extraFiles?: (text: string) => readonly string[]
  /** Root files no lockfile records that lay the install out: folded whole into every task. */
  readonly settings: readonly string[]
  /** The lockfile files a peer under `dependencies`: the manifest says which entries are peers. */
  readonly peersInManifest?: true
  /**
   * Importers a format leaves out of the lockfile (yarn classic), from the
   * workspace's manifests through `manifest`; undefined where the file
   * records them itself.
   */
  readonly manifestImporters?: (
    text: string,
    workspaceRoot: string,
    manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  ) => Promise<ReadonlyMap<string, LockfileImporter> | undefined>
}

/**
 * The last parse, so `digest` and `importers` on one content parse once.
 * Per manager: the parsers are lazy, and so is this.
 */
function lastParse<T>(parse: (text: string) => T): (text: string) => T {
  let last: { text: string; parsed: T } | undefined
  return (text) => {
    if (last?.text !== text) last = { text, parsed: parse(text) }
    return last.parsed
  }
}

const pnpmParse = lastParse((t: string) => pnpmLock().parseLockfile(t))
const bunParse = lastParse((t: string) => bunLock().parseLockfile(t))
const npmParse = lastParse((t: string) => npmLock().parseLockfile(t))
const yarnParse = lastParse((t: string) => yarnLock().parseLockfile(t))

const MANAGERS = {
  pnpm: {
    name: 'pnpm',
    files: ['pnpm-lock.yaml'],
    digest: (t) => pnpmLock().importerDigests(pnpmParse(t)),
    importers: (t) => pnpmLock().importerLinks(pnpmParse(t)),
    settings: ['pnpm-workspace.yaml', '.npmrc'],
    peersInManifest: true,
  },
  bun: {
    name: 'bun',
    files: ['bun.lock'],
    // Bun's binary lockfile: core folded it whole until it keyed no
    // package file, and nothing here parses it.
    unreadable: {
      file: 'bun.lockb',
      fix: 'run `bun install --save-text-lockfile` to write bun.lock',
    },
    digest: (t, files) => bunLock().importerDigests(bunParse(t), files),
    importers: (t) => bunLock().importerLinks(bunParse(t)),
    extraFiles: (t) => bunLock().patchFiles(t),
    settings: ['bunfig.toml', '.npmrc'],
  },
  npm: {
    name: 'npm',
    // npm reads npm-shrinkwrap.json over package-lock.json when both exist.
    files: ['npm-shrinkwrap.json', 'package-lock.json'],
    digest: (t) => npmLock().importerDigests(npmParse(t)),
    importers: (t) => npmLock().importerLinks(npmParse(t)),
    settings: ['.npmrc'],
  },
  yarn: {
    name: 'yarn',
    files: ['yarn.lock'],
    digest: (t) => yarnLock().importerDigests(yarnParse(t)),
    importers: (t) => yarnLock().importerLinks(yarnParse(t)),
    settings: ['.yarnrc.yml'],
    async manifestImporters(t, root, manifest) {
      const lock = yarnParse(t)
      if (lock.generation !== 'classic') return undefined
      const pkg = await manifest(root)
      const manifests = new Map<string, Record<string, unknown>>()
      if (pkg !== null) manifests.set('.', pkg)
      for (const dir of await workspaceDirs(root, pkg)) {
        const m = await manifest(path.join(root, dir))
        if (m !== null) manifests.set(dir, m)
      }
      return yarnLock().classicLinks(lock, manifests)
    },
  },
} satisfies Record<string, Manager>

const CONFLICT = /^(?:<{7}|={7}|>{7})(?: |$)/m

function plugin(manager: Manager, options: LockfileOptions): VxPlugin {
  const scope = options.scope ?? 'project'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new UserError(
      `${manager.name}() scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`,
    )
  }
  const extraFiles = manager.extraFiles
  const claimOf = (file: string): LockfileClaimHooks => {
    // The parsers name their own file, so prefixing unconditionally said it
    // twice — "bun.lock: bun.lock: Failed to parse JSONC" (2026-09-20).
    // Prefix only what does not already name it, and say what fixes it: a
    // lockfile vx cannot read is an install away from readable, and the
    // alternative to reading it is a WRONG key, so the run refuses rather
    // than guessing.
    const refused = (err: unknown): Error => {
      const message = err instanceof Error ? err.message : String(err)
      const named = message.startsWith(`${file}:`) ? message : `${file}: ${message}`
      return new Error(`${named} — regenerate it with \`${manager.name} install\``)
    }
    const guarded =
      <A extends unknown[], R>(f: (...args: A) => R) =>
      (...args: A): R => {
        try {
          return f(...args)
        } catch (err) {
          throw refused(err)
        }
      }
    return lockfileClaim({
      file,
      part: manager.name,
      version: DIGEST_VERSION,
      scope,
      importers: guarded((text: string) => {
        if (CONFLICT.test(text)) throw new Error(`${file}: holds git merge conflict markers`)
        return manager.importers(text)
      }),
      // Read before `digest` on the key path: a malformed bun.lock refused
      // there as a bare "JSONC Parse error", no file named (fuzzed, L-16).
      ...(extraFiles !== undefined ? { extraFiles: guarded(extraFiles) } : {}),
      digest: guarded((text: string, files: ReadonlyMap<string, string>) => {
        // A conflicted lockfile names two installs at once. Yarn classic's
        // line parser took the second side without a word, so the key named
        // an install that may not be the one on disk.
        if (CONFLICT.test(text)) throw new Error(`${file}: holds git merge conflict markers`)
        return manager.digest(text, files)
      }),
    })
  }
  // One part name for every file: `npm shrinkwrap` renames the lockfile,
  // and the same install keys the same.
  const claims = manager.files.map((file) => ({ file, claim: claimOf(file) }))
  const unreadable = manager.unreadable
  // With no lockfile it reads, a lockfile it cannot: the key would name no
  // install at all, so the run refuses rather than guessing.
  const refuseUnreadable = async (workspaceRoot: string): Promise<void> => {
    if (unreadable === undefined) return
    if (!(await Bun.file(path.join(workspaceRoot, unreadable.file)).exists())) return
    throw new UserError(
      `${unreadable.file}: ${manager.name}() reads ${manager.files.join(' or ')} and finds none — ${unreadable.fix}`,
    )
  }
  const importersOf = async (
    ctx: { readonly workspaceRoot: string; readonly cacheDir: string },
    manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  ): Promise<ReadonlyMap<string, LockfileImporter> | undefined> => {
    for (const { file, claim } of claims) {
      const importers = await claim.importers(ctx)
      if (importers === undefined) continue
      if (importers.size > 0 || manager.manifestImporters === undefined) return importers
      const text = await Bun.file(path.join(ctx.workspaceRoot, file)).text()
      return (await manager.manifestImporters(text, ctx.workspaceRoot, manifest)) ?? importers
    }
    await refuseUnreadable(ctx.workspaceRoot)
    return undefined
  }
  // Per run: core hands every `project` visit of one run the same array.
  const perRun = new WeakMap<
    readonly ProjectMeta[],
    Promise<ReadonlyMap<string, LockfileImporter> | undefined>
  >()
  const settingsPerRun = new WeakMap<object, Promise<Record<string, string>>>()
  const refusedPerRun = new WeakMap<object, Promise<void>>()
  return definePlugin(import.meta, {
    fingerprint: {
      files: [...manager.files, ...manager.settings],
      // A settings file lays out every project's install: every project.
      affected: (change, ctx) =>
        claims.find((c) => c.file === change.file)?.claim.fingerprint.affected(change, ctx),
    },
    async key(task, ctx) {
      let settings = settingsPerRun.get(ctx)
      if (settings === undefined) {
        settings = readSettings(ctx.workspaceRoot, manager.settings)
        settingsPerRun.set(ctx, settings)
      }
      let deps: Readonly<Record<string, string>> | undefined
      for (const { claim } of claims) {
        deps = await claim.key(task, ctx)
        if (deps !== undefined) break
      }
      if (deps === undefined) {
        let refused = refusedPerRun.get(ctx)
        if (refused === undefined) {
          refused = refuseUnreadable(ctx.workspaceRoot)
          refusedPerRun.set(ctx, refused)
        }
        await refused
      }
      const folded = await settings
      return deps === undefined && Object.keys(folded).length === 0
        ? undefined
        : { ...deps, ...folded }
    },
    async discover(ctx) {
      const manifest = manifestReader()
      const importers = await importersOf(ctx, manifest)
      if (importers === undefined) return []
      const rootIsProject = ctx.projects.some((p) => importerOf(ctx.workspaceRoot, p.dir) === '.')
      return await discovered(
        ctx.workspaceRoot,
        importers,
        manager.peersInManifest === true,
        rootIsProject,
        manifest,
      )
    },
    async project(config, ctx) {
      let importers = perRun.get(ctx.projects)
      if (importers === undefined) {
        importers = importersOf(ctx, manifestReader())
        perRun.set(ctx.projects, importers)
      }
      if ((await importers)?.has(importerOf(ctx.workspaceRoot, ctx.dir)) !== true) return
      const tasks = config.tasks ?? {}
      for (const [name, task] of Object.entries(tasks)) {
        const inputs = task.inputs
        if (inputs === undefined || inputs.files.includes('package.json')) continue
        // A copy: a loaded config may be shared or frozen.
        tasks[name] = {
          ...task,
          inputs: { ...inputs, files: [...inputs.files, 'package.json'] },
        }
      }
    },
  })
}

/** Each present settings file's content hash, by name. */
async function readSettings(
  workspaceRoot: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const file of files) {
    let bytes: Uint8Array
    try {
      bytes = await Bun.file(path.join(workspaceRoot, file)).bytes()
    } catch {
      continue
    }
    out[file] = Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')
  }
  return out
}

/** The lockfile's importer path for a project directory: `.` for the root, POSIX otherwise. */
function importerOf(workspaceRoot: string, dir: string): string {
  return path.relative(workspaceRoot, dir).split(path.sep).join('/') || '.'
}

/** An importer's `package.json`, or null where it has none or it does not parse. */
async function manifestOf(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const pkg: unknown = await Bun.file(path.join(dir, 'package.json')).json()
    return pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)
      ? (pkg as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** `manifestOf`, each directory read once. */
function manifestReader(): (dir: string) => Promise<Record<string, unknown> | null> {
  const read = new Map<string, Promise<Record<string, unknown> | null>>()
  return (dir) => {
    let pkg = read.get(dir)
    if (pkg === undefined) {
      pkg = manifestOf(dir)
      read.set(dir, pkg)
    }
    return pkg
  }
}

/**
 * The directories a root manifest's `workspaces` globs (an array, or
 * Yarn 1's `{ packages }`) name that hold a `package.json`, root-relative
 * POSIX, sorted; none under `node_modules`.
 */
async function workspaceDirs(root: string, pkg: Record<string, unknown> | null): Promise<string[]> {
  const field = pkg?.['workspaces']
  const list = Array.isArray(field)
    ? field
    : field !== null && typeof field === 'object'
      ? (field as Record<string, unknown>)['packages']
      : undefined
  if (!Array.isArray(list)) return []
  const dirs = new Set<string>()
  for (const pattern of list) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue
    const glob = new Bun.Glob(`${pattern.replace(/^\.\//, '').replace(/\/+$/, '')}/package.json`)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const dir = path.dirname(file).split(path.sep).join('/')
      if (dir !== '.' && !dir.split('/').includes('node_modules')) dirs.add(dir)
    }
  }
  return [...dirs].sort()
}

/**
 * One entry per importer with a `package.json` (core reads none): a
 * directory that is no project yet becomes one, the root aside, which is
 * a project only by its own vx config, as it was a member only by one
 * (D-39). Its name is the
 * manifest's `name` when no other importer shares it (core refuses two
 * projects of one name, so a shared one names neither); its `deps` the
 * importers it installs, and its peers on importers. A peer orders a build
 * unless it would close a cycle through the order edges, then it is
 * `reach` only, in name order so the edge kept is stable.
 */
async function discovered(
  root: string,
  importers: ReadonlyMap<string, LockfileImporter>,
  peersInManifest: boolean,
  rootIsProject: boolean,
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
): Promise<DiscoveredProject[]> {
  const dirOf = (importer: string): string => (importer === '.' ? root : path.join(root, importer))
  const read = await Promise.all(
    [...importers.keys()]
      .filter((i) => i !== '.' || rootIsProject)
      .map(async (i) => [i, await manifest(dirOf(i))] as const),
  )
  const manifests = new Map<string, Record<string, unknown>>()
  for (const [i, pkg] of read) if (pkg !== null) manifests.set(i, pkg)
  const names = new Map<string, number>()
  for (const pkg of manifests.values()) {
    const n = pkg['name']
    if (typeof n === 'string') names.set(n, (names.get(n) ?? 0) + 1)
  }
  const nameOf = (i: string): string | undefined => {
    const n = manifests.get(i)?.['name']
    return typeof n === 'string' && n !== '' && names.get(n) === 1 ? n : undefined
  }
  // Ordered by the name it will carry, path where it has none.
  const label = (i: string): string => nameOf(i) ?? i
  const byLabel = (a: string, b: string): number => {
    const [x, y] = [label(a), label(b)]
    return x < y ? -1 : x > y ? 1 : 0
  }
  const order = new Map<string, Set<string>>()
  const peers = new Map<string, Set<string>>()
  for (const [i, links] of importers) {
    if (!manifests.has(i)) continue
    const own = new Set<string>()
    const peer = new Set<string>()
    const manifestPeers = peersInManifest ? manifestPeerNames(manifests.get(i)!) : undefined
    for (const [name, target] of Object.entries(links.deps)) {
      if (manifests.has(target)) (manifestPeers?.has(name) === true ? peer : own).add(target)
    }
    for (const target of Object.values(links.peers)) if (manifests.has(target)) peer.add(target)
    order.set(i, own)
    peers.set(i, peer)
  }
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set([start])
    const stack = [start]
    while (stack.length > 0) {
      for (const next of order.get(stack.pop()!) ?? []) {
        if (next === goal) return true
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    return false
  }
  const sorted = [...order.keys()].sort(byLabel)
  const reach = new Map<string, string[]>()
  for (const i of sorted) {
    const own = order.get(i)!
    const kept: string[] = []
    for (const peer of [...peers.get(i)!].sort(byLabel)) {
      if (own.has(peer)) continue
      if (reaches(peer, i)) kept.push(peer)
      else own.add(peer)
    }
    reach.set(i, kept)
  }
  return sorted.map((i) => {
    const name = nameOf(i)
    return {
      dir: dirOf(i),
      ...(name === undefined ? {} : { name }),
      deps: [...order.get(i)!].sort(byLabel).map(dirOf),
      reach: reach.get(i)!.map(dirOf),
    }
  })
}

/** A manifest's peers it installs under no other field. */
function manifestPeerNames(pkg: Record<string, unknown>): ReadonlySet<string> {
  const field = (v: unknown): object => (v !== null && typeof v === 'object' ? v : {})
  const installed = ['dependencies', 'devDependencies', 'optionalDependencies'].map((f) =>
    field(pkg[f]),
  )
  return new Set(
    Object.keys(field(pkg['peerDependencies'])).filter(
      (n) => !installed.some((f) => Object.hasOwn(f, n)),
    ),
  )
}

/** Each option `LockfileOptions` names, with its kind: derived from the type, so the two cannot drift. */
const LOCKFILE_KEYS: PluginOptionKinds<LockfileOptions> = {
  scope: 'string',
}

/** `pnpm-lock.yaml` (lockfile v5, v6, v9, one document or pnpm 11's two): importers, snapshots, peers, patches, `link:`. */
export function pnpm(options: LockfileOptions = {}): VxPlugin {
  refuseUnknownOptions('pnpm()', options, LOCKFILE_KEYS)
  return plugin(MANAGERS.pnpm, options)
}

/** `bun.lock` (the text lockfile): Bun's hoisted layout, nested versions, `workspace:` links. */
export function bun(options: LockfileOptions = {}): VxPlugin {
  refuseUnknownOptions('bun()', options, LOCKFILE_KEYS)
  return plugin(MANAGERS.bun, options)
}

/** `package-lock.json` (lockfileVersion 2, 3): the `packages` map, nested `node_modules`, workspace links. */
export function npm(options: LockfileOptions = {}): VxPlugin {
  refuseUnknownOptions('npm()', options, LOCKFILE_KEYS)
  return plugin(MANAGERS.npm, options)
}

/** `yarn.lock`: berry (yarn 2+, per workspace) and classic (yarn 1: one digest for the root, links from the workspaces' manifests). */
export function yarn(options: LockfileOptions = {}): VxPlugin {
  refuseUnknownOptions('yarn()', options, LOCKFILE_KEYS)
  return plugin(MANAGERS.yarn, options)
}
