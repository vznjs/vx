// vx cleans a task's declared outputs before it runs (core's rule, kept on
// purpose: a stale file in an output is a stale artifact). Turbo, Nx and lage
// never clean, so an output a repo declares over committed files is safe
// there and destructive here: typescript-eslint's website build caches
// `data`, which holds the committed `sponsors.json`, and the first vx run
// deleted it (2026-09-29). Each committed file under a mapped output is taken
// back with a `!` entry (core's A-44): not cleaned, not saved, not restored,
// still an input. The task keeps its cache.

import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { outputsOverlap } from '@vzn/vx'

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

/**
 * Per project directory (root-relative, `.` or empty for the root), the
 * extensions (lower case, no dot) of the files git tracks under it at any
 * depth: what a top-level output glob may not claim (`wildcardOutput`).
 */
export function trackedExtensions(
  tracked: readonly string[],
): (rel: string) => ReadonlySet<string> {
  const memo = new Map<string, ReadonlySet<string>>()
  return (rel) => {
    let exts = memo.get(rel)
    if (exts === undefined) {
      const set = new Set<string>()
      for (const f of tracked) {
        if (rel !== '' && rel !== '.' && !f.startsWith(`${rel}/`)) continue
        const ext = path.posix.extname(f)
        if (ext !== '') set.add(ext.slice(1).toLowerCase())
      }
      memo.set(rel, (exts = set))
    }
    return exts
  }
}

/**
 * What moves when the tracked set can: the HEAD reflog's size (a commit, a
 * checkout, a pull appends to it) and HEAD itself. A stat and a small read,
 * so a kept mapping stays a hit between commits. A file `git add`ed and not
 * yet committed is seen at the next mapping.
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
      return `${head.trim()}\0${log?.size ?? ''}`
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

/** Past this many, a task's take-backs cost its runs more than its cache saves. */
const MAX_SPARED = 16

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
    const rel = path.relative(root, p.dir).split(path.sep).join('/')
    const own =
      rel === ''
        ? tracked
        : tracked.filter((f) => f.startsWith(`${rel}/`)).map((f) => f.slice(rel.length + 1))
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
