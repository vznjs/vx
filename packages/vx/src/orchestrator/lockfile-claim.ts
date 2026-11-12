// The claimant's shell: what every lockfile plugin needs around its
// parser, for any ecosystem's lockfile (`bun.lock`, `Cargo.lock`,
// `uv.lock`, `go.sum`). A plugin that keys each project on its own
// dependency closure claims the file (`VxPlugin.fingerprint`), folds one
// digest per project through `key`, and answers `--affected` by digesting
// both sides of a change. Only the parser differs per lockfile; the memo,
// the per-run gate, the fallback for a project the file does not list and
// the `--affected` diff are one implementation here.
//
// A run's key reads each project's digest from `.vx/dependencies.lock.json`
// (`KeyHookContext.locked`), never the file: only `vx lock` and
// `--affected` digest it, and a run whose extra file (a local path
// dependency, edited with no install) moved since the lock, as the record
// is stale for it then. What the `discover` and `project` stages read
// (the links, the recorded names) is memoised in cache.db
// (`lockfile_memos`, one row per lockfile and claimant) by the file's xxh3,
// so a warm run pays one read + hash + one row read, never a parse; within
// one process (a run, a watch cycle) the file's size, mtime, ctime and
// inode gate even the read. A run's read leaves the digests out (most of
// a parse), and `vx lock` adds them to the memo.

import path from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import {
  FILE_HASH_RACY_MS,
  racyWindowMs,
  type LockfileMemo,
  readLockfileMemo,
  writeLockfileMemo,
} from '../memo/index.js'
import { relPosix, UserError, xxh3, xxh3hex } from '../util/index.js'
import type { TaskNode } from '../graph/index.js'
import type {
  FingerprintChange,
  FingerprintClaim,
  FingerprintContext,
  KeyHookContext,
} from './plugin.js'

export interface LockfileClaimOptions<L = unknown> {
  /** The lockfile's name at the workspace root. */
  readonly file: string
  /**
   * Every workspace member's digest from the file's text: member directory
   * (root-relative POSIX, `.` for the root) → digest. Called once per
   * distinct content; must be deterministic and throw on a file it
   * cannot read (the plugin's name heads the error).
   */
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  /**
   * Root-relative files the lockfile names whose BYTES the install uses but
   * the lockfile does not pin (a patch file it names and records no hash
   * of). Their content hashes ('' when absent; unreadable refuses) reach
   * `digest` as `files` and join the memo's identity, so an edited patch
   * moves the key. A directory (a local path dependency) hashes every file
   * under it but `node_modules` and `.git`. Called only when the memo misses.
   */
  readonly extraFiles?: (text: string) => readonly string[]
  /** Folded into the memo's identity: bump when `digest` folds differently. */
  readonly version: number
  /**
   * Stands for the functions in the memo's identity in place of their
   * text, which is not stable: the same plugin loaded from source and
   * from the workspace config's bytecode bundle prints differently (the
   * compiled binary's loader writes `throw Error(`, the bundle `throw new
   * Error(`), so each switch would miss the memo and parse again. Give a value that changes
   * whenever the functions do, such as a hash of their source files; two
   * claimants of one file must not share it.
   */
  readonly identity?: string
  /**
   * `'project'` (default): each task folds its own project's digest.
   * `'workspace'`: the whole file's hash into every task — the coarse key.
   */
  readonly scope?: 'project' | 'workspace'
  /**
   * The key part's name, as `vx why` shows it under the plugin's name.
   * Default `'deps'`.
   */
  readonly part?: string
  /**
   * Each member's links to other members, from the same text, kept in the
   * memo beside the digests so a `discover` hook reads them without a
   * parse. Core stores each value as JSON and never reads it: its shape is
   * the plugin's. Called once per distinct content, under either scope.
   */
  readonly links?: (text: string) => ReadonlyMap<string, L>
  /**
   * Each member's recorded dependency names, from the same text, kept in
   * the memo so a staleness check reads them without a parse. Called once
   * per distinct content.
   */
  readonly recorded?: (text: string) => ReadonlyMap<string, readonly string[]>
}

