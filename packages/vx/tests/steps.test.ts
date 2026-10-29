// vx's own steps are named `<owner>:<step>` (2026-10-15): `:` is no task
// id's separator, so a step never collides with a project named `vx` or a
// plugin package's own `#setup` task. No step is a task: the outcomes and
// the run history hold the tasks alone.

import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { runSteps } from '../src/orchestrator/index.js'
import { formatStepLine } from '../src/report/status-line.js'

const TASK = (project: string, task: string) => `
  export default { name: '${project}', tasks: { ${task}: { exec: { command: 'true' } } } }
`

it(
  'a step id never meets a task id, and no step is counted as a task',
  async () => {
    const fixture = await makeWorkspace('vx-steps-')
    try {
      await addProject(fixture.root, 'vx', { config: TASK('vx', 'keys') })
      await addProject(fixture.root, 'vx-sth', { config: TASK('vx-sth', 'setup') })
      await Bun.write(
        path.join(fixture.root, '.vx/workspace.mjs'),
        `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('vx-sth', '{ setup() {}, teardown() {} }')}] }\n`,
      )
      const steps: string[] = []
      const tasks: string[] = []
      const log = silentLogger(fixture)
      const result = await run({
        cwd: fixture.root,
        tasks: ['keys', 'setup'],
        log: {
          ...log,
          taskComplete(node, outcome) {
            tasks.push(node.id)
            log.taskComplete(node, outcome)
          },
          stepStart: (id) => steps.push(id),
          stepEnd() {},
        },
      })
      expect(result.ok).toBe(true)
      expect(tasks.toSorted()).toEqual(['vx#keys', 'vx-sth#setup'])
      expect(steps).toContain('vx:load')
      expect(steps).toContain('vx-sth:setup')
      expect(steps).toContain('vx-sth:teardown')
      expect(steps).toContain('vx:history')
      for (const id of steps) expect(id).toMatch(/^[^#]+:[^#:]+$/)
      expect(steps.filter((id) => tasks.includes(id))).toEqual([])
      expect(result.outcomes.map((o) => o.node.id).toSorted()).toEqual(tasks.toSorted())
      const db = new Database(path.join(fixture.root, '.vx/cache/cache.db'), { readonly: true })
      try {
        const rows = db.query('SELECT project, task FROM runs').all() as {
          project: string
          task: string
        }[]
        expect(rows.map((r) => `${r.project}#${r.task}`).toSorted()).toEqual(tasks.toSorted())
      } finally {
        db.close()
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  'CONTROL: a logger with no step hooks is told of none',
  async () => {
    const fixture = await makeWorkspace('vx-steps-off-')
    try {
      await addProject(fixture.root, 'vx', { config: TASK('vx', 'keys') })
      const result = await run({ cwd: fixture.root, tasks: ['keys'], log: silentLogger(fixture) })
      expect(result.ok).toBe(true)
      expect(fixture.log.some((l) => l.includes('vx:'))).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

// A run shows only the steps it waits on (2026-10-16). The remote
// prefetch runs beside the tasks: it showed as a row of its own, and a
// local run never had it. `vx last` keeps it for debugging.
const CACHED = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
      },
    },
  }
`

it(
  'a step the run does not wait on is never shown, and vx last keeps it',
  async () => {
    const fixture = await makeWorkspace('vx-steps-bg-')
    try {
      await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CACHED })
      const store = new Map<string, Uint8Array>()
      const steps: string[] = []
      const result = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: { ...silentLogger(fixture), stepStart: (id) => steps.push(id), stepEnd() {} },
        remoteCache: {
          has: async (hash) => (store.has(hash) ? {} : null),
          get: async (hash) => {
            const body = store.get(hash)
            return body === undefined ? null : { body: new Blob([body.slice()]), durationMs: 1 }
          },
          put: async (hash, body) => void store.set(hash, await body.bytes()),
        },
      })
      expect(result.ok).toBe(true)
      expect(steps).toContain('vx:uploads')
      expect(steps).not.toContain('vx:prefetch')
      const cacheDir = path.join(fixture.root, '.vx/cache')
      const db = new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
      const { run_id } = db.query('SELECT run_id FROM invocations').get() as { run_id: string }
      db.close()
      expect(runSteps(cacheDir, run_id).map((s) => [s.id, s.ok])).toEqual([['vx:prefetch', true]])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  'CONTROL: a run with no remote keeps no background steps',
  async () => {
    const fixture = await makeWorkspace('vx-steps-bg-off-')
    try {
      await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CACHED })
      const result = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(result.ok).toBe(true)
      expect(await Bun.file(path.join(fixture.root, '.vx/cache/steps')).exists()).toBe(false)
      expect(readdirSync(path.join(fixture.root, '.vx/cache'))).not.toContain('steps')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it('a step row reads as a task row, `internal` in the cache column', () => {
  expect(formatStepLine('vx:uploads', 4600, true)).toMatch(
    /^ ⏺︎ +4\.60s +success internal +local +vx:uploads$/,
  )
})
