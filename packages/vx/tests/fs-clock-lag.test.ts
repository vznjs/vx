// A file's times come from the clock of the file system that holds it, and
// vx dates its own facts by `Date.now()`. Every racy window compares the two
// as if they were one clock. A workspace whose file system runs behind this
// process — a WSL2 VM drifted past the Windows host stamping `/mnt/c`, a
// Docker Desktop bind mount, an NFS server — dated an edit made while the
// command ran BEFORE the command, so the entry filed the edit's output under
// the key of the bytes before it, and restoring them replayed it. A run now
// measures how far the file system's clock lags its own (one stamp in the
// cache dir) and widens every window by that lag.
//
// The gate's file systems share this process's clock, so the lag is
// simulated the other way round: `Date.now()` is moved ahead, which the
// child processes and the kernel's stamps never see.

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { racyWindowMs, setFsClockLag } from '../src/cache/index.js'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000
const MOVED = /changed after its key was taken/
/** How far the simulated file system runs behind: past every window but a FAT second pair's. */
const LAG_MS = 3_000

let root: string
let status: string[]
const realNow = Date.now

const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-fs-clock-' })
  status = []
})

afterEach(async () => {
  Date.now = realNow
  setFsClockLag(0)
  await rm(root, { recursive: true, force: true })
})

/** This process's clock `ms` ahead of the file system's. */
function lagBy(ms: number): void {
  Date.now = () => realNow() + ms
}

async function runTask(task: string): Promise<RunSummary> {
  status = []
  const r = await run({ cwd: root, tasks: [task], log: logger })
  expect(r.ok).toBe(true)
  return r
}

const statusOf = (r: RunSummary, id: string): string | undefined =>
  r.outcomes.find((o) => o.node.id === id)?.status

async function reached(file: string): Promise<void> {
  while (!existsSync(file)) await Bun.sleep(5)
}

const BUILD = `
  export default {
    tasks: {
      build: {
        exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist; cat src/a.ts > dist/out.js' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
    },
  }
`

describe('a file system clock behind the process', () => {
  it(
    'an input edited while the command runs is still a moved input, and the restored file rebuilds',
    async () => {
      const app = await addProject(root, 'app', { config: BUILD, files: { 'src/a.ts': 'X\n' } })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'fixture')

      lagBy(LAG_MS)
      const pending = runTask('build')
      await reached(path.join(app, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      await writeFile(path.join(app, 'go'), '')
      await pending
      // Before the fix: no line, and the entry held `EDITED` under X's key.
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        "[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task generates it, declare it in outputs; if it rewrites it in place, set inputs.stability: { strategy: 'mutable' }",
      ])

      gitIn(root)('checkout', '--', 'packages/app/src/a.ts')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const again = await runTask('build')
      // Before the fix: a local hit restoring `EDITED` over X.
      expect(statusOf(again, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  it(
    'with the clocks together, the same run saves (control: the lag is what is measured)',
    async () => {
      const app = await addProject(root, 'app', { config: BUILD, files: { 'src/a.ts': 'X\n' } })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n')
      await writeFile(path.join(app, 'go'), '')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'fixture')
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('cache-hit')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )
})

describe('a lag the measurement calls the kernel tick', () => {
  it(
    'an input edited and put back as the command starts is still a moved input',
    async () => {
      // Linux before 6.13 stamps a file from its coarse clock, up to a tick
      // behind a `Date.now()` read before the write, and the measurement
      // leaves a lag that small out. The re-check took the command's start
      // from `Date.now()`, so an edit in the command's first tick, undone
      // before it ended, read as an upstream's write of the key's bytes,
      // and the entry filed the edit's output under them. Simulated: the
      // process clock moves ahead once the task starts, past the measurement.
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'IFS= read -r was < src/a.ts; echo EDITED > src/a.ts; mkdir -p dist; cat src/a.ts > dist/out.js; echo "$was" > src/a.ts' },
                inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
              },
            },
          }
        `,
        files: { 'src/a.ts': 'X\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'fixture')

      status = []
      const first = await run({
        cwd: root,
        tasks: ['build'],
        log: { ...logger, taskStart: () => lagBy(LAG_MS) },
      })
      Date.now = realNow
      expect(first.ok).toBe(true)
      // Before the fix: no line, and the entry held `EDITED` under X's key.
      expect(status.filter((l) => MOVED.test(l))).toHaveLength(1)

      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const again = await runTask('build')
      // Before the fix: a local hit, replaying the entry saved under X's key.
      expect(statusOf(again, 'app#build')).toBe('success')
    },
    TIMEOUT,
  )
})

describe('racyWindowMs', () => {
  it('widens every window by the lag, and only by a lag past the clock tick', () => {
    setFsClockLag(LAG_MS)
    expect([racyWindowMs(1_700_000_000_007, 50), racyWindowMs(1_700_000_001_000, 0)]).toEqual([
      50 + LAG_MS,
      1000 + LAG_MS,
    ])
    // A coarse kernel tick reads a few ms behind `Date.now()` on every box:
    // widening by it withheld saves after a fast upstream for nothing.
    setFsClockLag(5)
    expect(racyWindowMs(1_700_000_000_007, 50)).toBe(50)
  })
})