/** What a lockfile plugin spreads into `definePlugin` (`fingerprint`, `key`), and `links` for its own stages. */
export interface LockfileClaimHooks<L = unknown> {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  /**
   * `links`' answer for the file as it is now, through the same memo
   * and gates as `key`; undefined when the file is absent. Not a hook: a
   * plugin calls it from its own `discover` or `project`.
   */
  links(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, L> | undefined>
  /** `recorded`'s answer for the file as it is now, as `links` reads it; undefined when the file is absent or `recorded` is unset. */
  recorded(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>
}

interface Digests<L> {
  /** xxh3 of the lockfile bytes and the extra files' hashes; '' when the file is absent. */
  readonly lock: string
  /** xxh3 of the lockfile bytes alone. */
  readonly bytes: string
  /** The extra files the digests read. */
  readonly extras: readonly string[]
  /** Each member's digest; undefined when the read that made this left them out. */
  readonly members: ReadonlyMap<string, string> | undefined
  readonly links: ReadonlyMap<string, L>
  readonly recorded: ReadonlyMap<string, ReadonlySet<string>> | undefined
}

/**
 * A root-relative extra file's content hash, '' when absent. A path above
 * the root is read too: a path dependency beside the checkout is what a
 * task reads, and left unread an edit in it would move no key. One
 * there but unreadable (EACCES, a symlink loop) refuses, as a settings file
 * does: folded as '', it keyed as no file at all.
 */
export function hashExtra(
  workspaceRoot: string,
  rel: string,
  hashes?: ExtraHashes,
): Promise<string> {
  const abs = path.resolve(workspaceRoot, rel)
  if (hashes === undefined) return hashOf(abs, rel)
  let held = hashes.get(abs)
  if (held === undefined) {
    held = hashOf(abs, rel)
    hashes.set(abs, held)
    // A refusal is the read's, never the memo's: the next ask reads again.
    held.catch(() => hashes.delete(abs))
  }
  return held
}

/**
 * One run's hash of each extra file, by absolute path: `--affected`, the
 * `discover` read and the key all ask for a path dependency's directory,
 * and each would walk and read all of it.
 * A run hashes before any task starts, so no task's write falls between.
 */
export type ExtraHashes = Map<string, Promise<string>>

const RUN_HASHES = Symbol('vx.extraHashes')

/** `ctx` carrying the run's `ExtraHashes`; a spread of it keeps them, so a claim reads them from the context a hook hands it. */
export function withExtraHashes<T extends object>(ctx: T, hashes: ExtraHashes | undefined): T {
  return hashes === undefined ? ctx : Object.assign(ctx, { [RUN_HASHES]: hashes })
}

/** The `ExtraHashes` `withExtraHashes` gave `ctx`; undefined for a context core did not make. */
export function extraHashesOf(ctx: object): ExtraHashes | undefined {
  return (ctx as { [RUN_HASHES]?: ExtraHashes })[RUN_HASHES]
}

async function hashOf(abs: string, rel: string): Promise<string> {
  try {
    return xxh3hex(await Bun.file(abs).bytes())
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR') return hashDir(abs)
    if (code === 'ENOENT' || code === 'ENOTDIR') return ''
    throw unreadable(rel, err)
  }
}

function unreadable(rel: string, err: unknown): UserError {
  return new UserError(
    `${rel}: cannot be read (${err instanceof Error ? err.message : String(err)})`,
  )
}

/**
 * Every file under `dir` but its `node_modules` and `.git`, as `rel\0hash`
 * lines in sorted order. Links are followed: a linked file is what a task
 * reads, and the scan skipped it, so an edit to its target moved no key.
 * The walk never enters `node_modules` or `.git`: a glob of `**` that
 * dropped them after would list every file under them. A linked directory
 * that is one of its own ancestors is not entered again.
 */
async function hashDir(dir: string): Promise<string> {
  const rels: string[] = []
  const walk = async (rel: string, real: string, ancestors: readonly string[]): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true })
    await Promise.all(
      entries.map(async (e) => {
        if (e.name === 'node_modules' || e.name === '.git') return
        const child = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isFile()) return void rels.push(child)
        if (e.isDirectory()) return walk(child, path.join(real, e.name), [...ancestors, real])
        // A link, or an entry the filesystem gave no type: what it names decides.
        const abs = path.join(dir, child)
        const st = await stat(abs).catch(() => undefined)
        if (st?.isFile()) rels.push(child)
        else if (st?.isDirectory()) {
          const target = await realpath(abs)
          if (target !== real && !ancestors.includes(target))
            await walk(child, target, [...ancestors, real])
        }
      }),
    )
  }
  await walk('', await realpath(dir), [])
  rels.sort()
  const lines = await Promise.all(
    rels.map(async (rel) => `${rel}\0${xxh3hex(await Bun.file(path.join(dir, rel)).bytes())}`),
  )
  return `dir\0${xxh3hex(lines.join('\n'))}`
}

