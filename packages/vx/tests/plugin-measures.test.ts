// A plugin's measures (a worker's warm-up) are timed as tasks are: declared
// with a definition before `schedule`, which hands every plugin them all,
// reported by `ctx.measure`, heard as `onMeasure`, and kept in history at
// the run's end, read back by `measuresFor` (2026-11-11).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, indexDb } from '../src/cache/index.js'
import { localHistory } from '../src/history/index.js'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

let fixture: Fixture
beforeEach(async () => {
  fixture = await makeWorkspace('vx-plugin-measures-')
})
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)['__measures']
})

type Seen = {
  declared?: [string, string][]
  heard: unknown[]
  refused: string[]
}

async function measuredRun(ms: number, cores?: number): Promise<Seen> {
  const seen: Seen = { heard: [], refused: [] }
  ;(globalThis as Record<string, unknown>)['__measures'] = seen
  await addProject(fixture.root, 'p', {
    config: `export default { name: 'p', tasks: { a: { exec: { command: 'true' } } } }\n`,
  })
  await Bun.write(
    path.join(fixture.root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
      'org/meter',
      `{
        measures() {
          return new Map([['org/meter#warm-up', 'def-1'], ['p#a', 'def-2'], ['other#x', 'def-3']])
        },
        schedule(nodes, ctx) { globalThis.__measures.declared = [...ctx.measures] },
        setup(ctx) {
          const seen = globalThis.__measures
          ctx.on('onMeasure', (m) => seen.heard.push({ ...m }))
          ctx.on('onTaskComplete', () => {
            for (const bad of [
              { id: 'other#x', def: 'd', durationMs: 1 },
              { id: 'org/meter#x', def: '', durationMs: 1 },
              { id: 'org/meter#x', def: 'd', durationMs: -1 },
              { id: 'org/meter#x', def: 'd', durationMs: 1, cores: Infinity },
            ])
              try { ctx.measure(bad) } catch (err) { seen.refused.push(err.message) }
            ctx.measure({ id: 'org/meter#warm-up', def: 'def-1', durationMs: 1, cores: 9 })
            ctx.measure({ id: 'org/meter#warm-up', def: 'def-1', durationMs: ${ms}${cores === undefined ? '' : `, cores: ${cores}`} })
          })
        },
      }`,
    )}] }\n`,
  )
  const result = await run({ cwd: fixture.root, tasks: ['a'], log: silentLogger(fixture) })
  expect(result.ok).toBe(true)
  return seen
}

/** What history forecasts for the measure, under its definition `def`. */
function forecast(def: string): unknown {
  const cache = new Cache(path.join(fixture.root, '.vx', 'cache'))
  try {
    return localHistory(cache, { defs: new Map([['org/meter#warm-up', def]]) })
      .measuresFor(['org/meter#warm-up'])
      .get('org/meter#warm-up')
  } finally {
    cache.close()
  }
}

it(
  'a declared measure reaches every schedule, is heard, and is kept as a timing',
  async () => {
    const seen = await measuredRun(1500, 2.5)
    // A task's id and another plugin's name are no measure of this plugin.
    expect(seen.declared).toEqual([['org/meter#warm-up', 'def-1']])
    expect(seen.heard).toEqual([
      { id: 'org/meter#warm-up', def: 'def-1', durationMs: 1, cores: 9 },
      { id: 'org/meter#warm-up', def: 'def-1', durationMs: 1500, cores: 2.5 },
    ])
    expect(seen.refused).toHaveLength(4)
    expect(seen.refused[0]).toContain("is not 'org/meter#<name>'")
    // The run's last of an id is kept, once.
    expect(forecast('def-1')).toEqual({ durationMs: 1500, cores: 2.5 })
    const cache = new Cache(path.join(fixture.root, '.vx', 'cache'))
    try {
      const rows = indexDb(cache)
        .query(`SELECT COUNT(*) AS n FROM task_durations WHERE project = 'org/meter'`)
        .get() as { n: number }
      expect(rows.n).toBe(1)
    } finally {
      cache.close()
    }
  },
  TIMEOUT,
)

it(
  'the forecast is the median of the newest runs, and a new definition starts over',
  async () => {
    await measuredRun(1000, 2)
    await measuredRun(3000, 1)
    await measuredRun(2000, 3)
    expect(forecast('def-1')).toEqual({ durationMs: 2000, cores: 2 })
    expect(forecast('def-other')).toBeUndefined()
  },
  TIMEOUT,
)
