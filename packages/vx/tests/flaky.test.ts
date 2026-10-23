// Local flaky-task detection, end to end through the real CLI: a task that
// passes and then fails on the SAME cache key is named on its row and
// listed by `vx info` — from the run history alone,
// no service. The controls are the things that look like a flake and are
// not: a first pass after failures (a recovery), a hit (nothing executed)
// and a failure on a changed key (a break).

import { rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 60_000

// Green only when a file OUTSIDE the task's inputs exists: the key never
// moves, the outcome does.
const APP_CONFIG = `
  export default {
    tasks: {
      test: {
        exec: { command: 'test -f ../../green' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
      },
    },
  }
`

// The retries fixture from retries.test.ts: the first attempt plants a
// flag and fails, the retry sees it and passes.
const BREAK_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'exit 3', retries: 2 },
        inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } },
      },
    },
  }
`

const RETRY_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: {
          command: 'if test -f flag.txt; then echo winning; else touch flag.txt; exit 1; fi',
          retries: 1,
        },
        inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } },
      },
    },
  }
`

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: out + err }
}

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1)!

/** The newest run's task rows, as `vx last --format json` prints them. */
async function lastRun(root: string): Promise<{ tasks: any[] }> {
  const proc = Bun.spawn([process.execPath, BIN, 'last', '--format', 'json'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const doc = JSON.parse(await new Response(proc.stdout).text()) as { tasks: any[] }
  return { tasks: doc.tasks.map((t) => ({ ...t, id: `${t.project}#${t.task}` })) }
}

describe('flaky-task detection (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-flaky-' })
    await addProject(root, 'app', { config: APP_CONFIG, files: { 'src/input.txt': 'v1\n' } })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a pass, then a failure on the same key: its row and vx info say so',
    async () => {
      const red = await vx(root, ['run', 'test', '--all'])
      expect(red.code).toBe(1)
      // The first failure on a key is a break until the key passes.
      expect(red.text).not.toContain('flaky -')
      const redSummary = await lastRun(root)

      // Control: a first pass after only failures is a recovery, not a flake.
      await writeFile(path.join(root, 'green'), '')
      const green = await vx(root, ['run', 'test', '--all'])
      expect(green.code).toBe(0)
      expect(green.text).not.toContain('flaky -')
      const greenSummary = await lastRun(root)

      // `--force`: the pass was cached, and a hit executes nothing.
      await unlink(path.join(root, 'green'))
      const relapse = await vx(root, ['run', 'test', '--all', '--force'])
      expect(relapse.code).toBe(1)
      expect(relapse.text).toContain('app#test flaky - passed 1× before')
      // Nothing prints below the footer: its time row is the last word.
      expect(lastLine(relapse.text)).toMatch(/^ {2}time {6}/)
      const relapseSummary = await lastRun(root)
      expect(relapseSummary.tasks[0].id).toBe('app#test')
      // Same key every time: the claim is "same inputs", so prove it.
      expect(relapseSummary.tasks[0].hash).toBe(redSummary.tasks[0].hash)
      expect(greenSummary.tasks[0].hash).toBe(redSummary.tasks[0].hash)

      // Once relapsed, a pass on the key is named too.
      await writeFile(path.join(root, 'green'), '')
      const again = await vx(root, ['run', 'test', '--all', '--force'])
      expect(again.code).toBe(0)
      expect(again.text).toContain('app#test flaky - failed 2× before')

      // Control: a hit executed nothing, so it proves nothing.
      const hit = await vx(root, ['run', 'test', '--all'])
      expect(hit.code).toBe(0)
      expect(hit.text).not.toContain('flaky -')

      // Control: a failure on a CHANGED key is a break, not a flake.
      await unlink(path.join(root, 'green'))
      await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
      const broken = await vx(root, ['run', 'test', '--all'])
      expect(broken.code).toBe(1)
      expect(broken.text).not.toContain('flaky -')
      const brokenSummary = await lastRun(root)
      expect(brokenSummary.tasks[0].hash).not.toBe(redSummary.tasks[0].hash)

      // The doctor's standing list: one task, one flaky key, the counts.
      // The hit above replayed a pass already on record, so it adds none.
      const info = await vx(root, ['info'])
      expect(info.code).toBe(0)
      expect(info.text).toMatch(
        /^  flaky tasks +1 — app#test \(2 of 4 runs failed on unchanged inputs\)$/m,
      )
      const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
      expect(json.flakyTasks).toEqual([
        { taskId: 'app#test', project: 'app', task: 'test', keys: 1, passes: 2, failures: 2 },
      ])
    },
    TIMEOUT,
  )

  it(
    'a within-run retry is named as such, with no history needed',
    async () => {
      await addProject(root, 'retry', RETRY_CONFIG)
      const r = await vx(root, ['run', 'build', '--filter', 'retry'])
      expect(r.code).toBe(0)
      expect(r.text).toContain('retry#build flaky - 2 attempts')
      expect(lastLine(r.text)).toMatch(/^ {2}time {6}/)
      // The doctor's list said `none` over it: a retry's pass is one
      // success row with attempts 2, and no key held a failed row.
      const info = await vx(root, ['info'])
      expect(info.text).toMatch(
        /^  flaky tasks .*\bretry#build \(1 of 2 runs failed( on unchanged inputs)?\)/m,
      )
    },
    TIMEOUT,
  )

  // Every attempt failing on a key that never passed is a break: its row
  // said "flaky - 3 attempts", and a CI summary with it, where `vx info`
  // listed nothing (2026-10-23).
  it(
    'a retry that never passes is a break, not a flake',
    async () => {
      await addProject(root, 'broken', BREAK_CONFIG)
      const r = await vx(root, ['run', 'build', '--filter', 'broken'])
      expect(r.code).toBe(1)
      expect(r.text).toContain('broken#build')
      expect(r.text).not.toContain('flaky')
      expect((await vx(root, ['info'])).text).not.toContain('broken#build')
    },
    TIMEOUT,
  )
})

