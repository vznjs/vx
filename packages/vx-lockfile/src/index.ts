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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
const pnpmBlocks = (): typeof import('./pnpm-blocks.js') => load('./pnpm-blocks.js')
const pnpmSettings = (): typeof import('./pnpm-settings.js') => load('./pnpm-settings.js')
const yarnSettings = (): typeof import('./yarn-settings.js') => load('./yarn-settings.js')
const installCheck = (): typeof import('./installed.js') => load('./installed.js')

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

/** `recorded`'s entry for `stalenessFacts`: no importer path is `\0`. */
const FACTS = '\0'

/** Bumps when a digest folds differently or the memo holds more (its identity). */
const DIGEST_VERSION = 26

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
  /** `root`: the workspace root; `affected`: `--affected` asks, not the key. */
  readonly extraFiles?: (text: string, root: string, affected: boolean) => readonly string[]
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
  /**
   * What the staleness check reads from the file beside the recorded
   * names, memoised with them: `links` when the file leaves out every
   * `link:` dependency (pnpm's `excludeLinksFromLockfile`), so the
   * manifests name them, and `optional:<i>:<pattern>` per pattern
   * `unrecorded` matches.
   */
  readonly stalenessFacts?: (text: string) => readonly string[]
  /**
   * A manifest dependency the install leaves out of the file by design, so
   * its absence is no stale lockfile: `patterns` from `stalenessFacts`.
   */
  readonly unrecorded?: (
    patterns: readonly string[],
  ) => (name: string, pkg: Record<string, unknown>) => boolean
  /** The manager reads package.json as JSONC (trailing commas, comments): bun does. */
  readonly jsoncManifests?: true
  /** The file names a manifest may have (default `package.json` alone). */
  readonly manifests?: readonly [string, ...string[]]
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
// The install check's parse of the lockfile: the claim's, when it parsed this text.
const PARSE: Readonly<Record<string, (t: string) => unknown>> = {
  pnpm: pnpmParse,
  bun: bunParse,
  npm: npmParse,
  yarn: yarnParse,
}

