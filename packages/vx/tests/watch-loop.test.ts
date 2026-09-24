// The watch loop end to end, on markers rather than sleeps (the fixture
// and the markers: `helpers/watch-loop.ts`). The three claims the 2026-07
// parity doc left unpinned (M8, L5, and M7's documented converse): an
// edit re-runs exactly once; a same-content rewrite re-executes nothing;
// a `git checkout` that rewrites many inputs at once is one cycle. The
// member and uncached-output cases are `watch-loop-members.test.ts` and
// `watch-loop-uncached.test.ts`: one file was a 24 s serial chain of
// settle windows, a shard on its own (2026-09-16).

import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive } from './helpers/alive.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, gitIn, gitInit, makeWorkspace } from './helpers/workspace.js'
import {
  BIN,
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
  type Watch,
} from './helpers/watch-loop.js'

describe('vx watch loop (e2e)', () => {
  const f = useWatchFixture()

  it('an edit re-runs once; the same bytes again re-execute nothing; a new edit re-runs', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    // The cycle's invocation row names the verb, as `vx run`'s does; the
    // process.argv fallback recorded the bin's absolute path in its place.
    const last = Bun.spawnSync([process.execPath, BIN, 'last', '--list'], { cwd: f.root })
    expect(last.stdout.toString()).toContain('$ vx watch build --all')

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')

    // M8: the same bytes written again are not a change — no cycle at
    // all, so no execution. Without the content gate the loop re-ran
    // (a cache hit, but a cycle) on every such write.
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(f.log)).toBe(2)

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a3\n')
    await until(async () => (await executions(f.log)) === 3, 'the re-run after a second edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(2)
  }, 40_000)

  it('VX_WATCH_POLL=1 polls from the start, says so, and an edit still re-runs', async () => {
    // The switch for a host whose OS watcher is known not to deliver (a
    // sandbox without FSEvents access, a network mount, a container bind):
    // the loop arms the poller instead of probing the watcher for 2 s. The
    // notice is the observable — the poller and the watcher deliver the same
    // edits — and the re-run proves the poller is the one delivering them.
    f.watch = startWatch(f.root, ['--all'], { VX_WATCH_POLL: '1' })
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    expect(w.err()).toContain('vx watch: polling every 250 ms (VX_WATCH_POLL)')
    expect(w.err()).not.toContain('no OS watch events')

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'polled\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit, polled')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('polled\n')
  }, 40_000)

  it('a first sighting is a change only when its mtime falls after the arm', async () => {
    // The loop has never judged either path, so each is a FIRST sighting,
    // and the mtime is all it has to say which side of the arm the change
    // belongs to. macOS hands a fresh FSEvents stream what landed just
    // before it started (CI, 2026-09-11: `app dist; re-running...` with no
    // edit made), and a first sighting used to pass unconditionally — the
    // initial run's own writes re-ran it. `modifiedBefore` is pinned as a
    // function in `watch-rules.test.ts`; this is the loop asking it.
    // The two halves are the SAME operation on two files, so the only
    // variable is the timestamp. Neither file is an input, so a cycle here
    // is a hit — the cycle COUNT is the claim, not the execution count.
    const stale = path.join(f.dir, 'stale.txt')
    const fresh = path.join(f.dir, 'fresh.txt')
    await writeFile(stale, 'x\n')
    await writeFile(fresh, 'x\n')

    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    const before = new Date(Date.now() - 3_600_000)
    await utimes(stale, before, before)
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)

    const after = new Date()
    await utimes(fresh, after, after)
    await until(() => w.cycles() === 1, 'the cycle for the path stamped after the arm')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(f.log)).toBe(1)
  }, 40_000)

  it('an edit to vx.workspace.mjs is one cycle that runs under the new workspace config', async () => {
    // The workspace config is no task's input, so no project arm sees it;
    // its plugins, `config` stage and concurrency shape every cycle all the
    // same. Before 2026-09-10 the root arm listened for fingerprint files
    // only, and a plugin added under `vx watch` waited for a restart.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(
      path.join(f.root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
        'org/greeter',
        `{ config(_ws, ctx) { ctx.warn('WS-EDIT-SEEN') } }`,
      )}] }\n`,
    )
    await until(
      () => w.out().includes('WS-EDIT-SEEN'),
      'the cycle under the edited workspace config',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    // The config is not key material: the task is a hit under it.
    expect(await executions(f.log)).toBe(1)
  }, 40_000)

  // turborepo#9463: an editor's atomic save (write a temp file, rename it
  // over the original) was missed.
  it('an atomic save by rename is one cycle with the new content, three saves in a row', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    for (let i = 2; i <= 4; i++) {
      const tmp = path.join(f.dir, 'src', 'a.txt~')
      await writeFile(tmp, `a${i}\n`)
      await rename(tmp, path.join(f.dir, 'src', 'a.txt'))
      await until(async () => (await executions(f.log)) === i, `the re-run after save ${i}`)
      await Bun.sleep(SETTLE_MS)
      expect(w.cycles()).toBe(i - 1)
      expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe(`a${i}\n`)
    }
  }, 40_000)

  it('a git checkout that rewrites twenty inputs is one cycle with the new content (L5)', async () => {
    const git = gitIn(f.root)
    const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    for (const n of names) await writeFile(path.join(f.dir, 'src', n), `${n} v1\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v1')
    const base = git('branch', '--show-current').trim()
    git('checkout', '-q', '-b', 'feat')
    for (const n of names) await writeFile(path.join(f.dir, 'src', n), `${n} v2\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v2')
    git('checkout', '-q', base)

    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    git('checkout', '-q', 'feat')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the checkout')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    const out = await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')
    expect(out).toBe(['a1\n', ...names.map((n) => `${n} v2\n`)].join(''))

    // M8 for a path that arrived in a BATCH. One judgement reports one
    // label, but it must record the settled state of every path it judged
    // — `judge` evaluates `sameState` before the `first === undefined`
    // test for exactly that reason. Read the other way round it
    // short-circuits after the winner, leaving the other nineteen
    // unjudged, and each one's next event is a FIRST sighting stamped
    // after the arm, i.e. a change: rewriting their own bytes re-runs.
    // Writing all twenty means at most one can be the recorded winner.
    for (const n of names) await writeFile(path.join(f.dir, 'src', n), `${n} v2\n`)
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(f.log)).toBe(2)
  }, 40_000)
})

describe('vx watch with a persistent task (e2e)', () => {
  let root = ''
  let dir = ''
  let outside = ''
  let pids = ''
  let watch: Watch | undefined
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-persistent-' })
    // Outside the workspace: a write under the project would be a cycle.
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-pids-'))
    pids = path.join(outside, 'pids')
    dir = await addProject(
      root,
      'web',
      `
        export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo $$ >> ${pids}; echo READY; exec sleep 1000',
                persistent: { readyWhen: 'READY' },
              },
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
      watch.proc.kill('SIGKILL')
      await watch.proc.exited
      watch = undefined
    }
    for (const pid of await readPids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const readPids = async (): Promise<number[]> => {
    const f = Bun.file(pids)
    if (!(await f.exists())) return []
    return (await f.text()).split('\n').filter(Boolean).map(Number)
  }
  // One `time` line per run's summary: the count says how many runs have ended.
  const runsEnded = (w: Watch): number => w.out().split('\n  time ').length - 1

  it('the dev server stays up while watch idles and is replaced when the next cycle starts', async () => {
    // cli.md: the previous server stops BETWEEN cycles. Until the fix it
    // stopped at the END of each one, so it was dead whenever watch sat
    // idle (turborepo#9421, #13115 reproduced on vx).
    watch = startWatch(root, ['--all'], {}, 'dev')
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    const [first] = await readPids()
    expect(first).toBeNumber()
    expect(isAlive(first!)).toBe(true)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(() => runsEnded(w) === 2, 'the end of the cycle after an edit')
    const all = await readPids()
    expect(all).toHaveLength(2)
    expect(isAlive(first!)).toBe(false)
    expect(isAlive(all[1]!)).toBe(true)

    w.proc.kill('SIGTERM')
    expect(await w.proc.exited).toBe(0)
    expect(isAlive(all[1]!)).toBe(false)
  }, 40_000)
})

// turborepo#9531: `turbo watch` refused a single-package repository. vx
// reads a root package.json with no workspaces as one project.
describe('vx watch in a single-project repository (e2e)', () => {
  it('runs, watches, and re-runs once on an edit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-single-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-single-count-'))
    const log = path.join(outside, 'runs.log')
    const w = { current: undefined as ReturnType<typeof startWatch> | undefined }
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'solo' }))
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      )
      await mkdir(path.join(root, 'src'))
      await writeFile(path.join(root, 'src', 'a.txt'), 'a1\n')
      gitInit(root)
      w.current = startWatch(root, [])
      const watch = w.current
      await until(() => watch.out().includes('vx watch: watching'), 'the watching marker')
      await initialOnly(watch, log)
      await writeFile(path.join(root, 'src', 'a.txt'), 'a2\n')
      await until(async () => (await executions(log)) === 2, 'the re-run after an edit')
      await Bun.sleep(SETTLE_MS)
      expect(watch.cycles()).toBe(1)
      expect(await readFile(path.join(root, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')
    } finally {
      if (w.current !== undefined) {
        w.current.proc.kill('SIGTERM')
        await w.current.proc.exited
      }
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)
})
