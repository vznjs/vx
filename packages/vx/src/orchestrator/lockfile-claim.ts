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
// parse; within one process (a run, a watch cycle) the file's size and
// mtime gate even the read; and per run the read happens once (a WeakMap
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
  /** The root-relative lockfile name, one of `WORKSPACE_FINGERPRINT_FILES`. */
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
   * patch moves the key (item 1014). Called only when the memo misses.
   */
  readonly extraFiles?: (text: string) => readonly string[]
  /** Folded into the memo's identity: bump when `digest` folds differently. */
  readonly version: number
  /**
   * `'project'` (default): each task folds its own project's digest.
   * `'workspace'`: the whole file's hash into every task — the coarse key
   * core would fold, through the plugin.
   */
  readonly scope?: 'project' | 'workspace'
  /**
   * The key part's name, as `vx why` shows it under the plugin's name
   * (`@vzn/vx-lockfile/pnpm`). Default `'deps'`.
   */
  readonly part?: string
}

/** The two hooks a lockfile plugin spreads into `definePlugin`. */
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
}

interface Digests {
  /** xxh3 of the lockfile bytes; '' when the file is absent. */
  readonly lock: string
  readonly importers: ReadonlyMap<string, string>
}

interface Memo {
  version: number
  lock: string
  /** `extraFiles` → content hash when the digests were computed. */
  extras?: Record<string, string>
  importers: Record<string, string>
}

/** A root-relative extra file's content hash, '' when absent; a path leaving the root is never read. */
async function hashExtra(workspaceRoot: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 'outside-root'
  try {
    return xxh3hex(await Bun.file(path.join(workspaceRoot, rel)).bytes())
  } catch {
    return ''
  }
}

async function statsOf(
  workspaceRoot: string,
  rels: readonly string[],
): Promise<Array<{ size: number; mtimeMs: number }>> {
  return Promise.all(
    rels.map((rel) =>
      stat(path.join(workspaceRoot, rel)).then(
        (st) => ({ size: st.size, mtimeMs: st.mtimeMs }),
        () => ({ size: -1, mtimeMs: -1 }),
      ),
    ),
  )
}