/**
 * A file's identity for the in-process gate, as `LocalMemo.hashFile`'s memo
 * keys one: size and mtime alone kept the digests of a lockfile or patch
 * replaced by another of the same size with its mtime kept (`cp -p`,
 * `tar -x`), and no task sets a ctime. Given `readAt` (taken before the
 * read), a file changed within the racy window of it is recorded as `RACY`,
 * which no stat matches: on a file system that keeps whole seconds a
 * same-size rewrite later in the read's second kept every field, and the
 * next cycle of `vx watch` served the first bytes' digests.
 */
function identityOf(
  st: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
  readAt?: number,
): string {
  if (readAt !== undefined && st.ctimeMs >= readAt - racyWindowMs(st.ctimeMs, FILE_HASH_RACY_MS))
    return RACY
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
}

const RACY = 'racy'

// A directory's own stat moves only when an entry is added or removed, not
// when a file in it is edited: its identity is its content hash.
async function statsOf(
  workspaceRoot: string,
  rels: readonly string[],
  hashes: ExtraHashes | undefined,
  readAt?: number,
): Promise<string[]> {
  return Promise.all(
    rels.map((rel) =>
      stat(path.resolve(workspaceRoot, rel)).then(
        (st) => (st.isDirectory() ? hashExtra(workspaceRoot, rel, hashes) : identityOf(st, readAt)),
        () => 'gone',
      ),
    ),
  )
}

/** Each file's identity, taken BEFORE its hash, so a write between the two re-reads it. */
async function hashExtras(
  workspaceRoot: string,
  rels: readonly string[],
  run: ExtraHashes | undefined,
): Promise<{ hashes: Record<string, string>; stats: Record<string, string> }> {
  const ids = await statsOf(workspaceRoot, rels, run, Date.now())
  const stats = Object.fromEntries(rels.map((rel, i) => [rel, ids[i]!] as const))
  const hashes = Object.fromEntries(
    await Promise.all(
      rels.map(async (rel) => [rel, await hashExtra(workspaceRoot, rel, run)] as const),
    ),
  )
  return { hashes, stats }
}

