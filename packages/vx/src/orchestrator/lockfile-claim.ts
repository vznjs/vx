// The claimant's shell: what every lockfile plugin needs around its
// parser. A plugin that keys each project on its own dependency closure
// from a lockfile (`@vzn/vx-lockfile`) claims the file
// (`VxPlugin.fingerprint`), folds one digest per project through `key`,
// and answers `--affected` by digesting both sides of a change. Only the
// parser differs per package manager; the memo, the per-run gate, the
// fallback for a project the file does not list and the `--affected`
// diff are one implementation here, so a third lockfile is a parser.
//
// The digests are memoised on disk under the cache dir by the file's
// xxh3, so a warm run pays one read + hash + a small JSON read, never a
// parse; within one process (a run, a watch cycle) the file's size,
// mtime, ctime and inode gate even the read; and per run the read happens once (a WeakMap
// on the context core hands every `key` call of a run).

import path from 'node:path'
import { rename, stat } from 'node:fs/promises'
import { relPosix, xxh3, xxh3hex } from '../util/index.js'
import type { TaskNode } from '../graph/index.js'
import type {
  FingerprintChange,
  FingerprintClaim,
  FingerprintContext,
  KeyHookContext,
} from './plugin.js'

export interface LockfileClaimOptions {
  /** The lockfile's name at the workspace root. */
  readonly file: string
  /**
   * Every project's digest from the file's text: importer directory
   * (root-relative POSIX, `.` for the root) → digest. Called once per
   * distinct content; must be deterministic and throw on a file it
   * cannot read (the plugin's name heads the error).
   */
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  /**
   * Root-relative files the lockfile names whose BYTES the install uses but
   * the lockfile does not pin (bun.lock's `patchedDependencies` names a patch
   * file and records no hash of it). Their content hashes ('' when absent)
   * reach `digest` as `files` and join the memo's identity, so an edited
   * patch moves the key (item 1014). A directory (a `file:` dependency the
   * install copies) hashes every file under it but `node_modules` and
   * `.git`. Called only when the memo misses.
   */
  readonly extraFiles?: (text: string) => readonly string[]
  /** Folded into the memo's identity: bump when `digest` folds differently. */
  readonly version: number
  /**
   * `'project'` (default): each task folds its own project's digest.
   * `'workspace'`: the whole file's hash into every task — the coarse key.
   */
  readonly scope?: 'project' | 'workspace'
  /**
   * The key part's name, as `vx why` shows it under the plugin's name
   * (`@vzn/vx-lockfile/pnpm`). Default `'deps'`.
   */
  readonly part?: string
  /**
   * Each importer's links to other importers, from the same text, kept in
   * the memo beside the digests so a `discover` hook reads them without a
   * parse. Called once per distinct content, under either scope.
   */
  readonly importers?: (text: string) => ReadonlyMap<string, LockfileImporter>
}

/**
 * What a lockfile records of one importer's links to the workspace's other
 * importers: dependency name → importer directory (root-relative POSIX,
 * `.` for the root).
 */
export interface LockfileImporter {
  /** The entries it installs that resolve to an importer. */
  readonly deps: Readonly<Record<string, string>>
  /** Its peers that resolve to an importer, each with no installed entry of the same name. */
  readonly peers: Readonly<Record<string, string>>
}

/** What a lockfile plugin spreads into `definePlugin` (`fingerprint`, `key`), and `importers` for its own stages. */
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  /**
   * `importers`' answer for the file as it is now, through the same memo
   * and gates as `key`; undefined when the file is absent. Not a hook: a
   * plugin calls it from its own `discover` or `project`.
   */
  importers(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, LockfileImporter> | undefined>
}

interface Digests {
  /** xxh3 of the lockfile bytes; '' when the file is absent. */
  readonly lock: string
  readonly importers: ReadonlyMap<string, string>
  readonly edges: ReadonlyMap<string, LockfileImporter>
}

interface Memo {
  version: number
  claimant: string
  lock: string
  /** `extraFiles` → content hash when the digests were computed. */
  extras?: Record<string, string>
  importers: Record<string, string>
  edges?: Record<string, LockfileImporter>
}

