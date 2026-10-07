// vx cleans a task's declared outputs before it runs (core's rule, kept on
// purpose: a stale file in an output is a stale artifact). Turbo and Nx
// never clean, so an output a repo declares over committed files is safe
// there and destructive here: typescript-eslint's website build caches
// `data`, which holds the committed `sponsors.json`, and the first vx run
// deleted it (2026-09-29). Each committed file under a mapped output is taken
// back with a `!` entry (core's A-44): not cleaned, not saved, not restored,
// still an input. The task keeps its cache.

import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { outputsOverlap } from '@vzn/vx'
import { relPosix } from './paths.js'

/** The files git tracks under `root`, root-relative; null outside a repo or without git. */
export async function trackedFiles(root: string): Promise<string[] | null> {
  try {
    const p = Bun.spawn(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    if ((await p.exited) !== 0) return null
    return out.split('\0').filter((f) => f !== '')
  } catch {
    return null
  }
}

const sortedMemo = new WeakMap<readonly string[], readonly string[]>()

/**
 * The files under `rel/` (all of them for the root). In a sorted list they
 * are one run, found by a binary search: every project scanned the whole
 * list, twice, and a cold mapping of 1,000 packages spent 177 ms there.
 */
function filesUnder(files: readonly string[], rel: string): readonly string[] {
  if (rel === '' || rel === '.') return files
  let sorted = sortedMemo.get(files)
  if (sorted === undefined) sortedMemo.set(files, (sorted = [...files].sort()))
  const prefix = `${rel}/`
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! < prefix) lo = mid + 1
    else hi = mid
  }
  const out: string[] = []
  for (let i = lo; i < sorted.length && sorted[i]!.startsWith(prefix); i++) out.push(sorted[i]!)
  return out
}

/**
 * Which of `rels` (root-relative) git ignores: a path no glob over git's
 * files can key. Untracked only (a tracked file is never ignored); empty
 * outside a repo or without git.
 */
export async function gitIgnored(root: string, rels: readonly string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set()
  try {
    const p = Bun.spawn(['git', 'check-ignore', '--stdin', '-z'], {
      cwd: root,
      stdin: new TextEncoder().encode(rels.map((r) => `${r}\0`).join('')),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    // 1: none ignored; anything else past 0 is no answer.
    if ((await p.exited) !== 0) return new Set()
    return new Set(out.split('\0').filter((f) => f !== ''))
  } catch {
    return new Set()
  }
}

/**
 * What a project's tracked files are: their extensions (lower case, no
 * dot), directory names at any depth, and top-level entry names.
 */
export interface TrackedKinds {
  readonly exts: ReadonlySet<string>
  readonly dirs: ReadonlySet<string>
  readonly tops: ReadonlySet<string>
  /** The files themselves, project-relative. */
  readonly files: readonly string[]
}

/**
 * Per project directory (root-relative, `.` or empty for the root), the
 * kinds of the files git tracks under it at any depth: what a
 * wildcard-first output glob may not claim (`wildcardOutput`).
 */
export function trackedKinds(tracked: readonly string[]): (rel: string) => TrackedKinds {
  const memo = new Map<string, TrackedKinds>()
  return (rel) => {
    let kinds = memo.get(rel)
    if (kinds === undefined) {
      const exts = new Set<string>()
      const dirs = new Set<string>()
      const tops = new Set<string>()
      const files: string[] = []
      const all = rel === '' || rel === '.'
      for (const f of filesUnder(tracked, rel)) {
        const own = all ? f : f.slice(rel.length + 1)
        files.push(own)
        const ext = path.posix.extname(own)
        if (ext !== '') exts.add(ext.slice(1).toLowerCase())
        const segs = own.split('/')
        tops.add(segs[0]!)
        for (let i = 0; i < segs.length - 1; i++) dirs.add(segs[i]!)
      }
      memo.set(rel, (kinds = { exts, dirs, tops, files }))
    }
    return kinds
  }
}

/**
 * What moves when the tracked set can: the HEAD reflog's size (a commit, a
 * checkout, a pull appends to it), HEAD itself, and the index's size and
 * mtime (`git add`, `git rm`). Stats and a small read, so a kept mapping
 * stays a hit between them; a run does not write the index. Without the
 * index, a file `git add`ed under an output and not yet committed was not
 * taken back by the kept mapping, and the run's clean deleted it. Under
 * reftable storage HEAD reads `ref: refs/heads/.invalid` and no reflog file
 * exists, so the ref stack's table list stands for both: every ref update
 * names a new table in it.
 */
export async function headStamp(root: string): Promise<string> {
  for (let dir = root; ;) {
    const dotGit = path.join(dir, '.git')
    const st = await lstat(dotGit).catch(() => null)
    if (st !== null) {
      let gitDir = dotGit
      if (st.isFile()) {
        const m = /^gitdir: (.*)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))
        if (m !== null) gitDir = path.resolve(dir, m[1]!.trim())
      }
      const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')
      const log = await lstat(path.join(gitDir, 'logs', 'HEAD')).catch(() => null)
      const index = await lstat(path.join(gitDir, 'index')).catch(() => null)
      // A worktree's own stack holds its HEAD; the common one, its branches.
      const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null)
      const tables = await Promise.all(
        [gitDir, ...(common === null ? [] : [path.resolve(gitDir, common.trim())])].map((d) =>
          readFile(path.join(d, 'reftable', 'tables.list'), 'utf8').catch(() => ''),
        ),
      )
      return `${head.trim()}\0${log?.size ?? ''}\0${index?.size ?? ''}\0${index?.mtimeMs ?? ''}\0${tables.join('\0')}`
    }
    const up = path.dirname(dir)
    if (up === dir) return 'no-git'
    dir = up
  }
}

