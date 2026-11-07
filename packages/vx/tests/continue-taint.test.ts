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
import { gitIn, gitInitCommit } from './helpers/workspace.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

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
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
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
      inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] }, cache: true,
    },
    b: {
      dependsOn: ['a'],
      exec: { command: 'mkdir -p dist && cat out/a.txt > dist/b.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    },
    c: {
      dependsOn: ['b'],
      exec: { command: 'echo c > c.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['c.txt'] }, cache: true,
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

  // A plugin hears only the outcome (vx-history's flaky record sent such a
  // pass, and fresh machines retried a real failure as a flake), so the
  // taint rides it by the time any observer hears it.
  it('the outcome each observer hears names the failure it ran behind', async () => {
    await writeFile(path.join(root, 'packages', 'p', 'flag.txt'), '')
    const heard: string[] = []
    const r = await run({
      cwd: root,
      tasks: ['c'],
      projects: ['p'],
      continueMode: 'always',
      log: {
        ...silent,
        taskComplete: (node, o) => heard.push(`${node.id} ${o.status} ${o.taintedBy}`),
      },
      handleSignals: false,
    })
    expect(r.ok).toBe(false)
    expect(heard).toEqual(['p#a failed undefined', 'p#b success p#a', 'p#c success p#a'])
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

// C-1: the taint crossed a failure only when the task between it and the
// dependent executed. A confirmed local hit runs on the restore tier, ahead
// of its deps, so it was judged against holes and passed nothing on:
// `ship` saved the failed `gen`'s partial output on its healthy key, and the
// next healthy run restored PARTIAL. The same graph with `pack` executing
// (its input edited) never saved `ship`.
describe('--continue=always carries the taint through a restore-tier hit', () => {
  it('a dependent of a hit whose dep failed is not saved, so a healthy run rebuilds it', async () => {
    const dir = path.join(root, 'packages', 'p')
    // `gen` has no cache, so its key includes its project's tree: it lives
    // apart from what `pack` and `ship` write, and its flag and its output
    // sit outside the workspace, so failing moves no key: `pack` stays a
    // local hit and the healthy run asks for the same `ship` key.
    const genDir = path.join(root, 'packages', 'g')
    const flag = `${root}.flag`
    const gen = `${root}.gen.txt`
    await mkdir(genDir)
    await writeFile(path.join(genDir, 'package.json'), '{"name":"g"}')
    await writeFile(
      path.join(genDir, 'vx.config.mjs'),
      `export default {
  tasks: {
    // Slow to fail: the hit below restores while gen is still running.
    gen: { exec: { command: 'if [ -f ${flag} ]; then sleep 0.3; echo PARTIAL > ${gen}; exit 1; fi; echo GOOD > ${gen}' }, inputs: { files: [] } },
  },
}
`,
    )
    await writeFile(path.join(dir, 'src', 'p.txt'), 'p\n')
    await writeFile(path.join(dir, 'src', 's.txt'), 's1\n')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
  tasks: {
    pack: {
      dependsOn: ['g#gen'],
      exec: { command: 'echo packed > pack.txt' },
      inputs: { files: ['src/p.txt'] }, outputs: { files: ['pack.txt'] }, cache: true,
    },
    ship: {
      dependsOn: ['pack'],
      exec: { command: 'cat ${gen} > ship.txt' },
      inputs: { files: ['src/s.txt'] }, outputs: { files: ['ship.txt'] }, cache: true,
    },
  },
}
`,
    )
    // Committed: a key over untracked files is not stable, and only a
    // stable hit runs on the restore tier.
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'restore-tier fixture')
    const runShip = (continueMode?: 'always') =>
      run({
        cwd: root,
        tasks: ['ship'],
        projects: ['p'],
        ...(continueMode !== undefined ? { continueMode } : {}),
        log: silent,
        handleSignals: false,
      })
    try {
      expect((await runShip()).ok).toBe(true)
      expect(statusOf(await runShip(), 'p#pack')).toBe('cache-hit')

      await writeFile(path.join(dir, 'src', 's.txt'), 's2\n')
      await writeFile(flag, '')
      const failing = await runShip('always')
      expect(['g#gen', 'p#pack', 'p#ship'].map((id) => statusOf(failing, id))).toEqual([
        'failed',
        'cache-hit',
        'success',
      ])

      await unlink(flag)
      await rm(path.join(dir, 'ship.txt'))
      const healthy = await runShip()
      expect(statusOf(healthy, 'p#ship')).toBe('success')
      expect(await Bun.file(path.join(dir, 'ship.txt')).text()).toBe('GOOD\n')
    } finally {
      await rm(flag, { force: true })
      await rm(gen, { force: true })
    }
  })
})

// `--exclude-dependencies` turns `t → gen → a` into an order-only edge
// `t → a`, and the key's upstream drops order-only edges. The taint read
// that same upstream, so under `--continue=always` `t` saved what it built
// after `a` failed, where the run without the flag (`t` behind `gen`
// behind `a`) withheld it.
describe('--continue=always taints through an order-only edge', () => {
  it('a task ordered after a failure by --exclude-dependencies is not saved', async () => {
    const dir = path.join(root, 'packages', 'p')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
  tasks: {
    a: {
      exec: { command: 'mkdir -p out && echo partial > out/a.txt && test ! -f flag.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] }, cache: true,
    },
    gen: {
      dependsOn: ['a'],
      exec: { command: 'cp out/a.txt gen.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['gen.txt'] }, cache: true,
    },
    t: {
      dependsOn: ['gen'],
      exec: { command: 'cat out/a.txt > t.txt' },
      inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['t.txt'] }, cache: true,
    },
  },
}
`,
    )
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'order-only fixture')
    const runT = (continueMode?: 'always') =>
      run({
        cwd: root,
        tasks: ['a', 't'],
        projects: ['p'],
        excludeDependencies: ['gen'],
        ...(continueMode !== undefined ? { continueMode } : {}),
        log: silent,
        handleSignals: false,
      })
    await writeFile(path.join(dir, 'flag.txt'), '')
    const failing = await runT('always')
    expect(['p#a', 'p#t'].map((id) => statusOf(failing, id))).toEqual(['failed', 'success'])

    await unlink(path.join(dir, 'flag.txt'))
    // Same key for `t` (the flag is no input, `tasks: []` folds no
    // upstream): a saved entry would read `cache-hit` here.
    expect(statusOf(await runT(), 'p#t')).toBe('success')
    // CONTROL: the key is stable, so the healthy run's save is a hit now.
    expect(statusOf(await runT(), 'p#t')).toBe('cache-hit')
  })
})