export function lockfileClaim<L = unknown>(
  options: LockfileClaimOptions<L>,
): LockfileClaimHooks<L> {
  const { file, digest, version } = options
  const scope = options.scope ?? 'project'
  const part = options.part ?? 'deps'
  // `version` is one claimant's counter, and another claimant of the file
  // at the same number read this one's memo: one that named no extra file
  // left the other's patch edits out of its key. The functions'
  // source stands for the claimant, or the `identity` the plugin gives for
  // it; a rebuild that changes it is a miss.
  // The scope too: a workspace-scope memo holds no digests. The `links`
  // token keeps its old spelling, so the memo outlives the option's rename.
  const claimant = xxh3hex(
    [
      part,
      scope,
      ...(options.identity !== undefined
        ? [
            `identity:${options.identity}`,
            options.extraFiles === undefined ? '' : 'extraFiles',
            options.links === undefined ? '' : 'importers',
            options.recorded === undefined ? '' : 'recorded',
          ]
        : [
            String(digest),
            String(options.extraFiles ?? ''),
            String(options.links ?? ''),
            String(options.recorded ?? ''),
          ]),
    ].join('\0'),
  )
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(`scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`)
  }
  // Per workspace root: what the last read saw. Each file's identity gates
  // a re-read; the content hash decides whether the digests are current.
  const seen = new Map<
    string,
    {
      identity: string
      extras: readonly string[]
      extraStats: Readonly<Record<string, string>>
      digests: Digests<L>
      /** The memo a run found no index to keep in (a discover before the first run's open). */
      unsaved?: LockfileMemo
    }
  >()
  // Workspace scope with nothing else to keep has nothing a memo saves.
  const memoises =
    scope === 'project' || options.links !== undefined || options.recorded !== undefined
  const readMemo = (cacheDir: string, lock: string) => {
    const memo = readLockfileMemo(cacheDir, file, claimant)
    if (memo === undefined || memo.version !== version || memo.lock !== lock) return undefined
    return memo
  }
  // Per run: every `key` call of one run gets the same context object.
  const perRun = new WeakMap<object, Promise<Digests<L>>>()
  const lockedPerRun = new WeakMap<
    object,
    Promise<((dir: string) => string | undefined) | undefined>
  >()

  /** `withDigests`: each member's digest too, which only `vx lock` and `--affected` read. */
  const load = async (
    workspaceRoot: string,
    cacheDir: string,
    withDigests: boolean,
    run: ExtraHashes | undefined,
  ): Promise<Digests<L>> => {
    const full = path.join(workspaceRoot, file)
    let identity: string
    let stamped: string
    try {
      const readAt = Date.now()
      const st = await stat(full)
      identity = identityOf(st)
      stamped = identityOf(st, readAt)
    } catch {
      const digests: Digests<L> = {
        lock: '',
        bytes: '',
        extras: [],
        members: new Map(),
        links: new Map(),
        recorded: undefined,
      }
      seen.set(workspaceRoot, { identity: 'gone', extras: [], extraStats: {}, digests })
      return digests
    }
    const last = seen.get(workspaceRoot)
    if (
      last !== undefined &&
      last.identity === identity &&
      (!withDigests || last.digests.members !== undefined)
    ) {
      const now = await statsOf(workspaceRoot, last.extras, run)
      if (now.every((s, i) => s === last.extraStats[last.extras[i]!])) {
        if (last.unsaved !== undefined && writeLockfileMemo(cacheDir, file, claimant, last.unsaved))
          delete last.unsaved
        return last.digests
      }
    }
    const bytes = await Bun.file(full).bytes()
    const lockHash = xxh3hex(bytes)
    // The extra files the last digest read, and their hashes now: a warm run
    // re-hashes the files the memo names and never parses to learn them.
    // A memo no index could keep yet is this process's own, read again when
    // a racy identity sent the gate here over unchanged bytes.
    const kept = last?.unsaved?.lock === lockHash ? last.unsaved : undefined
    const memo = memoises ? (readMemo(cacheDir, lockHash) ?? kept) : undefined
    let extras: Record<string, string> = {}
    let extraStats: Record<string, string> = {}
    let members: ReadonlyMap<string, string> | undefined
    let links: ReadonlyMap<string, L> = new Map()
    let recorded: ReadonlyMap<string, readonly string[]> | undefined
    let unsaved: LockfileMemo | undefined
    let served = false
    if (memo !== undefined && (!withDigests || memo.importers !== null)) {
      const now = await hashExtras(workspaceRoot, Object.keys(memo.extras), run)
      if (Object.entries(memo.extras).every(([rel, h]) => now.hashes[rel] === h)) {
        served = true
        extras = memo.extras
        extraStats = now.stats
        members = memo.importers === null ? undefined : new Map(Object.entries(memo.importers))
        links = new Map(Object.entries(memo.edges as Record<string, L>))
        recorded = memo.recorded === undefined ? undefined : new Map(Object.entries(memo.recorded))
        if (memo === kept && !writeLockfileMemo(cacheDir, file, claimant, memo)) unsaved = memo
      }
    }
    if (!served) {
      const text = decode(bytes)
      const rels = [...new Set(options.extraFiles?.(text) ?? [])].sort()
      const now = await hashExtras(workspaceRoot, rels, run)
      extras = now.hashes
      extraStats = now.stats
      members =
        scope === 'workspace'
          ? new Map<string, string>()
          : withDigests
            ? digest(text, new Map(Object.entries(extras)))
            : undefined
      links = options.links?.(text) ?? new Map()
      recorded = options.recorded?.(text)
      if (memoises) {
        const kept: LockfileMemo = {
          version,
          lock: lockHash,
          extras,
          importers: members === undefined ? null : Object.fromEntries(members),
          edges: Object.fromEntries(links),
          ...(recorded !== undefined ? { recorded: Object.fromEntries(recorded) } : {}),
        }
        if (!writeLockfileMemo(cacheDir, file, claimant, kept)) unsaved = kept
      }
    }
    const rels = Object.keys(extras)
    const lock =
      rels.length === 0
        ? lockHash
        : xxh3hex([lockHash, ...rels.map((r) => `${r}\0${extras[r]}`)].join('\0'))
    const digests: Digests<L> = {
      lock,
      bytes: lockHash,
      extras: rels,
      members,
      links,
      recorded:
        recorded === undefined
          ? undefined
          : new Map([...recorded].map(([i, names]) => [i, new Set(names)])),
    }
    seen.set(workspaceRoot, {
      identity: stamped,
      extras: rels,
      extraStats,
      digests,
      ...(unsaved !== undefined ? { unsaved } : {}),
    })
    return digests
  }
  /**
   * Each project's digest for this run: the lock's, unless an extra file
   * it records moved since (then a digest of the file as it is now, as
   * `vx lock` would record it); undefined when the file is absent.
   */
  const lockedOnce = (
    ctx: KeyHookContext,
  ): Promise<((dir: string) => string | undefined) | undefined> => {
    let p = lockedPerRun.get(ctx)
    if (p === undefined) {
      p = (async () => {
        const rec = await ctx.locked(file)
        if (rec === undefined) return undefined
        const rels = Object.keys(rec.extras)
        const run = extraHashesOf(ctx)
        const now = await Promise.all(rels.map((rel) => hashExtra(ctx.workspaceRoot, rel, run)))
        if (now.every((h, i) => h === rec.extras[rels[i]!])) {
          return (dir: string) => rec.digest(dir)
        }
        const digests = await load(ctx.workspaceRoot, ctx.cacheDir, true, run)
        const members = digests.members!
        return (dir: string) => digestFor(members, memberOf(ctx.workspaceRoot, dir))
      })()
      lockedPerRun.set(ctx, p)
    }
    return p
  }
  const loadOnce = (ctx: KeyHookContext): Promise<Digests<L>> => {
    let p = perRun.get(ctx)
    if (p === undefined) {
      p = load(ctx.workspaceRoot, ctx.cacheDir, false, extraHashesOf(ctx))
      perRun.set(ctx, p)
    }
    return p
  }

  return {
    fingerprint: {
      files: [file],
      affected(change: FingerprintChange, ctx: FingerprintContext) {
        // One side absent: the file appeared or went — every project's
        // installed dependencies are in question.
        if (change.before === null || change.after === null) return undefined
        if (scope === 'workspace') return undefined
        // WHICH side failed is the whole difference between "your
        // lockfile is broken" and "the base commit's is" — a migration
        // commit hits the second, and the bare parser message names neither.
        // A changed extra file is folded by its content on each side; one
        // left out is the same on both, so it moves no digest either way.
        const extrasOf = (pick: 'before' | 'after'): Map<string, string> => {
          const out = new Map<string, string>()
          for (const [rel, sides] of change.extras ?? []) {
            const bytes = sides[pick]
            out.set(rel, bytes === null ? '' : xxh3hex(bytes))
          }
          return out
        }
        const sideOf = (
          bytes: Uint8Array,
          pick: 'before' | 'after',
          side: string,
        ): ReadonlyMap<string, string> => {
          try {
            return digest(decode(bytes), extrasOf(pick))
          } catch (err) {
            throw new Error(`${err instanceof Error ? err.message : String(err)} (${side})`)
          }
        }
        const before = sideOf(change.before, 'before', `as of the base ref`)
        const after = sideOf(change.after, 'after', `in the working tree`)
        const names: string[] = []
        for (const p of ctx.projects) {
          const member = memberOf(ctx.workspaceRoot, p.dir)
          if (digestFor(before, member) !== digestFor(after, member)) names.push(p.name)
        }
        return names
      },
      // What `vx lock` commits, so `--affected` reads the base's digests
      // instead of parsing the base's file.
      async digests(_file: string, ctx: FingerprintContext) {
        if (scope === 'workspace') return undefined
        const digests = await load(ctx.workspaceRoot, ctx.cacheDir, true, extraHashesOf(ctx))
        if (digests.lock === '') return undefined
        const members = digests.members!
        return {
          hash: digests.bytes,
          projects: Object.fromEntries(
            ctx.projects.map((p) => [
              p.name,
              digestFor(members, memberOf(ctx.workspaceRoot, p.dir)),
            ]),
          ),
          ...(digests.extras.length > 0 ? { extras: digests.extras } : {}),
        }
      },
      ...(options.extraFiles !== undefined
        ? {
            // The memo records which files these exact bytes name, for this
            // parser: `--affected` asks on every diff, and a cold parse of
            // a large lockfile was most of its selection's cost.
            async extraFiles(_file: string, bytes: Uint8Array, ctx: FingerprintContext) {
              const memo = memoises ? readMemo(ctx.cacheDir, xxh3hex(bytes)) : undefined
              return memo !== undefined
                ? Object.keys(memo.extras)
                : options.extraFiles!(decode(bytes))
            },
          }
        : {}),
    },
    async key(task, ctx) {
      if (scope === 'project') {
        const digestOf = await lockedOnce(ctx)
        const digest = digestOf?.(task.projectDir)
        return digest === undefined ? undefined : { [part]: digest }
      }
      const digests = await loadOnce(ctx)
      return digests.lock === '' ? undefined : { [part]: digests.lock }
    },
    async links(ctx) {
      const digests = await load(ctx.workspaceRoot, ctx.cacheDir, false, extraHashesOf(ctx))
      return digests.lock === '' ? undefined : digests.links
    },
    async recorded(ctx) {
      const digests = await load(ctx.workspaceRoot, ctx.cacheDir, false, extraHashesOf(ctx))
      return digests.lock === '' ? undefined : digests.recorded
    },
  }
}