const MANAGERS = {
  pnpm: {
    name: 'pnpm',
    files: ['pnpm-lock.yaml'],
    // The working tree's linker on both sides of an `--affected` diff: a
    // changed one is a settings change, which selects every project.
    digest: (t, files, root) =>
      pnpmLock().importerDigests(
        pnpmParse(t),
        files,
        pnpmSettings().hoistedLinker(
          readText(path.join(root, 'pnpm-workspace.yaml')),
          readText(path.join(root, '.npmrc')),
        ),
      ),
    importers: (t) => pnpmLock().importerLinks(pnpmParse(t)),
    extraFiles: (t, root) => [
      ...pnpmLock().fileDeps(pnpmParse(t)),
      ...pnpmLock().manifestLinks(pnpmParse(t), root),
    ],
    recorded: (t) => pnpmLock().recordedImporters(t),
    // pnpm's walk skips bower_components as it does node_modules (pnpm 10).
    skippedDirs: ['node_modules', 'bower_components'],
    // The root manifest for its `pnpm` field: pnpm reads install
    // settings there that the lockfile does not record.
    settings: ['pnpm-workspace.yaml', '.npmrc', 'package.json', 'package.json5', 'package.yaml'],
    settingsText: (file, text) =>
      file === 'pnpm-workspace.yaml'
        ? pnpmSettings().workspaceSettings(text)
        : file.startsWith('package.')
          ? pnpmSettings().packageSettings(text, file)
          : undefined,
    // pnpm reads a package.json5 or package.yaml where there is no
    // package.json, and records its dependencies like any other's.
    manifests: ['package.json', 'package.json5', 'package.yaml'],
    peersInManifest: true,
    // Read from their blocks alone, without the parser, and memoised with
    // the recorded names: a warm run read and searched the text for them.
    stalenessFacts: (t) => pnpmBlocks().stalenessFacts(t),
    unrecorded: (patterns) => pnpmBlocks().ignoredOptional(patterns),
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
      // Root `resolutions` Yarn 4 records on no entry: the edges they add.
      const resolutions =
        lock.generation === 'berry'
          ? yarnLock().resolutionsOf(readText(path.join(root, 'package.json')))
          : []
      return yarnLock().importerDigests(lock, files, yarnLock().packageExtensions(rc), resolutions)
    },
    importers: (t) => yarnLock().importerLinks(yarnParse(t)),
    extraFiles: (t, root, affected) => {
      // Classic keys a `link:` to a workspace like any linked directory,
      // and records no workspace to tell them apart. Yarn 1 links the
      // workspace itself (an edge, from the manifests), and its content
      // folded into the one digest every task folds re-keyed the whole
      // repo on each edit under it, its own build output included. A
      // `file:` one is a copy, so its content stays.
      // Berry's file names its workspaces, and contentDirs reads them there.
      const lock = yarnParse(t)
      const linked =
        affected || lock.generation !== 'classic'
          ? undefined
          : (d: string) => isClassicWorkspace(root, d)
      const deps = yarnLock().fileDeps(lock, linked)
      return lock.generation === 'classic' ? [...deps, ...classicManifests(root)] : deps
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
    // The root package.json for `workspaces.nohoist`, `installConfig`,
    // `resolutions` and its dependency ranges, which lay the install out
    // and the lockfile does not record (yarn-settings.ts).
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
  const manifests = manager.manifests ?? ['package.json']
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
      // digestVersion hashes this package's source: the guarded wrappers'
      // text is the same for every manager, and differs between a source
      // load and the config's bytecode bundle.
      identity: `@vzn/vx-lockfile/${manager.name}@${digestVersion()}`,
      scope,
      importers: guarded((text: string) => manager.importers(text)),
      recorded: guarded((text: string) => {
        const recorded = new Map<string, readonly string[]>(
          [...manager.recorded(text)].map(([i, deps]) => [i, [...deps.keys()]]),
        )
        if (manager.stalenessFacts !== undefined) recorded.set(FACTS, manager.stalenessFacts(text))
        return recorded
      }),
      // Read before `digest` on the key path: a malformed bun.lock refused
      // there as a bare "JSONC Parse error", no file named (fuzzed, L-16).
      ...(extraFiles !== undefined
        ? { extraFiles: guarded((text: string) => extraFiles(text, root, affected)) }
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
  const installedPerRun = new WeakMap<object, Promise<void>>()
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
      // A settings file folds into every key alike: nothing per project.
      digests: (file, ctx) =>
        claimsAt(ctx.workspaceRoot)
          .find((c) => c.file === file)
          ?.claim.fingerprint.digests?.(file, ctx),
      // The files the key hashes, so the key's own claim answers, from its
      // memo when it holds these bytes: `--affected` asks about every
      // changed path, and a classic `link:` to a workspace named without
      // the root widened an edit under that workspace to all.
      extraFiles: async (file, bytes, ctx) =>
        (await claimsAt(ctx.workspaceRoot)
          .find((c) => c.file === file)
          ?.claim.fingerprint.extraFiles?.(file, bytes, ctx)) ?? [],
    },
    async key(task, ctx) {
      let settings = settingsPerRun.get(ctx)
      if (settings === undefined) {
        settings = readSettings(ctx.workspaceRoot, manager.settings, manager.settingsText)
        // Awaited only after the lockfile's key: a rejection before then (a
        // refused key, a key slower than the read) was unhandled, and vx
        // exits 1 on one. Every key still awaits it below.
        settings.catch(() => {})
        settingsPerRun.set(ctx, settings)
      }
      let deps: Readonly<Record<string, string>> | undefined
      for (const { file, claim } of claimsAt(ctx.workspaceRoot)) {
        deps = await claim.key(task, ctx)
        if (deps === undefined) continue
        // A key from this lockfile names its install: refused, once per run,
        // while node_modules holds another (installed.ts).
        let installed = installedPerRun.get(ctx)
        if (installed === undefined) {
          installed = Promise.resolve().then(() =>
            installCheck().checkInstalled(
              manager.name,
              ctx.workspaceRoot,
              ctx.cacheDir,
              file,
              digestVersion(),
              PARSE[manager.name]!,
            ),
          )
          installedPerRun.set(ctx, installed)
        }
        await installed
        break
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
      const manifest = manifestReader(ctx.workspaceRoot, manifests, manager.jsoncManifests === true)
      // The staleness check's walk overlaps the lockfile read.
      const dirs = workspaceGlobs(ctx.workspaceRoot, manager.name, manifest).then((globs) =>
        workspaceDirs(ctx.workspaceRoot, globs, manager.skippedDirs, manifests),
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
        const recorded = new Map(
          await claimsAt(ctx.workspaceRoot)
            .find((c) => c.file === file)!
            .claim.recorded(ctx),
        )
        const facts = [...(recorded.get(FACTS) ?? [])]
        recorded.delete(FACTS)
        const linksUnrecorded = facts.includes('links')
        if (linksUnrecorded)
          importers = await withManifestLinks(ctx.workspaceRoot, importers, manifest)
        const optional = facts
          .filter((f) => f.startsWith('optional:'))
          .map((f) => f.slice(f.indexOf(':', 9) + 1))
        const missing = await staleness(
          ctx.workspaceRoot,
          importers,
          recorded,
          await dirs,
          manifest,
          manager.member,
          linksUnrecorded,
          optional.length > 0 ? manager.unrecorded?.(optional) : undefined,
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
        // The other way round: a workspace deleted while another still
        // depends on it fails the install, which leaves the lockfile as it
        // was, and its edge went with its manifest without a word.
        const gone = await departed(ctx.workspaceRoot, importers, manifest)
        if (gone.length > 0) {
          throw new UserError(
            `${file} is out of date: ${listed(gone)} — remove the dependency and run \`${manager.name} install\``,
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
        new Set(ctx.projects.map((p) => importerOf(ctx.workspaceRoot, p.dir))),
      )
    },
    async project(config, ctx) {
      let importers = perRun.get(ctx.projects)
      if (importers === undefined) {
        importers = importersOf(
          ctx,
          manifestReader(ctx.workspaceRoot, manifests, manager.jsoncManifests === true),
        )
        perRun.set(ctx.projects, importers)
      }
      if ((await importers)?.has(importerOf(ctx.workspaceRoot, ctx.dir)) !== true) return
      // A stat per project, and only where a manifest may have another name.
      const file =
        manifests.length === 1
          ? manifests[0]
          : (manifests.find((f) => existsSync(path.join(ctx.dir, f))) ?? manifests[0])
      const tasks = config.tasks ?? {}
      for (const [name, task] of Object.entries(tasks)) {
        const inputs = task.inputs
        if (inputs === undefined || inputs.files.includes(file)) continue
        // A copy: a loaded config may be shared or frozen.
        tasks[name] = {
          ...task,
          inputs: { ...inputs, files: [...inputs.files, file] },
        }
      }
    },
  })
}

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
 * Whether a manifest name may be there, on a stat: a read of one that is
 * not rejects with an error built for it (~65 µs), and pnpm tries three
 * names per package, so each run built two per package (vueuse: 26, ~1.7
 * ms of its no-op). Any answer but no entry goes on to the read, which
 * refuses an unreadable one.
 */
function present(file: string): boolean {
  try {
    return statSync(file, { throwIfNoEntry: false }) !== undefined
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOTDIR'
  }
}

/**
 * An importer's manifest (the one of `names` present), or null where it
 * has none. One that does not parse refuses, named: read as none, a
 * conflicted manifest lost its dependencies and its dependents hit with
 * old bytes (Turbo and Nx refuse). So do two in one directory: pnpm 10.28
 * lists such a package by its package.json and installs the package.yaml's
 * dependencies.
 */
async function manifestOf(
  root: string,
  dir: string,
  names: readonly string[],
  jsonc: boolean,
): Promise<Record<string, unknown> | null> {
  const found: { name: string; text: string }[] = []
  for (const base of names) {
    const file = path.join(dir, base)
    if (!present(file)) continue
    const name = path.relative(root, file).split(path.sep).join('/')
    try {
      found.push({ name, text: await Bun.file(file).text() })
    } catch (err) {
      // As readSettings: one there but unreadable read as none, and its
      // workspace globs and names dropped out of the staleness check. A
      // lockfile importer whose directory is now a file has none either.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw new UserError(
        `${name}: cannot be read (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  if (found.length === 0) return null
  if (found.length > 1) {
    const rel = path.relative(root, dir).split(path.sep).join('/') || '.'
    const bases = found.map((f) => path.posix.basename(f.name))
    throw new UserError(
      `${rel}: holds ${bases.slice(0, -1).join(', ')} and ${bases.at(-1)}, two manifests — keep one`,
    )
  }
  const { name, text } = found[0]!
  if (CONFLICT.test(text))
    throw new UserError(`${name}: holds git merge conflict markers — resolve them`)
  const [kind, parse]: [string, (t: string) => unknown] = name.endsWith('.yaml')
    ? ['YAML', (t) => Bun.YAML.parse(t)]
    : name.endsWith('.json5')
      ? ['JSON5', (t) => Bun.JSON5.parse(t)]
      : ['JSON', (t) => (jsonc ? Bun.JSONC.parse(t) : JSON.parse(t))]
  let pkg: unknown
  try {
    pkg = parse(text)
  } catch (err) {
    throw new UserError(
      `${name}: not ${kind} (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new UserError(`${name}: not a ${kind === 'YAML' ? 'YAML mapping' : `${kind} object`}`)
  }
  return pkg as Record<string, unknown>
}

/** `manifestOf`, each directory read once. */
function manifestReader(
  root: string,
  names: readonly string[],
  jsonc: boolean,
): (dir: string) => Promise<Record<string, unknown> | null> {
  const read = new Map<string, Promise<Record<string, unknown> | null>>()
  return (dir) => {
    let pkg = read.get(dir)
    if (pkg === undefined) {
      pkg = manifestOf(root, dir, names, jsonc)
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

/**
 * Each Yarn 1 workspace's `package.json`, root-relative: what the one
 * classic digest folds, since yarn.lock records no workspace's ranges.
 * Yarn 1 takes no `!` glob: it links the directory anyway.
 */
function classicManifests(root: string): string[] {
  let pkg: Record<string, unknown> | null
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const pattern of globsOf(pkg)) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue
    const glob = new Bun.Glob(`${pattern.replace(/^\.\//, '').replace(/\/+$/, '')}/package.json`)
    for (const file of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const rel = file.split(path.sep).join('/')
      if (rel !== 'package.json' && !rel.split('/').includes('node_modules')) out.add(rel)
    }
  }
  return [...out].sort()
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
 * The directories the globs name that hold a manifest (one of `names`),
 * root-relative POSIX, sorted; none a `!` glob excludes, none under a
 * `skipped` dir.
 */
async function workspaceDirs(
  root: string,
  globs: readonly unknown[],
  skipped: readonly string[] = ['node_modules'],
  names: readonly string[] = ['package.json'],
): Promise<string[]> {
  const manifest = names.length === 1 ? names[0] : `{${names.join(',')}}`
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
    const glob = new Bun.Glob(`${strip(pattern)}/${manifest}`)
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
 * Each importer's dependency, as its manifest still declares it, that the
 * lockfile resolves to an importer whose manifest is gone, unless another
 * workspace on disk carries the name (a moved one, which `staleness` names).
 */
async function departed(
  root: string,
  importers: ReadonlyMap<string, LockfileImporter>,
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
): Promise<string[]> {
  const dirOf = (importer: string): string => (importer === '.' ? root : path.join(root, importer))
  const names = new Set<string>()
  for (const d of importers.keys()) {
    const n = (await manifest(dirOf(d)))?.['name']
    if (typeof n === 'string') names.add(n)
  }
  const gone: string[] = []
  for (const [importer, { deps }] of importers) {
    const pkg = await manifest(dirOf(importer))
    if (pkg === null) continue
    for (const [name, target] of Object.entries(deps)) {
      if (names.has(name) || (await manifest(dirOf(target))) !== null) continue
      const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => {
        const deps = pkg[field]
        return deps !== null && typeof deps === 'object' && Object.hasOwn(deps, name)
      })
      if (declared) {
        gone.push(`${importer} depends on the workspace ${name} (${target}), which is not on disk`)
      }
    }
  }
  return gone
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
 * importers it installs, its peers on importers, the importers its packages
 * install, and the importers the root installs. A peer, package-installed
 * or root-installed importer orders a build unless it would close a cycle
 * through the order edges, then it is `reach` only, in name order so the
 * edge kept is stable. An edge to an importer with no manifest stands when
 * core already has a project there (`projects`, importer paths): a sparse
 * checkout left it out, and its dependants must not run or key without it.
 */
async function discovered(
  root: string,
  importers: ReadonlyMap<string, LockfileImporter>,
  peersInManifest: boolean,
  rootIsProject: boolean,
  manifest: (dir: string) => Promise<Record<string, unknown> | null>,
  projects: ReadonlySet<string>,
): Promise<DiscoveredProject[]> {
  const dirOf = (importer: string): string => (importer === '.' ? root : path.join(root, importer))
  const read = await Promise.all(
    [...importers.keys()]
      .filter((i) => i !== '.' || rootIsProject)
      .map(async (i) => [i, await manifest(dirOf(i))] as const),
  )
  const manifests = new Map<string, Record<string, unknown>>()
  for (const [i, pkg] of read) if (pkg !== null) manifests.set(i, pkg)
  const linked = (i: string): boolean => manifests.has(i) || projects.has(i)
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
    (t) => t !== '.' && linked(t),
  )
  const order = new Map<string, Set<string>>()
  const peers = new Map<string, Set<string>>()
  for (const [i, links] of importers) {
    if (!manifests.has(i)) continue
    const own = new Set<string>()
    const peer = new Set<string>(i === '.' ? [] : rootLinked.filter((t) => t !== i))
    const manifestPeers = peersInManifest ? manifestPeerNames(manifests.get(i)!) : undefined
    for (const [name, target] of Object.entries(links.deps)) {
      if (linked(target)) (manifestPeers?.has(name) === true ? peer : own).add(target)
    }
    for (const target of Object.values(links.peers)) if (linked(target)) peer.add(target)
    // Installed only through a package (a registry package's dependency on
    // a workspace): it orders like a peer, as nothing the importer's own
    // manifest declares puts the edge there.
    for (const target of links.transitive ?? []) if (linked(target)) peer.add(target)
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
