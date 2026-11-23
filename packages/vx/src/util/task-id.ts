/**
 * The inverse of `taskId` (`graph/task-graph.ts`): splits on the FIRST `#`,
 * as `parseDependencySpec` does, so `'a#b#c'` reads back as `['a', 'b#c']`
 * (`id.split('#', 2)` would drop `#c`). A config's task name holds no `#`,
 * but an id also arrives from run history and plugins.
 */
export function splitTaskId(id: string): [project: string, task: string] {
  const i = id.indexOf('#')
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]
}
