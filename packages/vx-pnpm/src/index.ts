// @vzn/vx-pnpm — keys every task on its project's own resolved dependency
// closure from `pnpm-lock.yaml`, instead of the whole file.
//
// Core folds every lockfile at the root into the workspace fingerprint that
// every task key sees, so one `pnpm update foo` re-keys the workspace and
// `--affected` selects every project. This plugin CLAIMS the file
// (`VxPlugin.fingerprint`): core leaves it out of the key digest, and the
// `key` hook folds one digest per project — the packages that project can
// reach through its dependencies (name, version, resolved peers, integrity,
// patch), following `link:` into the linked workspace package's closure.
// `pnpm update foo` then re-keys exactly the projects that reach `foo`, and
// `--affected` names the same projects from the same digests.
//
// The lockfile is parsed once per content: the digests are memoised under
// the cache dir by the lockfile's hash, so a warm run pays one read and one
// xxh3 of the file, not a YAML parse. Within one process (a run, a watch
// cycle) the file's size + mtime gate even that read.
//
// Imports core only through the public `@vzn/vx` specifier.
import path from 'node:path'
import { stat, rename } from 'node:fs/promises'
import { definePlugin, type FingerprintChange, type TaskNode, type VxPlugin } from '@vzn/vx'
import { importerDigests, parseLockfile } from './lockfile.js'

export { importerDigests, parseLockfile, type Lockfile } from './lockfile.js'

export interface PnpmOptions {
  /**
   * `'project'` (default): each task folds its own project's dependency
   * closure — a lockfile change re-keys only the projects it reaches.
   * `'workspace'`: the whole file, as core folds it — the coarse key,
   * through the plugin, for a workspace that wants the claim but not yet
   * the precision (`vx why` names it either way).
   */
  readonly scope?: 'project' | 'workspace'
}

export const LOCKFILE = 'pnpm-lock.yaml'
/** Bumps when the digest's inputs or the memo's shape change. */
const MEMO_VERSION = 1

interface Digests {
  /** xxh3 of the lockfile bytes. */
  readonly lock: string
  /** importer path → digest; empty when the file is absent. */
  readonly importers: ReadonlyMap<string, string>
}

interface Memo {
  version: number
  lock: string
  importers: Record<string, string>
}

export function pnpm(options: PnpmOptions = {}): VxPlugin {
  const scope = options.scope ?? 'project'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(
      `@vzn/vx-pnpm: scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`,
    )
  }
  // Per workspace root: what the last read saw. `size`+`mtimeMs` gate a
  // re-read; the CONTENT hash decides whether the digests are current.
  const seen = new Map<string, { size: number; mtimeMs: number; digests: Digests }>()
  // Per run: core hands every `key` call of one run the same context
  // object, so keying on it makes the stat + read once per run, not once
  // per task — 1000 tasks cost 1000 stats (47 ms) before this.
  const perRun = new WeakMap<object, Promise<Digests>>()
  const loadOnce = (ctx: { workspaceRoot: string; cacheDir: string }): Promise<Digests> => {
    let p = perRun.get(ctx)
    if (p === undefined) {
      p = load(ctx.workspaceRoot, ctx.cacheDir)
      perRun.set(ctx, p)
    }
    return p
  }

  const load = async (workspaceRoot: string, cacheDir: string): Promise<Digests> => {
    const file = path.join(workspaceRoot, LOCKFILE)
    let st: { size: number; mtimeMs: number }
    try {
      st = await stat(file)
    } catch {
      const digests: Digests = { lock: '', importers: new Map() }
      seen.set(workspaceRoot, { size: -1, mtimeMs: -1, digests })
      return digests
    }
    const last = seen.get(workspaceRoot)
    if (last !== undefined && last.size === st.size && last.mtimeMs === st.mtimeMs) {
      return last.digests
    }
    const bytes = await Bun.file(file).bytes()
    const lock = hex(Bun.hash.xxHash3(bytes))
    if (last !== undefined && last.digests.lock === lock) {
      seen.set(workspaceRoot, { size: st.size, mtimeMs: st.mtimeMs, digests: last.digests })
      return last.digests
    }
    const importers =
      scope === 'workspace'
        ? new Map<string, string>()
        : ((await readMemo(cacheDir, lock)) ?? (await computeAndMemo(cacheDir, lock, bytes)))
    const digests: Digests = { lock, importers }
    seen.set(workspaceRoot, { size: st.size, mtimeMs: st.mtimeMs, digests })
    return digests
  }

  return definePlugin(import.meta, {
    fingerprint: {
      files: [LOCKFILE],
      affected(change: FingerprintChange, ctx) {
        // One side absent: the file appeared or went — every project's
        // node_modules is in question, and core's answer (all) is right.
        if (change.before === null || change.after === null) return undefined
        if (scope === 'workspace') return undefined
        const before = importerDigests(parseLockfile(decode(change.before)))
        const after = importerDigests(parseLockfile(decode(change.after)))
        const names: string[] = []
        for (const p of ctx.projects) {
          const importer = importerOf(ctx.workspaceRoot, p.dir)
          if (digestFor(before, importer) !== digestFor(after, importer)) names.push(p.name)
        }
        return names
      },
    },
    async key(task: TaskNode, ctx) {
      const digests = await loadOnce(ctx)
      if (digests.lock === '') return undefined
      if (scope === 'workspace') return { lockfile: digests.lock }
      return { deps: digestFor(digests.importers, importerOf(ctx.workspaceRoot, task.projectDir)) }
    },
  })
}

/**
 * A project's digest: its own importer's, or — for a project the lockfile
 * has no importer for (outside `pnpm-workspace.yaml`'s `packages`) — the
 * root importer's, which is the only `node_modules` it can resolve from.
 * A lockfile with neither folds a constant, and a change to it re-keys
 * nothing for that project: nothing it installs changed.
 */
function digestFor(importers: ReadonlyMap<string, string>, importer: string): string {
  return importers.get(importer) ?? importers.get('.') ?? 'no-importer'
}

/** The lockfile's importer path for a project directory: `.` for the root, POSIX otherwise. */
function importerOf(workspaceRoot: string, projectDir: string): string {
  const rel = path.relative(workspaceRoot, projectDir)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}

function memoPath(cacheDir: string): string {
  return path.join(cacheDir, 'vx-pnpm', 'digests.json')
}

async function readMemo(cacheDir: string, lock: string): Promise<Map<string, string> | undefined> {
  try {
    const memo = (await Bun.file(memoPath(cacheDir)).json()) as Memo
    if (memo.version !== MEMO_VERSION || memo.lock !== lock) return undefined
    return new Map(Object.entries(memo.importers))
  } catch {
    return undefined
  }
}

async function computeAndMemo(
  cacheDir: string,
  lock: string,
  bytes: Uint8Array,
): Promise<ReadonlyMap<string, string>> {
  const importers = importerDigests(parseLockfile(decode(bytes)))
  const memo: Memo = { version: MEMO_VERSION, lock, importers: Object.fromEntries(importers) }
  // Write-then-rename: a reader never sees a half-written memo, and two
  // concurrent runs each land a whole one.
  const target = memoPath(cacheDir)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await Bun.write(tmp, JSON.stringify(memo))
    await rename(tmp, target)
  } catch {
    // The memo is a speed-up, never a requirement: the digests are computed
    // either way, and the next run parses again.
  }
  return importers
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function hex(h: bigint): string {
  return h.toString(16).padStart(16, '0')
}
