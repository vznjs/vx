// Local flaky-task detection, end to end through the real CLI: a task that
// fails and then passes on the SAME cache key is named in the footer, typed
// in `--summarize`, and listed by `vx info` — from the run history alone,
// no service. The controls are the two things that look like a flake and
// are not: a hit (nothing executed) and a failure on a changed key (a
// break).

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
    'a failure, then a pass on the same key: footer, --summarize and vx info all say so',
    async () => {
      const red = await vx(root, ['run', 'test', '--all', '--summarize=red.json'])
      expect(red.code).toBe(1)
      // The first failure on a key is a break until the key passes.
      expect(red.text).not.toContain('Flaky:')
      const redSummary = JSON.parse(await readFile(path.join(root, 'red.json'), 'utf8'))
      expect(redSummary.tasks[0].flaky).toBeUndefined()

      await writeFile(path.join(root, 'green'), '')
      const green = await vx(root, ['run', 'test', '--all', '--summarize=green.json'])
      expect(green.code).toBe(0)
      expect(green.text).toContain(
        'Flaky:    1 task with the same inputs both passing and failing on record',
      )
      expect(green.text).toContain('✓ app#test — passed on inputs that failed 1× before')
      const greenSummary = JSON.parse(await readFile(path.join(root, 'green.json'), 'utf8'))
      expect(greenSummary.tasks[0].id).toBe('app#test')
      expect(greenSummary.tasks[0].flaky).toEqual({ passes: 1, failures: 1, attempts: 1 })
      // Same key both times: the claim is "same inputs", so prove it.
      expect(greenSummary.tasks[0].hash).toBe(redSummary.tasks[0].hash)

      // Control: a hit executed nothing, so it proves nothing.
      const hit = await vx(root, ['run', 'test', '--all'])
      expect(hit.code).toBe(0)
      expect(hit.text).not.toContain('Flaky:')

      // Control: a failure on a CHANGED key is a break, not a flake.
      await unlink(path.join(root, 'green'))
      await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
      const broken = await vx(root, ['run', 'test', '--all', '--summarize=broken.json'])
      expect(broken.code).toBe(1)
      expect(broken.text).not.toContain('Flaky:')
      const brokenSummary = JSON.parse(await readFile(path.join(root, 'broken.json'), 'utf8'))
      expect(brokenSummary.tasks[0].flaky).toBeUndefined()
      expect(brokenSummary.tasks[0].hash).not.toBe(redSummary.tasks[0].hash)

      // The doctor's standing list: one task, one mixed key, the counts —
      // the hit above is a pass on that key too (it replayed one).
      const info = await vx(root, ['info'])
      expect(info.code).toBe(0)
      expect(info.text).toMatch(
        /^flaky tasks: +1 — app#test \(1 of 3 runs failed on unchanged inputs\)$/m,
      )
      const json = JSON.parse((await vx(root, ['info', '--format', 'json'])).text)
      expect(json.flakyTasks).toEqual([
        { taskId: 'app#test', project: 'app', task: 'test', keys: 1, passes: 2, failures: 1 },
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
      expect(r.text).toContain('✓ retry#build — passed · 2 attempts this run')
      const summary = JSON.parse(await readFile(path.join(root, 'retry.json'), 'utf8'))
      expect(summary.tasks[0].flaky).toEqual({ passes: 1, failures: 0, attempts: 2 })
    },
    TIMEOUT,
  )
})
