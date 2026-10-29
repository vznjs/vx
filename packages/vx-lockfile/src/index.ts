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
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
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
  reachDigests,
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
const pnpmSettings = (): typeof import('./pnpm-settings.js') => load('./pnpm-settings.js')
const yarnSettings = (): typeof import('./yarn-settings.js') => load('./yarn-settings.js')

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
const DIGEST_VERSION = 23

let memoVersion: number | undefined
/**
 * The memo's version: DIGEST_VERSION and the parsers' own source, with
 * what core's `reachDigests` answers. The closures core sees wrap every parser alike,
 * so a parser fix that forgot the bump replayed the digests the old one
 * folded. Read once per process (~40 µs for the ten files); a plugin with
 * no source beside it keys on DIGEST_VERSION alone.
 */
function digestVersion(): number {
  if (memoVersion !== undefined) return memoVersion
  // Core's fold by what it answers, not its text: a cycle's labels live in
  // a helper it calls. The probe has a chain, a cycle, a self-loop and two
  // copies of one material in and out of the cycle, so each branch shows.
  let h = Bun.hash.xxHash3(
    reachDigests({
      material: ['a', 'b', 'x', 'x', 'y', 'z', 'x'],
      edges: [[1, 2, 6], [0, 3], [0, 4], [5], [4], [], [0, 5]],
    }).join('\0'),
  )
  try {
    for (const f of readdirSync(import.meta.dir).sort()) {
      if (/\.[cm]?[jt]s$/.test(f))
        h = Bun.hash.xxHash3(readFileSync(path.join(import.meta.dir, f)), h) ^ h
    }
  } catch {
    // Bundled: the source is not on disk.
  }
  memoVersion = DIGEST_VERSION * 2 ** 32 + Number(h & 0xffffffffn)
  return memoVersion
}