export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks {
  const { file, digest, version } = options
  const scope = options.scope ?? 'project'
  const part = options.part ?? 'deps'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(`scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`)
  }
  // Per workspace root: what the last read saw. `size` + `mtimeMs` gate a
  // re-read; the content hash decides whether the digests are current.
  const seen = new Map<
    string,
    {
      size: number
      mtimeMs: number
      extras: readonly string[]
      extraStats: ReadonlyArray<{ size: number; mtimeMs: number }>
      digests: Digests
    }
  >()
  // Per run: every `key` call of one run gets the same context object.
  const perRun = new WeakMap<object, Promise<Digests>>()

  const load = async (workspaceRoot: string, cacheDir: string): Promise<Digests> => {
    const full = path.join(workspaceRoot, file)
    let st: { size: number; mtimeMs: number }
    try {
      st = await stat(full)
    } catch {
      const digests: Digests = { lock: '', importers: new Map() }
      seen.set(workspaceRoot, { size: -1, mtimeMs: -1, extras: [], extraStats: [], digests })
      return digests
    }
    const last = seen.get(workspaceRoot)
    if (last !== undefined && last.size === st.size && last.mtimeMs === st.mtimeMs) {
      const now = await statsOf(workspaceRoot, last.extras)
      if (
        now.every(
          (s, i) =>
            s.size === last.extraStats[i]!.size && s.mtimeMs === last.extraStats[i]!.mtimeMs,
        )
      ) {
        return last.digests
      }
    }
    const bytes = await Bun.file(full).bytes()
    const lockHash = xxh3hex(bytes)
    const memoFile = path.join(cacheDir, 'lockfile-claims', `${file}.json`)
    // The extra files the last digest read, and their hashes now: a warm run
    // re-hashes the files the memo names and never parses to learn them.
    const memo = await readMemo(memoFile, version, lockHash)
    let extras: Record<string, string> = {}
    let importers: ReadonlyMap<string, string> | undefined
    if (memo !== undefined) {
      const now = Object.fromEntries(
        await Promise.all(
          Object.keys(memo.extras).map(
            async (rel) => [rel, await hashExtra(workspaceRoot, rel)] as const,
          ),
        ),
      )
      if (Object.entries(memo.extras).every(([rel, h]) => now[rel] === h)) {
        extras = memo.extras
        importers = memo.importers
      }
    }
    if (importers === undefined) {
      const text = decode(bytes)
      const rels = [...new Set(options.extraFiles?.(text) ?? [])].sort()
      extras = Object.fromEntries(
        await Promise.all(
          rels.map(async (rel) => [rel, await hashExtra(workspaceRoot, rel)] as const),
        ),
      )
      importers =
        scope === 'workspace'
          ? new Map<string, string>()
          : await computeAndMemo(
              memoFile,
              version,
              lockHash,
              extras,
              digest(text, new Map(Object.entries(extras))),
            )
    }
    const rels = Object.keys(extras)
    const lock =
      rels.length === 0
        ? lockHash
        : xxh3hex([lockHash, ...rels.map((r) => `${r}\0${extras[r]}`)].join('\0'))
    const digests: Digests = { lock, importers }
    seen.set(workspaceRoot, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      extras: rels,
      extraStats: await statsOf(workspaceRoot, rels),
      digests,
    })
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
        // installed tree is in question, and core's answer (all) is right.
        if (change.before === null || change.after === null) return undefined
        if (scope === 'workspace') return undefined
        // WHICH side failed is the whole difference between "your
        // lockfile is broken" and "the base commit's is" — a migration
        // commit hits the second, and the bare parser message named
        // neither (2026-09-20).
        const sideOf = (bytes: Uint8Array, side: string): ReadonlyMap<string, string> => {
          try {
            return digest(decode(bytes), new Map())
          } catch (err) {
            throw new Error(`${err instanceof Error ? err.message : String(err)} (${side})`)
          }
        }
        const before = sideOf(change.before, `as of the base ref`)
        const after = sideOf(change.after, `in the working tree`)
        const names: string[] = []
        for (const p of ctx.projects) {
          const importer = importerOf(ctx.workspaceRoot, p.dir)
          if (digestFor(before, importer) !== digestFor(after, importer)) names.push(p.name)
        }
        return names
      },
    },
    async key(task, ctx) {
      const digests = await loadOnce(ctx)
      if (digests.lock === '') return undefined
      if (scope === 'workspace') return { [part]: digests.lock }
      return {
        [part]: digestFor(digests.importers, importerOf(ctx.workspaceRoot, task.projectDir)),
      }
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
 * 2026-09-24). A project the lockfile has no importer for (outside the
 * workspace's `packages`) folds the root's alone; a file with neither
 * folds a constant.
 */
function digestFor(importers: ReadonlyMap<string, string>, importer: string): string {
  const own = importers.get(importer)
  const root = importers.get('.')
  if (own === undefined) return root ?? 'no-importer'
  if (root === undefined || importer === '.') return own
  return xxh3hex(`${own}\0${root}`)
}

/** The lockfile's importer path for a project directory: `.` for the root, POSIX otherwise. */
function importerOf(workspaceRoot: string, projectDir: string): string {
  return relPosix(workspaceRoot, projectDir) || '.'
}

async function readMemo(
  memoFile: string,
  version: number,
  lock: string,
): Promise<{ extras: Record<string, string>; importers: Map<string, string> } | undefined> {
  try {
    const memo = (await Bun.file(memoFile).json()) as Memo
    if (memo.version !== version || memo.lock !== lock) return undefined
    return { extras: memo.extras ?? {}, importers: new Map(Object.entries(memo.importers)) }
  } catch {
    return undefined
  }
}

async function computeAndMemo(
  memoFile: string,
  version: number,
  lock: string,
  extras: Record<string, string>,
  importers: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const memo: Memo = { version, lock, extras, importers: Object.fromEntries(importers) }
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
  return importers
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
      // nothing new and is left out.
      const lines = members.map((m) => {
        const targets = [...new Set(g.edges[m]!.filter((w) => w !== m).map((w) => g.material[w]!))]
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
