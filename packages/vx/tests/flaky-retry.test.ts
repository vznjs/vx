// A task known to be flaky gets one more attempt with no `retries` set:
// the run history proved its key nondeterministic (it failed and passed on
// the same inputs). A task with no such record, an explicit `retries: 0`
// and a timeout never get one.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 60_000

// Fails once per `once` file outside its inputs: the key never moves.
const flip = (name: string, exec: string, fail = 'exit 1'): string => `
  export default {
    tasks: {
      test: {
        exec: { command: 'if test -f ../../once-${name}; then rm ../../once-${name}; ${fail}; fi'${exec} },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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

describe('a known-flaky task is retried once', () => {
  let root: string
  const once = (p: string) => writeFile(path.join(root, `once-${p}`), '')
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-flaky-retry-' })
    await addProject(root, 'twice', {
      config: `export default { tasks: { test: {
        exec: { command: 'echo said-before-exit; exit 2', retries: 1 },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
      } } }`,
      files: { 'src/input.txt': 'v1\n' },
    })
    for (const p of ['app', 'fresh', 'off', 'slow'])
      await addProject(root, p, {
        config:
          p === 'slow'
            ? flip(p, ", timeout: '1s'", 'sleep 5')
            : flip(p, p === 'off' ? ', retries: 0' : ''),
        files: { 'src/input.txt': 'v1\n' },
      })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'with no record, a failure is final; once the key passed, a failure gets a second attempt',
    async () => {
      // Control: no history, so no retry.
      await once('fresh')
      const fresh = await vx(root, ['run', 'test', '--filter', 'fresh'])
      expect(fresh.code).toBe(1)
      expect(fresh.text).not.toContain('retrying')
      expect(fresh.text).not.toContain('attempts')

      const pass = await vx(root, ['run', 'test', '--filter', 'app'])
      expect(pass.code).toBe(0)
      // The same key failing after it passed is the flake itself: retried.
      await once('app')
      const flake = await vx(root, ['run', 'test', '--filter', 'app', '--force'])
      expect(flake.code).toBe(0)
      expect(flake.text).toContain('app#test flaky - 2 attempts')
      // Its log keeps the failed attempt, then the pass.
      const log = await vx(root, ['last', '--log', 'app#test'])
      expect(log.text).toContain('── attempt 1 of 2 · exit 1 ──')
      expect(log.text).toContain('── attempt 2 of 2 · passed ──')

      // Known flaky now: a failure on a NEW key is retried too.
      await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
      await once('app')
      const next = await vx(root, ['run', 'test', '--filter', 'app'])
      expect(next.code).toBe(0)
      expect(next.text).toContain('app#test flaky - 2 attempts')
    },
    TIMEOUT,
  )

  it(
    'an explicit retries: 0 wins over the record',
    async () => {
      expect((await vx(root, ['run', 'test', '--filter', 'off'])).code).toBe(0)
      await once('off')
      const r = await vx(root, ['run', 'test', '--filter', 'off', '--force'])
      expect(r.code).toBe(1)
      expect(r.text).not.toContain('retrying')
      expect(r.text).not.toContain('attempts')
    },
    TIMEOUT,
  )

  it(
    'a timeout is never retried',
    async () => {
      expect((await vx(root, ['run', 'test', '--filter', 'slow'])).code).toBe(0)
      await once('slow')
      const r = await vx(root, ['run', 'test', '--filter', 'slow', '--force'])
      expect(r.code).toBe(1)
      expect(r.text).not.toContain('retrying')
      expect(r.text).not.toContain('attempts')
    },
    TIMEOUT,
  )

  it(
    "a task that failed every attempt keeps each attempt's output",
    async () => {
      const r = await vx(root, ['run', 'test', '--filter', 'twice'])
      expect(r.code).toBe(1)
      const log = await vx(root, ['last', '--log', 'twice#test'])
      expect(log.text).toContain(
        '── attempt 1 of 2 · exit 2 ──\nsaid-before-exit\n── attempt 2 of 2 · exit 2 ──\nsaid-before-exit',
      )
    },
    TIMEOUT,
  )
})