interface Manager {
  readonly name: string
  /** The lockfiles the manager reads, the one it prefers first: it reads the first present. */
  readonly files: readonly [string, ...string[]]
  /** A lockfile vx cannot parse, refused when none of `files` is present beside it. */
  readonly unreadable?: { readonly file: string; readonly fix: string }
  /** `root`: the workspace root, for a settings file the digest reads (yarn's `packageExtensions`). */
  readonly digest: (
    text: string,
    files: ReadonlyMap<string, string>,
    root: string,
  ) => ReadonlyMap<string, string>
  readonly importers: (text: string) => ReadonlyMap<string, LockfileImporter>
  /** Each importer's dependency names the file records, whatever they resolve to. */
  readonly recorded: (text: string) => ReadonlyMap<string, ReadonlyMap<string, unknown>>
  /** `root` is the workspace's when the key reads them, undefined under `--affected`. */
  readonly extraFiles?: (text: string, root: string | undefined) => readonly string[]
  /** Dirs the manager's workspace walk never enters (default `node_modules`). */
  readonly skippedDirs?: readonly string[]
  /** Root files no lockfile records that lay the install out: folded whole into every task. */
  readonly settings: readonly string[]
  /**
   * A settings file's bytes as the key folds them, where the lockfile
   * records part of what it says per project; undefined folds them whole.
   */
  readonly settingsText?: (file: string, text: string) => string | undefined
  /**
   * Whether the manager lists a manifest its workspace globs match;
   * undefined lists every one.
   */
  readonly member?: (pkg: Record<string, unknown>) => boolean
  /** The lockfile files a peer under `dependencies`: the manifest says which entries are peers. */
  readonly peersInManifest?: true
  /** The file leaves out every `link:` dependency (pnpm's `excludeLinksFromLockfile`): the manifests name them. */
  readonly linksUnrecorded?: (text: string) => boolean
  /**
   * A manifest dependency the install leaves out of the file by design, so
   * its absence is no stale lockfile.
   */
  readonly unrecorded?: (text: string) => (name: string, pkg: Record<string, unknown>) => boolean
  /** The manager reads package.json as JSONC (trailing commas, comments): bun does. */
  readonly jsoncManifests?: true
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
    digest: (t, files) => pnpmLock().importerDigests(pnpmParse(t), files),
    importers: (t) => pnpmLock().importerLinks(pnpmParse(t)),
    extraFiles: (t) => pnpmLock().fileDeps(pnpmParse(t)),
    recorded: (t) => pnpmLock().recordedImporters(t),
    // pnpm's walk skips bower_components as it does node_modules (pnpm 10).
    skippedDirs: ['node_modules', 'bower_components'],
    // The root package.json for its `pnpm` field: pnpm reads install
    // settings there that the lockfile does not record.
    settings: ['pnpm-workspace.yaml', '.npmrc', 'package.json'],
    settingsText: (file, text) =>
      file === 'pnpm-workspace.yaml'
        ? pnpmSettings().workspaceSettings(text)
        : file === 'package.json'
          ? pnpmSettings().packageSettings(text)
          : undefined,
    peersInManifest: true,
    // Read from their blocks alone: a whole parse here was on every warm run.
    linksUnrecorded: (t) => pnpmLock().excludesLinks(t),
    unrecorded: (t) => pnpmLock().ignoredOptional(t),
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
    recorded: (t) => bunParse(t).workspaces,
    // Bun leaves out a manifest with no name, as build output's
    // `{"type":"module"}` (probed on 1.4.4); no version is listed.
    member: (pkg) => typeof pkg['name'] === 'string' && pkg['name'] !== '',
    extraFiles: (t) => [...bunLock().patchFiles(t), ...bunLock().fileDeps(bunParse(t))],
    settings: ['bunfig.toml', '.npmrc'],
    jsoncManifests: true,
  },
  npm: {
    name: 'npm',
    // npm reads npm-shrinkwrap.json over package-lock.json when both exist.
    files: ['npm-shrinkwrap.json', 'package-lock.json'],
    digest: (t, files) => npmLock().importerDigests(npmParse(t), files),
    importers: (t) => npmLock().importerLinks(npmParse(t)),
    extraFiles: (t) => npmParse(t).fileDirs,
    recorded: (t) => {
      const out = new Map<string, ReadonlyMap<string, unknown>>()
      for (const [p, e] of npmParse(t).packages) {
        if (p === '' || e.isWorkspace) out.set(p === '' ? '.' : p, e.deps)
      }
      return out
    },
    settings: ['.npmrc'],
  },
  yarn: {
    name: 'yarn',
    files: ['yarn.lock'],
    digest: (t, files, root) => {
      const lock = yarnParse(t)
      // The working tree's file on both sides of an `--affected` diff: a
      // changed one is a settings change, which selects every project.
      const rc =
        lock.generation === 'berry' ? readText(path.join(root, yarnLock().YARNRC)) : undefined
      return yarnLock().importerDigests(lock, files, yarnLock().packageExtensions(rc))
    },
    importers: (t) => yarnLock().importerLinks(yarnParse(t)),
    extraFiles: (t, root) => {
      // Classic keys a `link:` to a workspace like any linked directory,
      // and records no workspace to tell them apart. Yarn 1 links the
      // workspace itself (an edge, from the manifests), and its content
      // folded into the one digest every task folds re-keyed the whole
      // repo on each edit under it, its own build output included. A
      // `file:` one is a copy, so its content stays.
      // Berry's file names its workspaces, and contentDirs reads them there.
      const lock = yarnParse(t)
      const linked =
        root === undefined || lock.generation !== 'classic'
          ? undefined
          : (d: string) => isClassicWorkspace(root, d)
      return yarnLock().fileDeps(lock, linked)
    },
    recorded: (t) => {
      const lock = yarnParse(t)
      const out = new Map<string, ReadonlyMap<string, unknown>>()
      for (const [dir, id] of lock.workspaces) out.set(dir, lock.entries.get(id)!.deps)
      return out
    },
    // `.yarnrc` is Yarn 1's: `ignore-scripts true` there changes the install
    // under an unchanged yarn.lock (probed, yarn 1.22). Yarn 1 reads an
    // option `.yarnrc` leaves unset from `.npmrc`: `production=true` there
    // dropped every devDependency (probed, yarn 1.22).
    // The root package.json for `workspaces.nohoist` and `installConfig`,
    // which lay the install out and the lockfile does not record.
    settings: ['.yarnrc.yml', '.yarnrc', '.npmrc', 'package.json'],
    settingsText: (file, text) =>
      file === 'package.json' ? yarnSettings().packageSettings(text) : undefined,
    async manifestImporters(t, root, manifest) {
      const lock = yarnParse(t)
      if (lock.generation !== 'classic') return undefined
      const pkg = await manifest(root)
      const manifests = new Map<string, Record<string, unknown>>()
      if (pkg !== null) manifests.set('.', pkg)
      // Yarn 1 takes no `!` glob: it links the directory anyway.
      const globs = globsOf(pkg).filter((g) => typeof g !== 'string' || !g.startsWith('!'))
      for (const dir of await workspaceDirs(root, globs)) {
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
      `${manager.name}() option "scope" must be 'project' or 'workspace', got ${JSON.stringify(scope)}`,
    )
  }
  const extraFiles = manager.extraFiles
  const guardedFor = (file: string) => {
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
    // Every reader takes the text first. A conflicted lockfile names two
    // installs at once (yarn classic's line parser took the second side
    // without a word), so each refuses it first: checked in the digest and
    // edges alone, the extra files read before them refused pnpm, npm and
    // bun lockfiles with a bare parse error.
    return <A extends [string, ...unknown[]], R>(f: (...args: A) => R) =>
      (...args: A): R => {
        try {
          if (CONFLICT.test(args[0])) throw new Error(`${file}: holds git merge conflict markers`)
          return f(...args)
        } catch (err) {
          throw refused(err)
        }
      }
  }
  const claimOf = (file: string, root: string, affected: boolean): LockfileClaimHooks => {
    const guarded = guardedFor(file)
    return lockfileClaim({
      file,
      part: manager.name,
      version: digestVersion(),
      scope,
      importers: guarded((text: string) => manager.importers(text)),
      // Read before `digest` on the key path: a malformed bun.lock refused
      // there as a bare "JSONC Parse error", no file named (fuzzed, L-16).
      ...(extraFiles !== undefined
        ? { extraFiles: guarded((text: string) => extraFiles(text, affected ? undefined : root)) }
        : {}),
      digest: guarded((text: string, files: ReadonlyMap<string, string>) =>
        manager.digest(text, files, root),
      ),
    })
  }
  // One part name for every file: `npm shrinkwrap` renames the lockfile,
  // and the same install keys the same. Per workspace root: a digest may
  // read a root settings file. `--affected` reads its claims with no root
  // for links: a path under a workspace is its project's change there,
  // never a lockfile's.
  const rooted = new Map<string, { file: string; claim: LockfileClaimHooks }[]>()
  const rootless = new Map<string, { file: string; claim: LockfileClaimHooks }[]>()
  const claimsAt = (
    root: string,
    affected = false,
  ): { file: string; claim: LockfileClaimHooks }[] => {
    const memo = affected ? rootless : rooted
    let at = memo.get(root)
    if (at === undefined) {
      at = manager.files.map((file) => ({ file, claim: claimOf(file, root, affected) }))
      memo.set(root, at)
    }
    return at
  }
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
  /** The importers, and the lockfile they came from unless the manifests named them. */
  const readImporters = async (
    ctx: { readonly workspaceRoot: string; readonly cacheDir: string },
    manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  ): Promise<
    { importers: ReadonlyMap<string, LockfileImporter>; file: string | undefined } | undefined
  > => {
    for (const { file, claim } of claimsAt(ctx.workspaceRoot)) {
      const importers = await claim.importers(ctx)
      if (importers === undefined) continue
      if (importers.size > 0 || manager.manifestImporters === undefined) return { importers, file }
      const text = await Bun.file(path.join(ctx.workspaceRoot, file)).text()
      const named = await manager.manifestImporters(text, ctx.workspaceRoot, manifest)
      return named === undefined ? { importers, file } : { importers: named, file: undefined }
    }
    await refuseUnreadable(ctx.workspaceRoot)
    return undefined
  }
  const importersOf = async (
    ctx: { readonly workspaceRoot: string; readonly cacheDir: string },
    manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  ): Promise<ReadonlyMap<string, LockfileImporter> | undefined> =>
    (await readImporters(ctx, manifest))?.importers
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
      // A settings file lays out every project's install: every project,
      // unless all that moved is what the lockfile records per project.
      affected: (change, ctx) => {
        const claim = claimsAt(ctx.workspaceRoot, true).find((c) => c.file === change.file)?.claim
        if (claim !== undefined) return claim.fingerprint.affected(change, ctx)
        // An added or removed file moves every install.
        const folded = (bytes: Uint8Array | null): string | undefined =>
          bytes === null
            ? undefined
            : manager.settingsText?.(change.file, new TextDecoder().decode(bytes))
        const before = folded(change.before)
        return before !== undefined && before === folded(change.after) ? [] : undefined
      },
      // The files the key hashes, so read with the root: `--affected` asks
      // about every changed path, and a classic `link:` to a workspace
      // named without it widened an edit under that workspace to all.
      extraFiles: (file, bytes, ctx) =>
        extraFiles !== undefined && (manager.files as readonly string[]).includes(file)
          ? guardedFor(file)((t: string) => extraFiles(t, ctx.workspaceRoot))(
              new TextDecoder().decode(bytes),
            )
          : [],
    },
    async key(task, ctx) {
      let settings = settingsPerRun.get(ctx)
      if (settings === undefined) {
        settings = readSettings(ctx.workspaceRoot, manager.settings, manager.settingsText)
        settingsPerRun.set(ctx, settings)
      }
      let deps: Readonly<Record<string, string>> | undefined
      for (const { claim } of claimsAt(ctx.workspaceRoot)) {
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
      const manifest = manifestReader(ctx.workspaceRoot, manager.jsoncManifests === true)
      // The staleness check's walk overlaps the lockfile read.
      const dirs = workspaceGlobs(ctx.workspaceRoot, manager.name, manifest).then((globs) =>
        workspaceDirs(ctx.workspaceRoot, globs, manager.skippedDirs),
      )
      dirs.catch(() => {})
      const read = await readImporters(ctx, manifest)
      if (read === undefined) {
        // Core's word for the edges this leaves out names the plugin, not the file.
        ctx.warn(
          `[vx] ${manager.name}(): no ${manager.files.join(' or ')} in ${ctx.workspaceRoot} — run \`${manager.name} install\`; until then it orders and keys no package's dependencies`,
        )
        return []
      }
      const { file } = read
      let { importers } = read
      // A lockfile older than the manifests drops edges: a workspace it does
      // not list yet (a renamed folder, lerna's 31 added Nx projects) is
      // named by its path with none, and a dependency added to package.json
      // before the install orders nothing. Either ran a package beside what
      // it builds on and hit with old content (Growth, 2026-10-16), so the
      // lock refuses until the install, as a key from a stale lockfile names
      // an install that is not on disk.
      if (file !== undefined) {
        const text = await Bun.file(path.join(ctx.workspaceRoot, file)).text()
        const linksUnrecorded = manager.linksUnrecorded?.(text) === true
        if (linksUnrecorded)
          importers = await withManifestLinks(ctx.workspaceRoot, importers, manifest)
        const missing = await staleness(
          ctx.workspaceRoot,
          importers,
          await recordedOnce(ctx.cacheDir, file, text, manager.recorded),
          await dirs,
          manifest,
          manager.member,
          linksUnrecorded,
          manager.unrecorded?.(text),
        )
        if (missing.length > 0) {
          // pnpm then writes a lockfile per package, and the root's lists
          // only `.`: the install changes nothing, so it is not the fix.
          // Core claims root files only, so a package's own is not read.
          const workspaces = await dirs
          if (
            manager.name === 'pnpm' &&
            workspaces.length > 0 &&
            !workspaces.some((d) => importers.has(d)) &&
            !pnpmSettings().sharedWorkspaceLockfile(
              await textOrNull(path.join(ctx.workspaceRoot, 'pnpm-workspace.yaml')),
              await textOrNull(path.join(ctx.workspaceRoot, '.npmrc')),
            )
          ) {
            throw new UserError(
              `${file} lists no workspace package: shared-workspace-lockfile is false, so pnpm writes a pnpm-lock.yaml per package, which pnpm() does not read — remove the setting and run \`pnpm install\``,
            )
          }
          throw new UserError(
            `${file} is out of date: it does not list ${listed(missing)} — run \`${manager.name} install\``,
          )
        }
      }
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
        importers = importersOf(
          ctx,
          manifestReader(ctx.workspaceRoot, manager.jsoncManifests === true),
        )
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

/**
 * The dependency names each importer records, kept per lockfile content:
 * parsing them (pnpm's importers block, ~2 ms on solid, and the parser's
 * load) was on every run, and only the lockfile text decides them.
 */
async function recordedOnce(
  cacheDir: string,
  file: string,
  text: string,
  recorded: (text: string) => ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const hash = `${RECORDED_VERSION}:${Bun.hash.xxHash3(text).toString(16)}`
  const memo = path.join(cacheDir, 'lockfile-claims', `${file}.recorded.json`)
  try {
    const kept = (await Bun.file(memo).json()) as { hash: string; names: Record<string, string[]> }
    if (kept.hash === hash) {
      return new Map(Object.entries(kept.names).map(([i, names]) => [i, new Set(names)]))
    }
  } catch {
    // None kept, or unreadable: parsed below.
  }
  const out = new Map([...recorded(text)].map(([i, deps]) => [i, new Set(deps.keys())]))
  const names = Object.fromEntries([...out].map(([i, set]) => [i, [...set]]))
  // Write-then-rename, so a concurrent run reads a whole memo or none. The
  // memo is a speed-up: a failed write costs the next run a parse.
  const tmp = `${memo}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(path.dirname(memo), { recursive: true })
    await Bun.write(tmp, JSON.stringify({ hash, names }))
    await rename(tmp, memo)
  } catch {
    // Left behind, one more temp file piled up in the cache every run.
    await rm(tmp, { force: true }).catch(() => {})
  }
  return out
}

/** Bumped when what `recorded` returns for the same text changes. */
const RECORDED_VERSION = 1

/** Up to five names, then a count of the rest. */
function listed(names: readonly string[]): string {
  return names.length <= 5
    ? names.join(', ')
    : `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`
}

/** Each present settings file's content hash, by name. */
async function readSettings(
  workspaceRoot: string,
  files: readonly string[],
  settingsText?: (file: string, text: string) => string | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const file of files) {
    let bytes: Uint8Array
    try {
      bytes = await Bun.file(path.join(workspaceRoot, file)).bytes()
    } catch (err) {
      // Only an absent file is absent: one there but unreadable (EACCES,
      // a directory) folded as none, and the key named no setting at all.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new UserError(
        `${file}: cannot be read (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    const text = settingsText?.(file, new TextDecoder().decode(bytes))
    out[file] = Bun.hash
      .xxHash3(text ?? bytes)
      .toString(16)
      .padStart(16, '0')
  }
  return out
}

async function textOrNull(file: string): Promise<string | null> {
  try {
    return await Bun.file(file).text()
  } catch {
    return null
  }
}

/** The lockfile's importer path for a project directory: `.` for the root, POSIX otherwise. */
function importerOf(workspaceRoot: string, dir: string): string {
  return path.relative(workspaceRoot, dir).split(path.sep).join('/') || '.'
}

/**
 * An importer's `package.json`, or null where it has none. One that does
 * not parse refuses, named: read as none, a conflicted manifest lost its
 * dependencies and its dependents hit with old bytes (Turbo and Nx refuse).
 */
async function manifestOf(
  root: string,
  dir: string,
  jsonc: boolean,
): Promise<Record<string, unknown> | null> {
  const file = path.join(dir, 'package.json')
  const name = path.relative(root, file).split(path.sep).join('/')
  let text: string
  try {
    text = await Bun.file(file).text()
  } catch (err) {
    // As readSettings: one there but unreadable read as none, and its
    // workspace globs and names dropped out of the staleness check. A
    // lockfile importer whose directory is now a file has none either.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new UserError(
      `${name}: cannot be read (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (CONFLICT.test(text))
    throw new UserError(`${name}: holds git merge conflict markers — resolve them`)
  let pkg: unknown
  try {
    pkg = jsonc ? Bun.JSONC.parse(text) : JSON.parse(text)
  } catch (err) {
    throw new UserError(`${name}: not JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new UserError(`${name}: not a JSON object`)
  }
  return pkg as Record<string, unknown>
}

/** `manifestOf`, each directory read once. */
function manifestReader(
  root: string,
  jsonc: boolean,
): (dir: string) => Promise<Record<string, unknown> | null> {
  const read = new Map<string, Promise<Record<string, unknown> | null>>()
  return (dir) => {
    let pkg = read.get(dir)
    if (pkg === undefined) {
      pkg = manifestOf(root, dir, jsonc)
      read.set(dir, pkg)
    }
    return pkg
  }
}

/**
 * Whether the root `package.json` `workspaces` globs name `dir` as Yarn 1
 * reads them: it takes no `!` glob and links the directory anyway (`yarn
 * workspaces info` lists it, 1.22), as `manifestImporters` reads them.
 * Honoured here, the excluded workspace's content, its build output
 * included, re-keyed every task.
 */
function isClassicWorkspace(root: string, dir: string): boolean {
  let pkg: Record<string, unknown> | null
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return false
  }
  const globs = globsOf(pkg).filter((p): p is string => typeof p === 'string')
  const glob = (p: string): Bun.Glob => new Bun.Glob(p.replace(/^\.\//, '').replace(/\/+$/, ''))
  return (
    !dir.split('/').includes('node_modules') &&
    globs.some((p) => !p.startsWith('!') && glob(p).match(dir))
  )
}

/** A root manifest's `workspaces` globs: an array, or Yarn 1's `{ packages }`. */
function globsOf(pkg: Record<string, unknown> | null): readonly unknown[] {
  const field = pkg?.['workspaces']
  const list = Array.isArray(field)
    ? field
    : field !== null && typeof field === 'object'
      ? (field as Record<string, unknown>)['packages']
      : undefined
  return Array.isArray(list) ? list : []
}

/** The workspace globs the manager reads: pnpm's from pnpm-workspace.yaml, the others' from package.json. */
async function workspaceGlobs(
  root: string,
  manager: string,
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
): Promise<readonly unknown[]> {
  if (manager !== 'pnpm') return globsOf(await manifest(root))
  let text: string
  try {
    text = await Bun.file(path.join(root, 'pnpm-workspace.yaml')).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  // Read as no globs, an unparsable one turned the staleness check off,
  // as a package.json that does not parse would (manifestOf refuses it).
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch (err) {
    throw new UserError(
      `pnpm-workspace.yaml: not YAML (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  const list =
    doc !== null && typeof doc === 'object'
      ? (doc as Record<string, unknown>)['packages']
      : undefined
  return Array.isArray(list) ? list : []
}

/**
 * The directories the globs name that hold a `package.json`, root-relative
 * POSIX, sorted; none a `!` glob excludes, none under a `skipped` dir.
 */
async function workspaceDirs(
  root: string,
  globs: readonly unknown[],
  skipped: readonly string[] = ['node_modules'],
): Promise<string[]> {
  const strip = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '')
  const excluded = globs
    .filter((p): p is string => typeof p === 'string' && p.startsWith('!'))
    // Matched as the manager does, over `<glob>/package.json`: a `**`
    // ending a negated glob matches zero directories, so `!**/fixtures/**`
    // leaves out `packages/fixtures` itself, as pnpm and npm install it.
    .map((p) => new Bun.Glob(`${strip(p.slice(1))}/package.json`))
  const dirs = new Set<string>()
  for (const pattern of globs) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue
    const glob = new Bun.Glob(`${strip(pattern)}/package.json`)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const dir = path.dirname(file).split(path.sep).join('/')
      if (dir === '.' || dir.split('/').some((seg) => skipped.includes(seg))) continue
      if (!excluded.some((g) => g.match(`${dir}/package.json`))) dirs.add(dir)
    }
  }
  return [...dirs].sort()
}

/**
 * What the manifests name that the lockfile does not: each workspace the
 * manager lists (`member`) that it lists no importer for, and each importer's dependency (any field but
 * peers, which a manager may leave out) on a workspace package's name that
 * it records no entry for.
 */
async function staleness(
  root: string,
  importers: ReadonlyMap<string, LockfileImporter>,
  recorded: ReadonlyMap<string, ReadonlySet<string>>,
  dirs: readonly string[],
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  member: ((pkg: Record<string, unknown>) => boolean) | undefined,
  linksUnrecorded: boolean,
  unrecorded?: (name: string, pkg: Record<string, unknown>) => boolean,
): Promise<string[]> {
  const dirOf = (importer: string): string => (importer === '.' ? root : path.join(root, importer))
  const missing: string[] = []
  const names = new Set<string>()
  const all = new Set([...importers.keys(), ...dirs])
  // Read at once, then visited in order: the first unparsable one still
  // names the refusal.
  await Promise.allSettled([...all].map((d) => manifest(dirOf(d))))
  for (const d of all) {
    const n = (await manifest(dirOf(d)))?.['name']
    if (typeof n === 'string') names.add(n)
  }
  for (const d of dirs) {
    if (importers.has(d)) continue
    const pkg = await manifest(dirOf(d))
    if (pkg === null || member?.(pkg) !== false) missing.push(`the workspace ${d}`)
  }
  for (const [importer, deps] of recorded) {
    const pkg = await manifest(dirOf(importer))
    if (pkg === null) continue
    const own = pkg['name']
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const declared = pkg[field]
      if (declared === null || typeof declared !== 'object') continue
      for (const [name, spec] of Object.entries(declared)) {
        if (linksUnrecorded && typeof spec === 'string' && spec.startsWith('link:')) continue
        if (unrecorded?.(name, pkg) === true) continue
        if (name !== own && names.has(name) && !deps.has(name)) {
          missing.push(`${importer}'s dependency on ${name}`)
        }
      }
    }
  }
  return [...new Set(missing)]
}

/**
 * The importers with each one's `link:` dependencies on another importer
 * added from its manifest, for a lockfile that leaves them out.
 */
async function withManifestLinks(
  root: string,
  importers: ReadonlyMap<string, LockfileImporter>,
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
): Promise<ReadonlyMap<string, LockfileImporter>> {
  const out = new Map<string, LockfileImporter>()
  for (const [importer, links] of importers) {
    const pkg = await manifest(importer === '.' ? root : path.join(root, importer))
    const deps: Record<string, string> = { ...links.deps }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const declared = pkg?.[field]
      if (declared === null || typeof declared !== 'object') continue
      for (const [name, spec] of Object.entries(declared)) {
        if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
        const target = path
          .relative(root, path.resolve(root, importer, spec.slice('link:'.length)))
          .split(path.sep)
          .join('/')
        if (target !== importer && importers.has(target || '.')) deps[name] = target || '.'
      }
    }
    out.set(importer, { ...links, deps })
  }
  return out
}

/**
 * One entry per importer with a `package.json` (core reads none): a
 * directory that is no project yet becomes one, the root aside, which is
 * a project only by its own vx config, as it was a member only by one
 * (D-39). Its name is the
 * manifest's `name` when no other importer shares it (core refuses two
 * projects of one name, so a shared one names neither); its `deps` the
 * importers it installs, its peers on importers, and the importers the root
 * installs. A peer or root-installed importer orders a build unless it
 * would close a cycle through the order edges, then it is `reach` only, in
 * name order so the edge kept is stable.
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
  // Installed at the root `node_modules`, so every project resolves it
  // whatever its own manifest declares (Turbo #8364, #8465).
  const rootLinked = Object.values(importers.get('.')?.deps ?? {}).filter(
    (t) => t !== '.' && manifests.has(t),
  )
  const order = new Map<string, Set<string>>()
  const peers = new Map<string, Set<string>>()
  for (const [i, links] of importers) {
    if (!manifests.has(i)) continue
    const own = new Set<string>()
    const peer = new Set<string>(i === '.' ? [] : rootLinked.filter((t) => t !== i))
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

/** A file's text, undefined when it cannot be read. Sync: the digest seam is. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}