/** A root-relative extra file's content hash, '' when absent; a path leaving the root is never read. */
async function hashExtra(workspaceRoot: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 'outside-root'
  const abs = path.join(workspaceRoot, rel)
  try {
    return xxh3hex(await Bun.file(abs).bytes())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') return hashDir(abs)
    return ''
  }
}

/**
 * Every file under `dir` but its `node_modules` and `.git`, as `rel\0hash`
 * lines in sorted order. Links are followed: a linked file is what a task
 * reads, and the scan skipped it, so an edit to its target moved no key.
 */
async function hashDir(dir: string): Promise<string> {
  const rels: string[] = []
  const scan = { cwd: dir, dot: true, onlyFiles: true, followSymlinks: true }
  for await (const rel of new Bun.Glob('**').scan(scan)) {
    if (!rel.split('/').some((s) => s === 'node_modules' || s === '.git')) rels.push(rel)
  }
  rels.sort()
  const lines = await Promise.all(
    rels.map(async (rel) => `${rel}\0${xxh3hex(await Bun.file(path.join(dir, rel)).bytes())}`),
  )
  return `dir\0${xxh3hex(lines.join('\n'))}`
}

/**
 * A file's identity for the in-process gate, as `Cache.hashFile`'s memo
 * keys one: size and mtime alone kept the digests of a lockfile or patch
 * replaced by another of the same size with its mtime kept (`cp -p`,
 * `tar -x`), and no task sets a ctime.
 */
function identityOf(st: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
}

// A directory's own stat moves only when an entry is added or removed, not
// when a file in it is edited: its identity is its content hash.
async function statsOf(workspaceRoot: string, rels: readonly string[]): Promise<string[]> {
  return Promise.all(
    rels.map((rel) =>
      stat(path.join(workspaceRoot, rel)).then(
        (st) => (st.isDirectory() ? hashExtra(workspaceRoot, rel) : identityOf(st)),
        () => 'gone',
      ),
    ),
  )
}

/** Each file's identity, taken BEFORE its hash, so a write between the two re-reads it. */
async function hashExtras(
  workspaceRoot: string,
  rels: readonly string[],
): Promise<{ hashes: Record<string, string>; stats: Record<string, string> }> {
  const ids = await statsOf(workspaceRoot, rels)
  const stats = Object.fromEntries(rels.map((rel, i) => [rel, ids[i]!] as const))
  const hashes = Object.fromEntries(
    await Promise.all(rels.map(async (rel) => [rel, await hashExtra(workspaceRoot, rel)] as const)),
  )
  return { hashes, stats }
}

