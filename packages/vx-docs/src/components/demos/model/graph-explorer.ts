// The graph explorer's model (Product gap 5, 2026-10-13): what the page
// reads from a pasted `vx run … --dry=json` plan, and the questions it
// answers. The plan never leaves the browser; this file is pure so
// tests/graph-explorer.test.ts holds it to a real plan.

export interface PlanTask {
  id: string
  project: string
  task: string
  cacheStatus: string
  deps: string[]
  description?: string
}

export interface Graph {
  tasks: Map<string, PlanTask>
  /** id → the tasks that wait on it. */
  dependents: Map<string, string[]>
  criticalPath: string[]
}

/** Parses a `--dry=json` plan, or says in one line what the text is instead. */
export function parsePlan(text: string): Graph | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'Not JSON. Paste the output of `vx run <task> --all --dry=json`.' }
  }
  const plan = raw as { tasks?: unknown; predicted?: { criticalPath?: unknown }; ok?: unknown }
  if (plan.ok === false) {
    return { error: 'That is a vx error, not a plan. Run the command again and fix what it says.' }
  }
  if (!Array.isArray(plan.tasks)) {
    return { error: 'No "tasks" list. Paste the output of `vx run <task> --all --dry=json`.' }
  }
  const tasks = new Map<string, PlanTask>()
  for (const t of plan.tasks as Partial<PlanTask>[]) {
    if (typeof t.id !== 'string' || !Array.isArray(t.deps)) {
      return { error: 'A task without "id" or "deps". Is this a `--dry=json` plan?' }
    }
    tasks.set(t.id, {
      id: t.id,
      project: t.project ?? t.id.slice(0, t.id.lastIndexOf('#')),
      task: t.task ?? t.id.slice(t.id.lastIndexOf('#') + 1),
      cacheStatus: t.cacheStatus ?? 'unknown',
      deps: t.deps.filter((d): d is string => typeof d === 'string'),
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
    })
  }
  const dependents = new Map<string, string[]>()
  for (const t of tasks.values()) {
    for (const d of t.deps) dependents.set(d, [...(dependents.get(d) ?? []), t.id])
  }
  const cp = plan.predicted?.criticalPath
  const criticalPath = Array.isArray(cp) ? cp.filter((c): c is string => typeof c === 'string') : []
  return { tasks, dependents, criticalPath }
}

/** The tasks whose id contains every word of `query`, ids sorted. */
export function search(graph: Graph, query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return [...graph.tasks.keys()]
    .filter((id) => words.every((w) => id.toLowerCase().includes(w)))
    .sort()
}

/**
 * Why `from` waits on `to`: the shortest chain of `deps` edges from one to
 * the other, both ends included, or null when `from` never waits on `to`.
 */
export function whyDepends(graph: Graph, from: string, to: string): string[] | null {
  if (!graph.tasks.has(from) || !graph.tasks.has(to)) return null
  const prev = new Map<string, string | null>([[from, null]])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!
    if (at === to) {
      const path: string[] = []
      for (let n: string | null = to; n !== null; n = prev.get(n) ?? null) path.unshift(n)
      return path
    }
    for (const d of graph.tasks.get(at)?.deps ?? []) {
      if (prev.has(d)) continue
      prev.set(d, at)
      queue.push(d)
    }
  }
  return null
}

/** Every task `id` waits on, directly or through others. */
export function upstream(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>()
  const walk = (n: string) => {
    for (const d of graph.tasks.get(n)?.deps ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      walk(d)
    }
  }
  walk(id)
  return seen
}

const STATUS_WORDS: Record<string, string> = {
  'hit-local': 'cache hit (this machine)',
  'hit-remote': 'cache hit (remote)',
  miss: 'cache miss: runs',
  'no-cache': 'not cached: runs',
  group: 'group: runs nothing itself',
}

/** What the plan predicts for a task, in words. */
export function statusWords(status: string): string {
  return STATUS_WORDS[status] ?? status
}
