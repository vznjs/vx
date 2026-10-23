// Which cached tasks will miss, guessed before any worker can say: those
// whose inputs the last commit changed, and every task after one, its key
// folding theirs. The run learns a task missed only once a worker keys it,
// 20 s in: main a09b987's plan saw its 56 shards only then, and ended
// 14 s after the best (tests/sim.test.ts). The guess only sizes the run: a
// hit it names costs a worker the plan cancels, a miss it does not names
// the wait the run always had.

import type { TaskNode } from '@vzn/vx'

/** Root files every key reads: a lockfile, the workspace config. */
const WHOLE = /^(?:\.vx\/|(?:bun\.lockb?|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$)/
const GLOB = /[*?[{]/

/** Whether `rel` is one of `patterns`' files: a literal names a file or its tree; `!` entries are left out, so it errs to a miss. */
function matches(patterns: readonly string[] | undefined, rel: string): boolean {
  for (const raw of patterns ?? []) {
    if (raw.startsWith('!')) continue
    const p = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (GLOB.test(p) ? new Bun.Glob(p).match(rel) : rel === p || rel.startsWith(`${p}/`))
      return true
  }
  return false
}

/**
 * The cached tasks of `nodes` that `changed` (workspace-relative paths)
 * makes miss: a task whose `inputs` match one, whose project's
 * `package.json` or config is one, or after such a task.
 */
export function likelyMisses(
  nodes: ReadonlyMap<string, TaskNode>,
  changed: readonly string[],
  workspaceRoot: string,
): Set<string> {
  const out = new Set<string>()
  if (changed.length === 0) return out
  const whole = changed.some((p) => WHOLE.test(p))
  const root = workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`
  const own = (n: TaskNode): boolean => {
    const inputs = n.config.inputs
    if (inputs === undefined) return false
    if (whole) return true
    const dir = n.projectDir.startsWith(root) ? n.projectDir.slice(root.length) : ''
    for (const p of changed) {
      if (matches(inputs.workspaceFiles, p)) return true
      if (dir !== '' && !p.startsWith(`${dir}/`)) continue
      const rel = dir === '' ? p : p.slice(dir.length + 1)
      if (rel === 'package.json' || /^vx\.config\.[cm]?[jt]s$/.test(rel)) return true
      if (matches(inputs.files, rel)) return true
    }
    return false
  }
  const keyed = new Map<string, boolean>()
  const changes = (id: string): boolean => {
    const known = keyed.get(id)
    if (known !== undefined) return known
    keyed.set(id, false)
    const n = nodes.get(id)
    const c = n !== undefined && (own(n) || n.deps.some(changes))
    keyed.set(id, c)
    return c
  }
  for (const [id, n] of nodes)
    if (n.config.exec?.command !== undefined && n.config.cache !== undefined && changes(id))
      out.add(id)
  return out
}