export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks {
  const { file, digest, version } = options
  const scope = options.scope ?? 'project'
  const part = options.part ?? 'deps'
  // `version` is one claimant's counter, and another claimant of the file
  // at the same number read this one's memo: one that named no extra file
  // left the other's patch edits out of its key (X-130). The functions'
  // source stands for the claimant; a rebuild that changes it is a miss.
  // The scope too: a workspace-scope memo holds no digests.
  const claimant = xxh3hex(
    [
      part,
      scope,
      String(digest),
      String(options.extraFiles ?? ''),
      String(options.importers ?? ''),
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
      digests: Digests
    }
  >()
  // Per run: every `key` call of one run gets the same context object.
  const perRun = new WeakMap<object, Promise<Digests>>()

  const load = async (workspaceRoot: string, cacheDir: string): Promise<Digests> => {
    const full = path.join(workspaceRoot, file)
    let identity: string
    try {
      identity = identityOf(await stat(full))
    } catch {
      const digests: Digests = { lock: '', importers: new Map(), edges: new Map() }
      seen.set(workspaceRoot, { identity: 'gone', extras: [], extraStats: {}, digests })
      return digests
    }
    const last = seen.get(workspaceRoot)
    if (last !== undefined && last.identity === identity) {
      const now = await statsOf(workspaceRoot, last.extras)
      if (now.every((s, i) => s === last.extraStats[last.extras[i]!])) {
        return last.digests
      }
    }
    const bytes = await Bun.file(full).bytes()
    const lockHash = xxh3hex(bytes)
    const memoFile = path.join(cacheDir, 'lockfile-claims', `${file}.json`)
    // The extra files the last digest read, and their hashes now: a warm run
    // re-hashes the files the memo names and never parses to learn them.
    const memo = await readMemo(memoFile, version, claimant, lockHash)
    let extras: Record<string, string> = {}
    let extraStats: Record<string, string> = {}
    let importers: ReadonlyMap<string, string> | undefined
    let edges: ReadonlyMap<string, LockfileImporter> = new Map()
    if (memo !== undefined) {
      const now = await hashExtras(workspaceRoot, Object.keys(memo.extras))
      if (Object.entries(memo.extras).every(([rel, h]) => now.hashes[rel] === h)) {
        extras = memo.extras
        extraStats = now.stats
        importers = memo.importers
        edges = memo.edges
      }
    }
    if (importers === undefined) {
      const text = decode(bytes)
      const rels = [...new Set(options.extraFiles?.(text) ?? [])].sort()
      const now = await hashExtras(workspaceRoot, rels)
      extras = now.hashes
      extraStats = now.stats
      importers =
        scope === 'workspace'
          ? new Map<string, string>()
          : digest(text, new Map(Object.entries(extras)))
      edges = options.importers?.(text) ?? new Map()
      // Workspace scope with no edges to keep has nothing a memo saves.
      if (scope === 'project' || options.importers !== undefined) {
        await writeMemo(memoFile, { version, claimant, lock: lockHash }, extras, importers, edges)
      }
    }
    const rels = Object.keys(extras)
    const lock =
      rels.length === 0
        ? lockHash
        : xxh3hex([lockHash, ...rels.map((r) => `${r}\0${extras[r]}`)].join('\0'))
    const digests: Digests = { lock, importers, edges }
    seen.set(workspaceRoot, { identity, extras: rels, extraStats, digests })
    return digests
  }
  const loadOnce = (ctx: KeyHookContext): Promise<Digests> => {
    let p = perRun.get(ctx)
    if (p === undefined) {
      p = load(ctx.workspaceRoot, ctx.cacheDir)
      perRun.set(ctx, p)
    }
    return p
  }

  return {
    fingerprint: {
      files: [file],
      affected(change: FingerprintChange, ctx: FingerprintContext) {
        // One side absent: the file appeared or went — every project's
        // installed tree is in question.
        if (change.before === null || change.after === null) return undefined
        if (scope === 'workspace') return undefined
        // WHICH side failed is the whole difference between "your
        // lockfile is broken" and "the base commit's is" — a migration
        // commit hits the second, and the bare parser message named
        // neither (2026-09-20).
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
          const importer = importerOf(ctx.workspaceRoot, p.dir)
          if (digestFor(before, importer) !== digestFor(after, importer)) names.push(p.name)
        }
        return names
      },
      ...(options.extraFiles !== undefined
        ? { extraFiles: (_file: string, bytes: Uint8Array) => options.extraFiles!(decode(bytes)) }
        : {}),
    },
    async key(task, ctx) {
      const digests = await loadOnce(ctx)
      if (digests.lock === '') return undefined
      if (scope === 'workspace') return { [part]: digests.lock }
      return {
        [part]: digestFor(digests.importers, importerOf(ctx.workspaceRoot, task.projectDir)),
      }
    },
    async importers(ctx) {
      const digests = await load(ctx.workspaceRoot, ctx.cacheDir)
      return digests.lock === '' ? undefined : digests.edges
    },
  }
}

/**
 * A project's digest: its own importer's AND the root importer's. The
 * root package's dependencies reach every task — their bins through the
 * root `node_modules/.bin` core puts on every PATH, their modules through
 * Node's resolution walking up to the root `node_modules` (`@types/*`,
 * a config's plugins) — so a root devDependency bump that moved only the
 * root's digest replayed the old tool's output (nx#36415 class,
 * 2026-09-24). A project the lockfile has no importer for folds its
 * nearest listed ancestor's, as Node resolves from that ancestor's
 * `node_modules` (`packages/a/e2e` from `packages/a`'s): the root's alone
 * keyed it on no bump only `a` reached. Outside every importer it folds
 * the root's alone; a file with neither folds a constant.
 */
