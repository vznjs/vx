// Local flaky-task detection, end to end through the real CLI: a task that
// passes and then fails on the SAME cache key is named on its row, typed
// in `--summarize`, and listed by `vx info` — from the run history alone,
// no service. The controls are the things that look like a flake and are
// not: a first pass after failures (a recovery), a hit (nothing executed)
// and a failure on a changed key (a break).

import { readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 60_000

// Green only when a file OUTSIDE the task's inputs exists: the key never
// moves, the outcome does.
const APP_CONFIG = `
  export default {
    tasks: {
      test: {
        exec: { command: 'test -f ../../green' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
    },
  }
`

// The retries fixture from retries.test.ts: the first attempt plants a
// flag and fails, the retry sees it and passes.
const RETRY_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: {
          command: 'if test -f flag.txt; then echo winning; else touch flag.txt; exit 1; fi',
          retries: 1,
        },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
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
    'a pass, then a failure on the same key: its row, --summarize and vx info all say so',
    async () => {
      const red = await vx(root, ['run', 'test', '--all', '--summarize=red.json'])
      expect(red.code).toBe(1)
      // The first failure on a key is a break until the key passes.
      expect(red.text).not.toContain('flaky -')
      const redSummary = JSON.parse(await readFile(path.join(root, 'red.json'), 'utf8'))
      expect(redSummary.tasks[0].flaky).toBeUndefined()

      // Control: a first pass after only failures is a recovery, not a flake.
      await writeFile(path.join(root, 'green'), '')
      const green = await vx(root, ['run', 'test', '--all', '--summarize=green.json'])
      expect(green.code).toBe(0)
      expect(green.text).not.toContain('flaky -')
      const greenSummary = JSON.parse(await readFile(path.join(root, 'green.json'), 'utf8'))
      expect(greenSummary.tasks[0].flaky).toBeUndefined()

      // `--force`: the pass was cached, and a hit executes nothing.
      await unlink(path.join(root, 'green'))
      const relapse = await vx(root, [
        'run',
        'test',
        '--all',
        '--force',
        '--summarize=relapse.json',
      ])
      expect(relapse.code).toBe(1)
      expect(relapse.text).toContain('app#test flaky - passed 1× before')
      // Nothing prints below the footer: its result line is the last word.
      expect(lastLine(relapse.text)).toMatch(/^ {2}result {4}1 task · /)
      const relapseSummary = JSON.parse(await readFile(path.join(root, 'relapse.json'), 'utf8'))
      expect(relapseSummary.tasks[0].id).toBe('app#test')
      expect(relapseSummary.tasks[0].flaky).toEqual({ passes: 1, failures: 2, attempts: 1 })
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
      const broken = await vx(root, ['run', 'test', '--all', '--summarize=broken.json'])
      expect(broken.code).toBe(1)
      expect(broken.text).not.toContain('flaky -')
      const brokenSummary = JSON.parse(await readFile(path.join(root, 'broken.json'), 'utf8'))
      expect(brokenSummary.tasks[0].flaky).toBeUndefined()
      expect(brokenSummary.tasks[0].hash).not.toBe(redSummary.tasks[0].hash)

      // The doctor's standing list: one task, one flaky key, the counts —
      // the hit above is a pass on that key too (it replayed one).
      const info = await vx(root, ['info'])
      expect(info.code).toBe(0)
      expect(info.text).toMatch(
        /^flaky tasks: +1 — app#test \(2 of 5 runs failed on unchanged inputs\)$/m,
      )
      const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
      expect(json.flakyTasks).toEqual([
        { taskId: 'app#test', project: 'app', task: 'test', keys: 1, passes: 3, failures: 2 },
      ])
    },
    TIMEOUT,
  )

  it(
    'a within-run retry is named as such, with no history needed',
    async () => {
      await addProject(root, 'retry', RETRY_CONFIG)
      const r = await vx(root, ['run', 'build', '--filter', 'retry', '--summarize=retry.json'])
      expect(r.code).toBe(0)
      expect(r.text).toContain('retry#build flaky - 2 attempts')
      expect(lastLine(r.text)).toMatch(/^ {2}result {4}1 task · /)
      const summary = JSON.parse(await readFile(path.join(root, 'retry.json'), 'utf8'))
      expect(summary.tasks[0].flaky).toEqual({ passes: 1, failures: 0, attempts: 2 })
      // The doctor's list said `none` over it: a retry's pass is one
      // success row with attempts 2, and no key held a failed row.
      const info = await vx(root, ['info'])
      expect(info.text).toMatch(
        /^flaky tasks: .*\bretry#build \(1 of 2 runs failed( on unchanged inputs)?\)/m,
      )
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
                prep: { exec: { command: 'test -f ../../green' } },
                test: {
                  dependsOn: ['prep'],
                  exec: { command: 'test -f ../../green' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/input.txt': 'v1\n' },
        })
        await writeFile(path.join(root, 'green'), '')
        const green = await vx(root, ['run', 'test', '--all', '--summarize=green.json'])
        expect(green.code).toBe(0)
        await unlink(path.join(root, 'green'))
        const red = await vx(root, [
          'run',
          'test',
          '--all',
          '--force',
          '--continue=always',
          '--summarize=red.json',
        ])
        expect(red.code).toBe(1)
        const greenTest = JSON.parse(await readFile(path.join(root, 'green.json'), 'utf8')).tasks
        const redTasks = JSON.parse(await readFile(path.join(root, 'red.json'), 'utf8')).tasks
        const test = (ts: { id: string }[]) => ts.find((t) => t.id === 'app#test') as any
        // The positive first: it ran and failed on the key it had passed on.
        expect([test(redTasks).status, test(redTasks).hash]).toEqual([
          'failed',
          test(greenTest).hash,
        ])
        expect(red.text).not.toContain('flaky -')
        expect(test(redTasks).flaky).toBeUndefined()
        const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
        // prep itself relapsed on its key; only app#test ran behind it.
        expect(json.flakyTasks.map((t: { taskId: string }) => t.taskId)).toEqual(['app#prep'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
