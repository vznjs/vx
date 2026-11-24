// One run of every outcome at once — a hit, misses, a failure, a timeout,
// a skipped dependant, a death by signal — read back four ways: the exit
// code, the footer, `vx last` and `vx last --format json`. Each says what
// the others say.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, git, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
let dir: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

interface Row {
  task: string
  status: string
  exitCode: number
  outputBytes: number | null
  timedOut: boolean | null
  blockedBy: string | null
}
const last = () =>
  JSON.parse(vx('last', '--format', 'json').out) as {
    invocation: Record<string, number | boolean>
    tasks: Row[]
  }

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-mixed-outcomes-' })
  dir = await addProject(
    root,
    'm',
    `const c = (command, more = {}) => ({ exec: { command, ...more.exec }, inputs: { files: [more.input ?? 'in.txt'] }, outputs: { files: more.out === undefined ? [] : [more.out] }, cache: true, ...more.task })
export default { tasks: {
  hit: c('echo hit', { input: 'hit.txt' }),
  miss: c('mkdir -p omiss && printf 12345 > omiss/x', { out: 'omiss/**' }),
  // Fails with 5 bytes written; the one nothing depends on as well.
  fail: c('mkdir -p ofail && printf 12345 > ofail/x && exit 3', { out: 'ofail/**' }),
  lone: c('mkdir -p olone && printf 12345 > olone/x && exit 3', { out: 'olone/**' }),
  slow: c('sleep 5', { exec: { timeout: '500ms' } }),
  dep: c('echo dep', { task: { dependsOn: ['fail'] } }),
  sig: c('kill -9 $$'),
  long: c('sleep 5'),
} }
`,
  )
  await writeFile(path.join(dir, 'in.txt'), '1\n')
  await writeFile(path.join(dir, 'hit.txt'), '1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'm')
  expect(vx('run', 'm#hit').code).toBe(0)
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const ALL = ['m#hit', 'm#miss', 'm#fail', 'm#lone', 'm#slow', 'm#dep', 'm#sig']

it('says one count of every outcome in the exit, the footer, vx last and its json', () => {
  const r = vx('run', ...ALL)
  expect(r.code).toBe(1)
  expect(r.out).toContain('tasks     4 failed · 2 success · 1 skipped · 7 total')
  const { invocation, tasks } = last()
  expect(invocation).toMatchObject({ taskCount: 7, failedCount: 4, hitCount: 1, exitOk: false })
  const by = Object.fromEntries(tasks.map((t) => [t.task, t]))
  expect(Object.keys(by).sort()).toEqual(['dep', 'fail', 'hit', 'lone', 'miss', 'sig', 'slow'])
  expect(by['slow']!.timedOut).toBe(true)
  expect(by['dep']).toMatchObject({ status: 'skipped', blockedBy: 'm#fail' })
  expect(by['sig']).toMatchObject({ status: 'failed', exitCode: 137 })
  const pretty = vx('last').out
  expect(pretty).toContain('7 tasks · 1 hit (1 up-to-date, 0 restored) · 4 failed')
})

// A failed miss's row named the bytes it wrote only when a task depended on
// it: `fail` read 5 B, `lone`, the same command with no dependant, `—`.
it('names the bytes a failed task wrote whether or not a task depends on it', () => {
  vx('run', ...ALL)
  const by = Object.fromEntries(last().tasks.map((t) => [t.task, t]))
  expect([by['fail']!.outputBytes, by['lone']!.outputBytes, by['miss']!.outputBytes]).toEqual([
    5, 5, 5,
  ])
})

// A --fail-fast run kills what still runs: the footer counts it aborted, and
// `vx last` read the same run with those tasks gone and nothing saying so.
it('counts the tasks --fail-fast killed in vx last as the footer does', () => {
  const r = vx('run', 'm#lone', 'm#long', '--fail-fast')
  expect(r.code).toBe(1)
  expect(r.out).toContain('tasks     1 failed · 1 aborted · 2 total')
  const { invocation } = last()
  expect(invocation).toMatchObject({ taskCount: 1, failedCount: 1, abortedCount: 1 })
  expect(vx('last').out).toContain('1 task · 0 hits · 1 failed · 1 aborted')
})