function digestFor(importers: ReadonlyMap<string, string>, importer: string): string {
  let dir = importer
  while (dir !== '.' && !importers.has(dir)) {
    const slash = dir.lastIndexOf('/')
    dir = slash === -1 ? '.' : dir.slice(0, slash)
  }
  const own = importers.get(dir)
  const root = importers.get('.')
  if (own === undefined) return root ?? 'no-importer'
  if (root === undefined || dir === '.') return own
  return xxh3hex(`${own}\0${root}`)
}

/** The lockfile's importer path for a project directory: `.` for the root, POSIX otherwise. */
function importerOf(workspaceRoot: string, projectDir: string): string {
  return relPosix(workspaceRoot, projectDir) || '.'
}

async function readMemo(
  memoFile: string,
  version: number,
  claimant: string,
  lock: string,
): Promise<
  | {
      extras: Record<string, string>
      importers: Map<string, string>
      edges: Map<string, LockfileImporter>
    }
  | undefined
> {
  try {
    const memo = (await Bun.file(memoFile).json()) as Memo
    if (memo.version !== version || memo.claimant !== claimant || memo.lock !== lock) {
      return undefined
    }
    return {
      extras: memo.extras ?? {},
      importers: new Map(Object.entries(memo.importers)),
      edges: new Map(Object.entries(memo.edges ?? {})),
    }
  } catch {
    return undefined
  }
}

async function writeMemo(
  memoFile: string,
  identity: Pick<Memo, 'version' | 'claimant' | 'lock'>,
  extras: Record<string, string>,
  importers: ReadonlyMap<string, string>,
  edges: ReadonlyMap<string, LockfileImporter>,
): Promise<void> {
  const memo: Memo = {
    ...identity,
    extras,
    importers: Object.fromEntries(importers),
    ...(edges.size > 0 ? { edges: Object.fromEntries(edges) } : {}),
  }
  // Write-then-rename: a reader never sees a half-written memo, and two
  // concurrent runs each land a whole one.
  const tmp = `${memoFile}.tmp-${process.pid}-${Date.now()}`
  try {
    await Bun.write(tmp, JSON.stringify(memo))
    await rename(tmp, memoFile)
  } catch {
    // The memo is a speed-up, never a requirement: the digests are
    // computed either way, and the next run computes them again.
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// --- Reach digests -----------------------------------------------------------

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
 * edges land on, and its child components' digests (sorted). O(nodes + edges): 1000 importers over 3000 packages digest in
 * ~20 ms where one traversal per importer took 400.
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
      // share one digest, so retargeting an edge between two of them (an
      // importer's `y@1.0.0` → `y@1.1.0` inside one cycle) moved nothing
      // and replayed a stale output (item 1013). A self-loop reaches
      // nothing new and is left out. An edge leaving a cycle names the
      // component it lands on: npm and bun key two copies of one version
      // alike (`a/node_modules/foo` → bar@1, `node_modules/foo` → bar@2),
      // so by material alone two members swapping copies moved nothing. A
      // singleton's children already say where its edges land, and its
      // lines stay as they were, so an acyclic digest keeps its value.
      const cyclic = members.length > 1
      const lines = members.map((m) => {
        const targets = [
          ...new Set(
            g.edges[m]!.filter((w) => w !== m).map((w) =>
              cyclic && comp[w] !== id ? `child\0${compHash[comp[w]!]!}` : g.material[w]!,
            ),
          ),
        ]
        return `${g.material[m]!}\0${targets.sort().join('\0')}`
      })
      let h = xxh3(`members:${members.length}`)
      for (const line of lines.sort()) h = xxh3(`${line}\n`, h)
      h = xxh3(`children:${children.size}`, h)
      for (const c of [...children].sort()) h = xxh3(`${c}\n`, h)
      compHash.push(h.toString(16).padStart(16, '0'))
    }
  }
  return Array.from({ length: n }, (_, i) => compHash[comp[i]!]!)
}