/**
 * A project's digest: its own member's AND the root member's. The root's
 * dependencies reach every project (a workspace-wide tool, a shared
 * toolchain), so a root bump that moved only the root's digest would
 * replay the old tool's output. A project the lockfile has no member for
 * folds its nearest listed ancestor's, whose dependencies it resolves;
 * the root's alone would key it on no bump only that ancestor reached.
 * Outside every member it folds the root's alone; a file with neither
 * folds a constant, whose spelling is key material.
 */
function digestFor(members: ReadonlyMap<string, string>, member: string): string {
  let dir = member
  while (dir !== '.' && !members.has(dir)) {
    const slash = dir.lastIndexOf('/')
    dir = slash === -1 ? '.' : dir.slice(0, slash)
  }
  const own = members.get(dir)
  const root = members.get('.')
  if (own === undefined) return root ?? 'no-importer'
  if (root === undefined || dir === '.') return own
  return xxh3hex(`${own}\0${root}`)
}

/** The lockfile's member path for a project directory: `.` for the root, POSIX otherwise. */
function memberOf(workspaceRoot: string, projectDir: string): string {
  return relPosix(workspaceRoot, projectDir) || '.'
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// --- Reach digests -----------------------------------------------------------

/**
 * Each member of a cycle as what it is and where its edges land, by
 * colour refinement: a member starts as its material and the child
 * digests its edges leave the cycle for, then folds its in-cycle
 * targets' labels until no two labels part further. A lockfile may key
 * two copies of one version alike (installed at two places, each
 * resolving another version of a dependency), so by material alone two
 * members swapping copies, in the cycle or out of it, would move nothing. Two members left with
 * one label have the same material, reach the same children, and their
 * in-cycle edges land on labels alike to every depth. Telling such a pair
 * apart takes an isomorphism test; it needs a cycle where copies of one
 * version reach alike at every step, which no swap of what one reaches
 * produces.
 */
function cycleLabels(
  g: ReachGraph,
  members: readonly number[],
  childOf: (w: number) => string | undefined,
): string[] {
  let label = new Map<number, string>()
  for (const m of members) {
    const out = new Set<string>()
    for (const w of g.edges[m]!) {
      const child = w === m ? undefined : childOf(w)
      if (child !== undefined) out.add(child)
    }
    label.set(m, xxh3hex(`${g.material[m]!}\0${[...out].sort().join('\0')}`))
  }
  let parts = new Set(label.values()).size
  for (;;) {
    const next = new Map<number, string>()
    for (const m of members) {
      const inner = new Set<string>()
      for (const w of g.edges[m]!) if (w !== m && label.has(w)) inner.add(label.get(w)!)
      next.set(m, xxh3hex(`${label.get(m)!}\0${[...inner].sort().join('\0')}`))
    }
    label = next
    const now = new Set(label.values()).size
    if (now === parts) return members.map((m) => label.get(m)!)
    parts = now
  }
}

/** A dependency graph: one material string per node and its out-edges by index. */
export interface ReachGraph {
  readonly material: readonly string[]
  readonly edges: ReadonlyArray<readonly number[]>
}

/**
 * One digest per node over everything the node reaches, Merkle-style: a
 * change anywhere in a node's reach moves its digest, a change elsewhere
 * does not. Lockfiles carry dependency cycles, so the unit is the
 * strongly connected component: Tarjan's walk (iterative — a dependency
 * chain can be thousands deep) emits components children-first, and each
 * folds its members (sorted), each as its material and the materials its
 * edges land on, and its child components' digests (sorted).
 * O(nodes + edges), where one traversal per member is O(members × nodes).
 */
export function reachDigests(g: ReachGraph): string[] {
  const n = g.material.length
  const idx = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  const comp = new Int32Array(n).fill(-1)
  const compHash: string[] = []
  let counter = 0
  for (let root = 0; root < n; root++) {
    if (idx[root] !== -1) continue
    const frames: Array<[number, number]> = [[root, 0]]
    idx[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      const v = frame[0]
      const out = g.edges[v]!
      if (frame[1] < out.length) {
        const w = out[frame[1]++]!
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          frames.push([w, 0])
        } else if (onStack[w] === 1) {
          low[v] = Math.min(low[v]!, idx[w]!)
        }
        continue
      }
      frames.pop()
      if (frames.length > 0) {
        const u = frames[frames.length - 1]![0]
        low[u] = Math.min(low[u]!, low[v]!)
      }
      if (low[v] !== idx[v]) continue
      const members: number[] = []
      for (;;) {
        const w = stack.pop()!
        onStack[w] = 0
        comp[w] = compHash.length
        members.push(w)
        if (w === v) break
      }
      const id = compHash.length
      const children = new Set<string>()
      for (const m of members) {
        for (const w of g.edges[m]!) if (comp[w] !== id) children.add(compHash[comp[w]!]!)
      }
      // A member is its material AND where its edges land: all members
      // share one digest, so retargeting an edge between two of them (a
      // dependent's `y@1.0.0` → `y@1.1.0` inside one cycle) would move
      // nothing and replay a stale output. A self-loop reaches
      // nothing new and is left out. A singleton's children already say
      // where its edges land, and its line stays as it was, so an acyclic
      // digest keeps its value.
      const lines =
        members.length === 1
          ? members.map((m) => {
              const targets = [
                ...new Set(g.edges[m]!.filter((w) => w !== m).map((w) => g.material[w]!)),
              ]
              return `${g.material[m]!}\0${targets.sort().join('\0')}`
            })
          : cycleLabels(g, members, (w) => (comp[w] === id ? undefined : compHash[comp[w]!]!))
      let h = xxh3(`members:${members.length}`)
      for (const line of lines.sort()) h = xxh3(`${line}\n`, h)
      h = xxh3(`children:${children.size}`, h)
      for (const c of [...children].sort()) h = xxh3(`${c}\n`, h)
      compHash.push(h.toString(16).padStart(16, '0'))
    }
  }
  return Array.from({ length: n }, (_, i) => compHash[comp[i]!]!)
}
