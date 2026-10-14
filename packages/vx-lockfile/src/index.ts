// @vzn/vx-lockfile — one plugin per package manager, each keying every
// task on its project's own resolved dependency closure from the
// lockfile instead of the whole file, and giving core the project edges
// the lockfile records (`discover`).
//
// Core folds every lockfile at the root into the workspace fingerprint
// that every task key sees, so one install re-keys the workspace and
// `--affected` selects every project. Each plugin here CLAIMS its file
// (`VxPlugin.fingerprint`) through core's `lockfileClaim`: the file leaves
// the key digest, each task folds one digest per project — what that
// project can reach through its dependencies, by resolved identity — and
// `--affected` names the projects whose digest moved. This package is the
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
   * `'workspace'`: the whole file, as core folds it — the coarse key,
   * through the plugin, for a workspace that wants the claim but not yet
   * the precision (`vx why` names it either way).
   */
  readonly scope?: 'project' | 'workspace'
}

/** Bumps when a digest folds differently or the memo holds more (its identity). */
const DIGEST_VERSION = 15

interface Manager {
  readonly name: string
  readonly file: string
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  readonly importers: (text: string) => ReadonlyMap<string, LockfileImporter>
  readonly extraFiles?: (text: string) => readonly string[]
  /** Root files no lockfile records that lay the install out: folded whole into every task. */
  readonly settings: readonly string[]
  /** The lockfile files a peer under `dependencies`: the manifest says which entries are peers. */
  readonly peersInManifest?: true
  /** Warned when the file records no importer at all, which only this format can. */
  readonly noImporters?: () => string
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
    file: 'pnpm-lock.yaml',
    digest: (t) => pnpmLock().importerDigests(pnpmParse(t)),
    importers: (t) => pnpmLock().importerLinks(pnpmParse(t)),
    settings: ['pnpm-workspace.yaml', '.npmrc'],
    peersInManifest: true,
  },
  bun: {
    name: 'bun',
    file: 'bun.lock',
    digest: (t, files) => bunLock().importerDigests(bunParse(t), files),
    importers: (t) => bunLock().importerLinks(bunParse(t)),
    extraFiles: (t) => bunLock().patchFiles(t),
    settings: ['bunfig.toml', '.npmrc'],
  },
  npm: {
    name: 'npm',
    file: 'package-lock.json',
    digest: (t) => npmLock().importerDigests(npmParse(t)),
    importers: (t) => npmLock().importerLinks(npmParse(t)),
    settings: ['.npmrc'],
  },
  yarn: {
    name: 'yarn',
    file: 'yarn.lock',
    digest: (t) => yarnLock().importerDigests(yarnParse(t)),
    importers: (t) => yarnLock().importerLinks(yarnParse(t)),
    settings: ['.yarnrc.yml'],
    noImporters: () => `yarn.lock${yarnLock().CLASSIC_EDGES}`,
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
  // The parsers name their own file, so prefixing unconditionally said it
  // twice — "bun.lock: bun.lock: Failed to parse JSONC" (2026-09-20).
  // Prefix only what does not already name it, and say what fixes it: a
  // lockfile vx cannot read is an install away from readable, and the
  // alternative to reading it is a WRONG key, so the run refuses rather
  // than guessing.
  const refused = (err: unknown): Error => {
    const message = err instanceof Error ? err.message : String(err)
    const named = message.startsWith(`${manager.file}:`) ? message : `${manager.file}: ${message}`
    return new Error(`${named} — regenerate it with \`${manager.name} install\``)
  }
  const extraFiles = manager.extraFiles
  const guarded =
    <A extends unknown[], R>(f: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return f(...args)
      } catch (err) {
        throw refused(err)
      }
    }
  const claim = lockfileClaim({
    file: manager.file,
    part: manager.name,
    version: DIGEST_VERSION,
    scope,
    importers: guarded((text: string) => {
      if (CONFLICT.test(text)) throw new Error(`${manager.file}: holds git merge conflict markers`)
      return manager.importers(text)
    }),
    // Read before `digest` on the key path: a malformed bun.lock refused
    // there as a bare "JSONC Parse error", no file named (fuzzed, L-16).
    ...(extraFiles !== undefined ? { extraFiles: guarded(extraFiles) } : {}),
    digest: guarded((text: string, files: ReadonlyMap<string, string>) => {
      // A conflicted lockfile names two installs at once. Yarn classic's
      // line parser took the second side without a word, so the key named
      // an install that may not be the one on disk.
      if (CONFLICT.test(text)) throw new Error(`${manager.file}: holds git merge conflict markers`)
      return manager.digest(text, files)
    }),
  })
  // Per run: core hands every `project` visit of one run the same array.
  const perRun = new WeakMap<
    readonly ProjectMeta[],
    Promise<ReadonlyMap<string, LockfileImporter> | undefined>
  >()
  const settingsPerRun = new WeakMap<object, Promise<Record<string, string>>>()
  return definePlugin(import.meta, {
    fingerprint: {
      files: [manager.file, ...manager.settings],
      // A settings file lays out every project's install: every project.
      affected: (change, ctx) =>
        change.file === manager.file ? claim.fingerprint.affected(change, ctx) : undefined,
    },
    async key(task, ctx) {
      let settings = settingsPerRun.get(ctx)
      if (settings === undefined) {
        settings = readSettings(ctx.workspaceRoot, manager.settings)
        settingsPerRun.set(ctx, settings)
      }
      const [deps, folded] = await Promise.all([claim.key(task, ctx), settings])
      return deps === undefined && Object.keys(folded).length === 0
        ? undefined
        : { ...deps, ...folded }
    },
    async discover(ctx) {
      const importers = await claim.importers(ctx)
      if (importers === undefined) return []
      if (importers.size === 0 && manager.noImporters !== undefined) ctx.warn(manager.noImporters())
      return discovered(
        ctx.workspaceRoot,
        ctx.projects,
        importers,
        manager.peersInManifest === true,
      )
    },
    async project(config, ctx) {
      let importers = perRun.get(ctx.projects)
      if (importers === undefined) {
        importers = claim.importers(ctx)
        perRun.set(ctx.projects, importers)
      }
      if ((await importers)?.has(importerOf(ctx.workspaceRoot, ctx.dir)) !== true) return
      const tasks = config.tasks ?? {}
      for (const [name, task] of Object.entries(tasks)) {
        const inputs = task.cache?.inputs
        if (inputs === undefined || inputs.files.includes('package.json')) continue
        // A copy: a loaded config may be shared or frozen.
        tasks[name] = {
          ...task,
          cache: {
            ...task.cache!,
            inputs: { ...inputs, files: [...inputs.files, 'package.json'] },
          },
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

/**
 * One entry per importer that is already a project: its name, the
 * importers it installs (`deps`) and its peers on importers. A peer
 * orders a build unless it would close a cycle through the order edges,
 * then it is `reach` only — the rule core's package graph keeps for
 * manifest peers, in project-name order so the edge kept is stable.
 */
function discovered(
  root: string,
  projects: readonly ProjectMeta[],
  importers: ReadonlyMap<string, LockfileImporter>,
  peersInManifest: boolean,
): DiscoveredProject[] {
  const byImporter = new Map<string, ProjectMeta>()
  for (const p of projects) byImporter.set(importerOf(root, p.dir), p)
  const names = new Map<string, number>()
  for (const p of byImporter.values()) {
    const n = p.packageJson.name
    if (typeof n === 'string') names.set(n, (names.get(n) ?? 0) + 1)
  }
  const order = new Map<ProjectMeta, Set<ProjectMeta>>()
  const peers = new Map<ProjectMeta, Set<ProjectMeta>>()
  for (const [dir, links] of importers) {
    const p = byImporter.get(dir)
    if (p === undefined) continue
    const own = new Set<ProjectMeta>()
    const peer = new Set<ProjectMeta>()
    const manifestPeers = peersInManifest ? manifestPeerNames(p) : undefined
    for (const [name, target] of Object.entries(links.deps)) {
      const t = byImporter.get(target)
      if (t !== undefined) (manifestPeers?.has(name) === true ? peer : own).add(t)
    }
    for (const target of Object.values(links.peers)) {
      const t = byImporter.get(target)
      if (t !== undefined) peer.add(t)
    }
    order.set(p, own)
    peers.set(p, peer)
  }
  const reaches = (start: ProjectMeta, goal: ProjectMeta): boolean => {
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
  const byName = (a: ProjectMeta, b: ProjectMeta): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  const sorted = [...order.keys()].sort(byName)
  const reach = new Map<ProjectMeta, ProjectMeta[]>()
  for (const p of sorted) {
    const own = order.get(p)!
    const kept: ProjectMeta[] = []
    for (const peer of [...peers.get(p)!].sort(byName)) {
      if (own.has(peer)) continue
      if (reaches(peer, p)) kept.push(peer)
      else own.add(peer)
    }
    reach.set(p, kept)
  }
  return sorted.map((p) => {
    const n = p.packageJson.name
    return {
      dir: p.dir,
      ...(typeof n === 'string' && names.get(n) === 1 ? { name: n } : {}),
      deps: [...order.get(p)!].sort(byName).map((t) => t.dir),
      reach: reach.get(p)!.map((t) => t.dir),
    }
  })
}

/** A manifest's peers it installs under no other field. */
function manifestPeerNames(p: ProjectMeta): ReadonlySet<string> {
  const field = (v: unknown): object => (v !== null && typeof v === 'object' ? v : {})
  const { dependencies, devDependencies, optionalDependencies, peerDependencies } = p.packageJson
  const installed = [dependencies, devDependencies, optionalDependencies].map(field)
  return new Set(
    Object.keys(field(peerDependencies)).filter((n) => !installed.some((f) => Object.hasOwn(f, n))),
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

/** `yarn.lock`: berry (yarn 2+, per workspace) and classic (yarn 1, one digest for the root). */
export function yarn(options: LockfileOptions = {}): VxPlugin {
  refuseUnknownOptions('yarn()', options, LOCKFILE_KEYS)
  return plugin(MANAGERS.yarn, options)
}
