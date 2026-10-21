// A key that folds a keyless task (exec, no inputs) is never read or saved
// (execute-task.ts), so one keyless task under `install` made every core
// shard miss on every run, CI included, until check.bun got inputs.

import { expect, it } from 'bun:test'
import config from '../vx.config.js'

it('no cached task in core depends on a keyless task', () => {
  const tasks = config.tasks as Record<
    string,
    { exec?: unknown; inputs?: unknown; cache?: unknown; dependsOn?: readonly string[] }
  >
  const keylessUnder = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return []
    seen.add(name)
    const task = tasks[name]
    if (task === undefined) return []
    const own = task.exec !== undefined && task.inputs === undefined ? [name] : []
    const deps = (task.dependsOn ?? []).filter((d) => !d.includes('^') && !d.includes('#'))
    return [...own, ...deps.flatMap((d) => keylessUnder(d, seen))]
  }
  const poisoned = Object.entries(tasks)
    .filter(([, t]) => t.cache !== undefined)
    .flatMap(([name]) => keylessUnder(name).map((k) => `${name} <- ${k}`))
  expect(poisoned).toEqual([])
})