// Under --continue=always a task runs behind its failed dependency on the
// same key it had passed on; its failure is the dependency's, not a flake.
describe('a failure behind a failed dependency (--continue=always)', () => {
  it(
    'is not a flake on the key it had passed on',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-flaky-taint-' })
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                prep: { exec: { command: 'test -f ../../green' }, inputs: { files: ['src/**'] } },
                test: {
                  dependsOn: ['prep'],
                  exec: { command: 'test -f ../../green' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/input.txt': 'v1\n' },
        })
        await writeFile(path.join(root, 'green'), '')
        const green = await vx(root, ['run', 'test', '--all'])
        expect(green.code).toBe(0)
        const greenTest = (await lastRun(root)).tasks
        await unlink(path.join(root, 'green'))
        const red = await vx(root, ['run', 'test', '--all', '--force', '--continue=always'])
        expect(red.code).toBe(1)
        const redTasks = (await lastRun(root)).tasks
        const test = (ts: { id: string }[]) => ts.find((t) => t.id === 'app#test') as any
        // The positive first: it ran and failed on the key it had passed on.
        expect([test(redTasks).status, test(redTasks).hash]).toEqual([
          'failed',
          test(greenTest).hash,
        ])
        expect(red.text).not.toContain('flaky -')
        const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
        expect(json.flakyTasks).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A pass behind a failed dependency is no pass on the key: the bytes it
// built on were not the key's. A healthy failure later is a break.
describe('a pass behind a failed dependency (--continue=always)', () => {
  it(
    'is not a pass a later failure on the key relapses from',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-flaky-taint-pass-' })
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                prep: { exec: { command: 'test -f ../../prep-ok' }, inputs: { files: ['src/**'] } },
                test: {
                  dependsOn: ['prep'],
                  exec: { command: 'test -f ../../test-ok' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/input.txt': 'v1\n' },
        })
        await writeFile(path.join(root, 'test-ok'), '')
        const tainted = await vx(root, ['run', 'test', '--all', '--continue=always'])
        expect(tainted.code).toBe(1)
        const test = async () => (await lastRun(root)).tasks.find((t) => t.id === 'app#test')
        const before = await test()
        await writeFile(path.join(root, 'prep-ok'), '')
        await unlink(path.join(root, 'test-ok'))
        const red = await vx(root, ['run', 'test', '--all'])
        expect(red.code).toBe(1)
        // The positive first: it passed tainted, then failed healthy, on one key.
        const after = await test()
        expect([before.status, after.status, after.hash]).toEqual([
          'success',
          'failed',
          before.hash,
        ])
        expect(red.text).not.toContain('flaky -')
        const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
        expect(json.flakyTasks).toEqual([])
        // Control: a healthy pass on the key, then a healthy failure, is a flake.
        await writeFile(path.join(root, 'test-ok'), '')
        expect((await vx(root, ['run', 'test', '--all', '--force'])).code).toBe(0)
        await unlink(path.join(root, 'test-ok'))
        const relapse = await vx(root, ['run', 'test', '--all', '--force'])
        expect(relapse.code).toBe(1)
        expect(relapse.text).toContain('flaky - passed 1× before')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a failure behind it, then a healthy pass, is no flake either',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-flaky-taint-fail-' })
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                prep: { exec: { command: 'test -f ../../green' }, inputs: { files: ['src/**'] } },
                test: {
                  dependsOn: ['prep'],
                  exec: { command: 'test -f ../../green' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/input.txt': 'v1\n' },
        })
        const red = await vx(root, ['run', 'test', '--all', '--continue=always'])
        expect(red.code).toBe(1)
        await writeFile(path.join(root, 'green'), '')
        const green = await vx(root, ['run', 'test', '--all', '--force'])
        expect(green.code).toBe(0)
        expect(green.text).not.toContain('flaky -')
        const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
        expect(json.flakyTasks).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A task with no cache block keys on its inputs alone: a run's row never
// calls it flaky, and the doctor's list did for thirty days.
describe('a task with no cache block', () => {
  it(
    'is not on the flaky list after a pass and a failure',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-flaky-uncached-' })
      try {
        await addProject(root, 'app', {
          config: `export default { tasks: { check: { exec: { command: 'test -f ../../green' }, inputs: { files: [] } } } }`,
        })
        await writeFile(path.join(root, 'green'), '')
        expect((await vx(root, ['run', 'check', '--all'])).code).toBe(0)
        const greenHash = (await lastRun(root)).tasks[0].hash
        await unlink(path.join(root, 'green'))
        expect((await vx(root, ['run', 'check', '--all'])).code).toBe(1)
        // The positive first: one key, a pass then a failure.
        expect((await lastRun(root)).tasks[0].hash).toBe(greenHash)
        const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
        expect(json.flakyTasks).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
