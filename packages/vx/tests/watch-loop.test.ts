// The watch loop end to end, on markers rather than sleeps: "watching"
// on stdout means every watcher has proved delivery, and an execution
// count kept OUTSIDE the workspace says how many times the task's command
// actually ran (a cache hit runs nothing). The three claims the 2026-07
// parity doc left unpinned (M8, L5, and M7's documented converse): an
// edit re-runs exactly once; a same-content rewrite re-executes nothing;
// a `git checkout` that rewrites many inputs at once is one cycle.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SETTLE_MS = 1_000

interface Watch {
  proc: ReturnType<typeof Bun.spawn>
  out: () => string
  cycles: () => number
}

async function until(
  cond: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function executions(log: string): Promise<number> {
  const f = Bun.file(log)
  if (!(await f.exists())) return 0
  return (await f.text()).split('\n').filter((l) => l === 'run').length
}

function startWatch(root: string): Watch {
  const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', '--all'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VX_KILL_GRACE_MS: '200' },
  })
  let out = ''
  void (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
  })()
  return {
    proc,
    out: () => out,
    cycles: () => out.split('re-running...').length - 1,
  }
}

describe('vx watch loop (e2e)', () => {
  let root: string
  let outside: string
  let log: string
  let dir: string
  let watch: Watch | undefined
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-loop-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
    log = path.join(outside, 'runs.log')
    dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
  })
  afterEach(async () => {
    if (watch !== undefined) {
      watch.proc.kill('SIGTERM')
      await watch.proc.exited
      watch = undefined
    }
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('an edit re-runs once; the same bytes again re-execute nothing; a new edit re-runs', async () => {
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(log)) === 2, 'the re-run after an edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')

    // M8: the same bytes written again are not a change — no cycle at
    // all, so no execution. Without the content gate the loop re-ran
    // (a cache hit, but a cycle) on every such write.
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(log)).toBe(2)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a3\n')
    await until(async () => (await executions(log)) === 3, 'the re-run after a second edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(2)
  }, 40_000)

  it('under the root watcher, a root file no key can see is not a cycle; a declared one is', async () => {
    // A `workspaceFiles` input puts the loop on ONE recursive root watcher.
    // Before the filter, that watcher triggered on every write in the tree:
    // `vx watch … > build.log` inside the repo never settled (each cycle
    // grew the log, the log was an event, the event was a cycle), and a
    // coverage run at the root cost a cycle per file. Differential: with the
    // filter removed from the arm, the `build.log` write below is a cycle.
    await writeFile(path.join(root, 'tsconfig.base.json'), '{"a":1}\n')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
            cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    watch = startWatch(root)
    const w = watch
    await until(
      () => w.out().includes('vx watch: watching the workspace root'),
      'the root-watcher marker',
    )
    expect(await executions(log)).toBe(1)

    await writeFile(path.join(root, 'build.log'), 'vx watch: initial run...\n')
    await mkdir(path.join(root, 'coverage'), { recursive: true })
    await writeFile(path.join(root, 'coverage', 'lcov.info'), 'TN:\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
    expect(await executions(log)).toBe(1)

    // The control: the declared root file is an edit, and the watcher was alive all along.
    await writeFile(path.join(root, 'tsconfig.base.json'), '{"a":2}\n')
    await until(
      async () => (await executions(log)) === 2,
      'the re-run after the declared root file changed',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
  }, 40_000)

  it('an UNCACHED task that writes into its project costs exactly one extra execution per edit, then quiet', async () => {
    // No cache block declares no outputs, so the task's own `dist/out.txt`
    // is an undeclared write the watcher sees. Its bytes are unknown until
    // seen, and a user's edit during the run is indistinguishable from the
    // task's write without the task's write set — so the price is one
    // redundant cycle per edit (the second run writes the same bytes and
    // the content gate stops it), never a loop. Measured 2026-09-10; the
    // fix is to declare the output. Nothing after the initial run: its
    // write landed before the watchers were armed.
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' } } } }\n`,
    )
    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(log)).toBe(1)
    expect(w.cycles()).toBe(0)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(
      async () => (await executions(log)) === 3,
      'the edit cycle and its one redundant follower',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await executions(log)).toBe(3)
    expect(w.cycles()).toBe(2)
    expect(w.out()).toContain('vx watch: app dist/out.txt; re-running...')
  }, 40_000)

  it('a git checkout that rewrites twenty inputs is one cycle with the new content (L5)', async () => {
    const git = gitIn(root)
    const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    for (const n of names) await writeFile(path.join(dir, 'src', n), `${n} v1\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v1')
    const base = git('branch', '--show-current').trim()
    git('checkout', '-q', '-b', 'feat')
    for (const n of names) await writeFile(path.join(dir, 'src', n), `${n} v2\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v2')
    git('checkout', '-q', base)

    watch = startWatch(root)
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(log)).toBe(1)

    git('checkout', '-q', 'feat')
    await until(async () => (await executions(log)) === 2, 'the re-run after the checkout')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    const out = await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')
    expect(out).toBe(['a1\n', ...names.map((n) => `${n} v2\n`)].join(''))
  }, 40_000)
})