/** A glob's leading literal segments: every path it can match starts there. */
function literalPrefix(glob: string): string {
  const out: string[] = []
  for (const seg of glob.replace(/^(\.\/)+/, '').split('/')) {
    if (/[*?[\]{}()!]/.test(seg)) break
    out.push(seg)
  }
  return out.join('/')
}

/** The tracked `files` (relative to the same base as `globs`) the positive globs cover and no `!` takes back. */
function coveredTracked(globs: readonly string[], files: readonly string[]): string[] {
  const positive = globs.filter((g) => !g.startsWith('!'))
  const taken = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
  const hit = new Set<string>()
  for (const g of positive) {
    const prefix = literalPrefix(g)
    for (const f of files) {
      if (prefix !== '' && f !== prefix && !f.startsWith(`${prefix}/`)) continue
      if (!outputsOverlap(g, f)) continue
      if (taken.some((t) => outputsOverlap(t, f))) continue
      hit.add(f)
    }
  }
  return [...hit].sort()
}

/** The first of `files` a `!` entry of `globs` takes back though a positive one reads it. */
function hidden(globs: unknown, files: readonly string[]): string | undefined {
  if (!Array.isArray(globs) || files.length === 0) return undefined
  const strings = globs.filter((g): g is string => typeof g === 'string')
  const negative = strings.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
  if (negative.length === 0) return undefined
  const positive = strings.filter((g) => !g.startsWith('!'))
  return files.find(
    (f) => negative.some((n) => outputsOverlap(n, f)) && positive.some((g) => outputsOverlap(g, f)),
  )
}

/** Past this many, a task's take-backs cost its runs more than its cache saves. */
export const MAX_SPARED = 16

interface Outputs {
  files?: unknown
  workspaceFiles?: unknown
}

/**
 * Take back every committed file a mapped task's outputs cover, in place,
 * and return one `[pkg#task, todo]` per task that had any. `tracked` is
 * root-relative.
 */
export function spareTrackedOutputs(
  root: string,
  projects: readonly {
    readonly name: string
    readonly dir: string
    readonly tasks: readonly {
      readonly name: string
      readonly task: Record<string, unknown> | null
    }[]
  }[],
  tracked: readonly string[],
): [string, string][] {
  const todos: [string, string][] = []
  for (const p of projects) {
    const rel = relPosix(root, p.dir)
    const own = rel === '' ? tracked : filesUnder(tracked, rel).map((f) => f.slice(rel.length + 1))
    for (const t of p.tasks) {
      const outputs = (t.task?.['cache'] as { outputs?: Outputs } | undefined)?.outputs
      if (outputs === undefined) continue
      const hits: [key: 'files' | 'workspaceFiles', globs: string[], hit: string[]][] = []
      for (const [key, base] of [
        ['files', own],
        ['workspaceFiles', tracked],
      ] as const) {
        const globs = outputs[key]
        if (!Array.isArray(globs) || globs.length === 0) continue
        const strings = globs.filter((g): g is string => typeof g === 'string')
        const hit = coveredTracked(strings, base)
        if (hit.length > 0) hits.push([key, strings, hit])
      }
      const spared = hits.flatMap(([, , hit]) => hit)
      if (spared.length === 0) continue
      // A committed file under these outputs is still a source, and the `!`
      // entry `excludeSiblingOutputs` gave a reader over the whole output
      // hides it from that reader's key: such a reader runs uncached (X-54).
      const local = hits.flatMap(([key, , hit]) => (key === 'files' ? hit : []))
      const rooted = hits.flatMap(([key, , hit]) =>
        key === 'files' ? hit.map((f) => (rel === '' ? f : `${rel}/${f}`)) : hit,
      )
      for (const q of projects) {
        for (const r of q.tasks) {
          if (r === t) continue
          const inputs = (r.task?.['cache'] as { inputs?: Outputs } | undefined)?.inputs
          if (inputs === undefined) continue
          const f =
            (q === p ? hidden(inputs.files, local) : undefined) ??
            hidden(inputs.workspaceFiles, rooted)
          if (f === undefined) continue
          delete r.task!['cache']
          todos.push([
            `${q.name}#${r.name}`,
            `reads the committed ${f}, which its inputs take back with ${p.name}#${t.name}'s ` +
              'outputs — task runs uncached; declare its inputs in a vx.config to cache it',
          ])
        }
      }
      const shown = spared.slice(0, 3).join(', ') + (spared.length > 3 ? ', …' : '')
      // Each `!` is matched against every output path on each save, clean
      // and restore: 4,200 of them cost typescript-eslint's warm run 1.2 s.
      if (spared.length > MAX_SPARED) {
        delete t.task!['cache']
        todos.push([
          `${p.name}#${t.name}`,
          `outputs cover ${spared.length} committed files (${shown}), which vx cleans before ` +
            'every run — task runs uncached; declare the exact outputs in a vx.config to cache it',
        ])
        continue
      }
      for (const [key, strings, hit] of hits)
        outputs[key] = [...strings, ...hit.map((f) => `!${f}`)]
      todos.push([
        `${p.name}#${t.name}`,
        `outputs cover ${spared.length} committed file(s) (${shown}) — vx cleans outputs ` +
          'before a run, so they are taken back with `!` and kept',
      ])
    }
  }
  return todos
}
