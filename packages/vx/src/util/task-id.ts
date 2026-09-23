/**
 * The inverse of `taskId` (`graph/task-graph.ts`). Splits on the FIRST
 * `#`, so a task name that itself contains one round-trips: `taskId('a', 'b#c')` → `'a#b#c'` → `['a', 'b#c']`.
 *
 * This exists because it kept being written by hand as `id.split('#', 2)`,
 * which is NOT the inverse — it discards everything after the second segment,
 * so `'a#b#c'` reads back as task `'b'`. Six call sites had that form while
 * `parseDependencySpec` (the surface that decides what actually runs) has
 * always split on the first `#`, so the query layer and the graph disagreed
 * about the identity of the same task: a lookup either found nothing or, worse,
 * answered with a different task's history.
 *
 * A `#`-containing task name is legal and pinned elsewhere in the suite, so
 * this is reachable rather than theoretical. The cache's run history read
 * the same rule from a private copy until item 646; one rule, one place.
 */
export function splitTaskId(id: string): [project: string, task: string] {
  const i = id.indexOf('#')
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]
}
