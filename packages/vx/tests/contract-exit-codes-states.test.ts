// The exit codes contract-exit-codes.test.ts left out: those that need a
// state first (a lock that is missing or drifted, a run recorded or not),
// the three a signal gives, and `completions`'. cli.md documents each, and CI scripts branch on them (a cancelled
// job reads 130/143, a stale lock 1), but nothing recorded them, so a
// change passed every contract test. Recorded in
// `tests/contract/exit-codes-states.json`; the break law reads it by lost
// leaves, a changed code included.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-exit-codes-states.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'exit-codes-states.json')
const env = { ...process.env, NO_COLOR: '1', VX_KILL_GRACE_MS: '200' }

let root: string
const config = (command: string): string => `export default {
  tasks: {
    build: { exec: { command: ${JSON.stringify(command)} } },
    hang: { exec: { command: 'echo up > "$MARK"; exec sleep 30', env: { passThrough: ['MARK'] } } },
  },
}
`

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-exit-states-' })
  await addProject(root, 'a', { config: config('true') })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]): number {
  return Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode
}

/** `vx run hang`, sent `signal` once the task has written its marker. */
async function interrupted(signal: NodeJS.Signals, n: number): Promise<number> {
  const mark = path.join(root, `mark-${n}`)
  const child = Bun.spawn({
    cmd: [process.execPath, BIN, 'run', 'hang', '--all'],
    cwd: root,
    env: { ...env, MARK: mark },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  // The marker's content, not its existence: a file the task is about to
  // write may exist empty first.
  const deadline = Date.now() + 20_000
  while (
    (await Bun.file(mark)
      .text()
      .catch(() => '')) !== 'up\n'
  ) {
    if (Date.now() > deadline) throw new Error(`hang never started (${signal})`)
    await Bun.sleep(20)
  }
  child.kill(signal)
  return await child.exited
}

it('each stateful and signalled outcome exits as tests/contract/exit-codes-states.json records', async () => {
  const live: Record<string, number> = {}
  live['why: no recorded run: vx why build'] = vx('why', 'build')
  live['last: no recorded run: vx last'] = vx('last')
  live['lock --check: no lock: vx lock --check'] = vx('lock', '--check')
  live['run --frozen: no lock: vx run build --all --frozen'] = vx(
    'run',
    'build',
    '--all',
    '--frozen',
  )
  expect(vx('lock')).toBe(0)
  // The control: the drift below, not the fixture, is what fails the check.
  expect(vx('lock', '--check')).toBe(0)
  await Bun.write(path.join(root, 'packages', 'a', 'vx.config.mjs'), config('echo drift'))
  live['lock --check: a config drifted: vx lock --check'] = vx('lock', '--check')
  live['show: an unknown target: vx show nope'] = vx('show', 'nope')
  expect(vx('run', 'build', '--all')).toBe(0)
  live['why: a recorded run: vx why build'] = vx('why', 'build')
  live['why: a run with no row for the task: vx why build --run nope'] = vx(
    'why',
    'build',
    '--run',
    'nope',
  )
  live['last: a recorded run: vx last'] = vx('last')
  live['last: an unknown run id: vx last nope'] = vx('last', 'nope')
  live['completions: an unknown shell: vx completions nope'] = vx('completions', 'nope')
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const [i, s] of signals.entries())
    live[`run: interrupted by ${s}: vx run hang --all`] = await interrupted(s, i)
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
}, 90_000)
