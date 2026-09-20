// `--continue=always` runs a task behind a failed upstream. Its key is the
// healthy one (pure-input hashing folds the upstream's INPUT key, which a
// failed outcome still carries), but its bytes came from a partial tree —
// so it must never be saved, or the next clean run replays them as a green
// hit. Pinned end-to-end: the second run, with the failure gone, must
// re-execute the dependent (and the grand-dependent built on it), where a
// saved entry would have made both `cache-hit`. The control is the same
// graph with no failure, where the second run IS a hit.

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitInitCommit } from './helpers/workspace.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

const silent: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-taint-'))
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture","workspaces":["packages/*"]}')
  const dir = path.join(root, 'packages', 'p')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"p"}')
  await writeFile(path.join(dir, 'src', 'in.txt'), 'in\n')
  // `a` fails while `flag.txt` exists. The flag is OUTSIDE every declared
  // input, so removing it changes no key: run 2 derives the same keys as
  // run 1, which is what makes a saved `b`/`c` entry a stale hit.
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default {
  tasks: {
    a: {
      exec: { command: 'mkdir -p out && echo partial > out/a.txt && test ! -f flag.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
    },
    b: {
      dependsOn: ['a'],
      exec: { command: 'mkdir -p dist && cat out/a.txt > dist/b.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    c: {
      dependsOn: ['b'],
      exec: { command: 'echo c > c.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['c.txt'] } },
    },
  },
}
`,
  )
  // The SHARED runner, not a private copy: it passes `commit.gpgsign=false`,
  // and a host whose git signs commits through an external helper cannot
  // reach that helper from inside the task sandbox (item 435).
  gitInitCommit(root, 'init')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const statusOf = (r: Awaited<ReturnType<typeof run>>, id: string): string =>
  r.outcomes.find((o) => o.node.id === id)!.status

const runAll = (continueMode?: 'always') =>
  run({
    cwd: root,
    tasks: ['c'],
    projects: ['p'],
    ...(continueMode !== undefined ? { continueMode } : {}),
    log: silent,
    handleSignals: false,
  })

describe('--continue=always never caches a task built behind a failure', () => {
  it('the dependent and its own dependent re-execute once the failure is gone', async () => {
    await writeFile(path.join(root, 'packages', 'p', 'flag.txt'), '')
    const first = await runAll('always')
    expect(first.ok).toBe(false)
    expect(statusOf(first, 'p#a')).toBe('failed')
    expect(statusOf(first, 'p#b')).toBe('success')
    expect(statusOf(first, 'p#c')).toBe('success')

    await unlink(path.join(root, 'packages', 'p', 'flag.txt'))
    const second = await runAll()
    expect(second.ok).toBe(true)
    expect(statusOf(second, 'p#a')).toBe('success')
    // Same keys as run 1 (the flag was never an input) — a saved entry
    // would read `cache-hit` here, and `dist/b.txt` would hold the partial
    // `out/a.txt` of the failed run.
    expect(statusOf(second, 'p#b')).toBe('success')
    expect(statusOf(second, 'p#c')).toBe('success')
  })

  it('CONTROL: with no failure, the second run is a hit for every task', async () => {
    const first = await runAll('always')
    expect(first.ok).toBe(true)
    const second = await runAll()
    expect(['p#a', 'p#b', 'p#c'].map((id) => statusOf(second, id))).toEqual([
      'cache-hit',
      'cache-hit',
      'cache-hit',
    ])
  })
})
