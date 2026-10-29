// The watch loop end to end, on markers rather than sleeps (the fixture
// and the markers: `helpers/watch-loop.ts`). The three claims the 2026-07
// parity doc left unpinned (M8, L5, and M7's documented converse): an
// edit re-runs exactly once; a same-content rewrite re-executes nothing;
// a `git checkout` that rewrites many inputs at once is one cycle. The
// member and uncached-output cases are `watch-loop-members.test.ts` and
// `watch-loop-uncached.test.ts`: one file was a 24 s serial chain of
// settle windows, a shard on its own (2026-09-16).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, killIfAlive, waitForDead } from './helpers/alive.js'
import { addProject, gitInit, makeWorkspace } from './helpers/workspace.js'
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
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { noticed } from './helpers/notice.js'

/** `vx lock` in `root`: what a run, and each watch cycle, reads its configs from. */
function lock(root: string): void {
  const r = Bun.spawnSync([process.execPath, BIN, 'lock'], { cwd: root, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`vx lock: ${r.stderr.toString()}`)
}

describe('vx watch loop (e2e)', () => {
  const f = useWatchFixture()

  it('a task no project declares exits 1 as `vx run` does, instead of watching', async () => {
    // `vx watch buidl` printed the refusal with its "did you mean" and then
    // watched forever, re-running the same refusal on every change.
    const w = startWatch(f.root, ['--all'], {}, 'buidl')
    let code: number | string
    try {
      code = await Promise.race([w.proc.exited, Bun.sleep(15_000).then(() => 'still watching')])
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
    }
    expect({ code, watching: w.out().includes('watching ') }).toEqual({
      code: 1,
      watching: false,
    })
    expect(w.err()).toContain(
      noticed('vx watch: no projects declare task(s): buidl. Did you mean build?'),
    )
    // CONTROL: the declared name watches (the case above never got there).
    f.watch = startWatch(f.root)
    const ok = f.watch
    await until(() => ok.out().includes('watching '), 'the watching marker')
  }, 40_000)

  it('an edit re-runs once; the same bytes again re-execute nothing; a new edit re-runs', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
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

  it('says one opening line, then each cycle as its change and its rows, no footer', async () => {
    const w = (f.watch = startWatch(f.root))
    await until(() => w.out().includes('watching '), 'the watching marker')
    await writeFile(path.join(f.dir, 'src', 'b.txt'), 'b1\n')
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the edits')
    await Bun.sleep(SETTLE_MS)
    // The duration and cpu are padded to fixed widths, so their digits decide the spaces before them.
    expect(
      w
        .out()
        .replace(/ +\d+ms/g, ' Nms')
        .replace(/ +\d+%/g, ' C'),
    ).toBe(
      [
        ' ⏺︎ Nms                 success miss C' + ' '.repeat(13) + '3B' + ' '.repeat(7) + '0 local        app#build',
        'watching 1 project · 1 task',
        '',
        'changed app src/b.txt (+1 more)',
        ' ⏺︎ Nms                 success miss C' + ' '.repeat(13) + '6B' + ' '.repeat(7) + '0 local        app#build',
        '',
      ].join('\n'),
    )
  }, 40_000)

  it('a cycle every task of which is a cache hit says so in one line', async () => {
    // `--all` is the broad flow, where a hit prints no row, and watch
    // prints no footer: a cycle back to cached bytes (an undo, a `git
    // checkout`, a deleted file restored) printed `changed` and nothing,
    // so a failure the cycle before stayed the last outcome on screen.
    const w = (f.watch = startWatch(f.root, ['--all']))
    await until(() => w.out().includes('watching '), 'the watching marker')
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit')
    await Bun.sleep(SETTLE_MS)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a1\n')
    await until(() => w.out().includes('1 task cached'), 'the cached line')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(2)
    expect(
      w
        .out()
        .replace(/ +\d+ms/g, ' Nms')
        .replace(/ +\d+%/g, ' C'),
    ).toBe(
      [
        ' ⏺︎ Nms                 success miss C' + ' '.repeat(13) + '3B' + ' '.repeat(7) + '0 local        app#build',
        'watching 1 project · 1 task',
        '',
        'changed app src/a.txt',
        ' ⏺︎ Nms                 success miss C' + ' '.repeat(13) + '3B' + ' '.repeat(7) + '0 local        app#build',
        '',
        'changed app src/a.txt',
        ' 1 task cached, nothing ran',
        '',
      ].join('\n'),
    )
  }, 40_000)

  it('the recorded command keeps its args shell-quoted, as `vx run` records them', async () => {
    // A bare join recorded `--filter a*`, which a shell globs when pasted.
    f.watch = startWatch(f.root, ['--filter', 'a*'])
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    const last = Bun.spawnSync([process.execPath, BIN, 'last', '--list'], { cwd: f.root })
    expect(last.stdout.toString()).toContain("$ vx watch build --filter 'a*'")
  }, 40_000)

  it('a re-lock re-runs, and a config edit alone does not change the command (item 971)', async () => {
    f.watch = startWatch(f.root, ['--all'])
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    // The config's command changes; the lock still holds the old one, so
    // the cycle this edit starts is a hit and executes nothing.
    const config = path.join(f.dir, 'vx.config.mjs')
    const before = await readFile(config, 'utf8')
    await writeFile(config, before.replace('cat src/*.txt', 'cat src/*.txt src/*.txt'))
    await until(() => w.cycles() === 1, 'the cycle the config edit starts')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(1)
    // Said, or the cycle read as the edit applied: it printed `changed` and
    // no row, the same as an edit that changed nothing.
    const hint = noticed(
      'vx watch: packages/app/vx.config.mjs changed; runs read the lock, so run `vx lock` to apply it',
      'warn',
    )
    expect(w.err()).toContain(hint)

    // The re-lock is the edit that changes what a cycle runs.
    lock(f.root)
    await until(async () => (await executions(f.log)) === 2, 'the re-run after a re-lock')
    expect(w.err().split(hint).length - 1).toBe(1)

    // A config gone is the run's own refusal to say, not a second line.
    await rm(config)
    await until(() => w.err().includes('but its vx.config.mjs is gone'), 'the refusal')
    expect(w.err().split(hint).length - 1).toBe(1)
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a1\na1\n')
  }, 40_000)

  it('a lock removed under watch is said once per cycle, by the cycle', async () => {
    // The re-read before the cycle said `cannot re-read the workspace: no
    // lock` and the cycle then said `no lock` again: two lines, one cause.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    const lockFile = path.join(f.root, '.vx', 'projects.lock.json')
    const locked = await readFile(lockFile, 'utf8')
    await rm(lockFile)
    await until(() => w.err().includes('cycle failed: no lock'), 'the failed cycle')
    await Bun.sleep(SETTLE_MS)
    expect(w.err()).not.toContain('cannot re-read the workspace')
    expect(w.err().split('no lock: run `vx lock`').length - 1).toBe(1)

    // Restored, the loop runs again.
    await writeFile(lockFile, locked)
    await until(() => w.cycles() === 2, 'the cycle the restored lock starts')
  }, 40_000)

  it('a task with no cache re-runs on a git-ignored file it reads (item 947)', async () => {
    // The git-ignore filter's reason is "no cache key can see it", and a
    // task with no cache has no key: its `.env.local` edit re-ran nothing.
    await writeFile(path.join(f.dir, '.gitignore'), '.env.local\nshown.txt\n')
    await writeFile(path.join(f.dir, '.env.local'), 'A=1\n')
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: {
        show: { exec: { command: 'cat .env.local > shown.txt && echo run >> ${f.log}' } },
      } }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], {}, 'show')
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.dir, '.env.local'), 'A=2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the ignored edit')
    expect(await readFile(path.join(f.dir, 'shown.txt'), 'utf8')).toBe('A=2\n')
    await Bun.sleep(SETTLE_MS)
    // One: the task's own rewrite of the ignored `shown.txt` lands inside
    // the cycle, so it is the run's, not an edit (the pid-file loop's rule,
    // `watch-loop-selfwrite.test.ts`).
    expect(w.cycles()).toBe(1)

    // An edit AFTER that cycle ended is the user's again: "written during
    // the last cycle" is bounded by the cycle's end as well as its start.
    // Without the end bound every later write read as the run's own, and
    // this second edit re-ran nothing (E-20; the row above made one edit
    // only, before any cycle had run).
    await writeFile(path.join(f.dir, '.env.local'), 'A=3\n')
    await until(async () => (await executions(f.log)) === 3, 'the re-run after a second edit')
    expect(await readFile(path.join(f.dir, 'shown.txt'), 'utf8')).toBe('A=3\n')
  }, 40_000)

  it('a cached task re-runs on a git-ignored file its inputs name outright', async () => {
    await writeFile(path.join(f.dir, '.gitignore'), '.env.local\nother.local\n')
    await writeFile(path.join(f.dir, '.env.local'), 'A=1\n')
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: {
        show: { exec: { command: 'echo run >> ${f.log}' }, inputs: { files: ['.env.local'] }, cache: { outputs: { files: [] } } },
      } }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], {}, 'show')
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.dir, '.env.local'), 'A=2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the ignored edit')
    // CONTROL: an ignored file no entry names starts no cycle.
    await writeFile(path.join(f.dir, 'other.local'), 'x\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
  }, 40_000)

  it('a shared preset outside the project is watched, and its edit runs once re-locked (item 949)', async () => {
    // Configs compose through imports; a preset outside the project was in
    // no arm, so its edit started no cycle. A cycle runs the lock's
    // configs, so the edit changes the command only once `vx lock` runs.
    // Outside the workspace, as the count is: only the preset and the lock start cycles.
    const said = path.join(path.dirname(f.log), 'said.txt')
    await mkdir(path.join(f.root, 'shared'), { recursive: true })
    await writeFile(path.join(f.root, 'shared', 'preset.mjs'), "export const word = 'ONE'\n")
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `import { word } from '../../shared/preset.mjs'
      export default { tasks: {
        build: { exec: { command: 'echo ' + word + ' > ${said} && echo run >> ${f.log}' } },
      } }\n`,
    )
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    expect(await readFile(said, 'utf8')).toBe('ONE\n')

    await writeFile(path.join(f.root, 'shared', 'preset.mjs'), "export const word = 'TWO'\n")
    await until(() => w.cycles() === 1, 'the cycle the preset edit starts')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(2)
    expect(await readFile(said, 'utf8')).toBe('ONE\n')
    expect(w.err()).toContain(
      noticed(
        'vx watch: shared/preset.mjs changed; runs read the lock, so run `vx lock` to apply it',
        'warn',
      ),
    )

    lock(f.root)
    await until(async () => (await executions(f.log)) === 3, 'the re-run after a re-lock')
    expect(await readFile(said, 'utf8')).toBe('TWO\n')
  }, 40_000)

  it('an edit to a file the workspace config imports is named with the restart it needs (item 949)', async () => {
    // The workspace config is loaded in this process, and Bun keeps what it
    // imports: a cycle would run the old helper. Silence was worse.
    await writeFile(path.join(f.root, 'ws-helper.mjs'), "export const msg = 'ONE'\n")
    await Bun.write(
      path.join(f.root, '.vx/workspace.mjs'),
      "import { msg } from '../ws-helper.mjs'\nexport default { plugins: [] }\n",
    )
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.root, 'ws-helper.mjs'), "export const msg = 'TWO'\n")
    await until(
      () => w.out().includes('ws-helper.mjs changed; the workspace config imports it'),
      'the restart notice',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
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
    for (const pid of await readPids()) killIfAlive(pid)
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const readPids = async (): Promise<number[]> => {
    const f = Bun.file(pids)
    if (!(await f.exists())) return []
    return (await f.text()).split('\n').filter(Boolean).map(Number)
  }
  // One `web#dev` row per run: the count says how many runs have settled it.
  const runsEnded = (w: Watch): number => w.out().match(/ web#dev$/gm)?.length ?? 0

  it('the dev server stays up across cycles and is replaced when its locked config changes', async () => {
    // cli.md: a cycle keeps a server still up whose task is unchanged; the
    // dev tool's own reload takes the edit. Until then every cycle restarted
    // it, so `vx watch dev` dropped the server on each save. Before that it
    // stopped at the END of each cycle, dead whenever watch sat idle
    // (turborepo#9421, #13115 reproduced on vx).
    watch = startWatch(root, ['--all'], {}, 'dev')
    const w = watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    const [first] = await readPids()
    expect(first).toBeNumber()
    expect(isAlive(first!)).toBe(true)

    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    await until(() => runsEnded(w) === 2, 'the end of the cycle after an edit')
    expect(await readPids()).toEqual([first!])
    expect(isAlive(first!)).toBe(true)

    // Its config edit alone leaves the locked task unchanged, so it stays…
    const cfg = path.join(dir, 'vx.config.mjs')
    await writeFile(cfg, (await readFile(cfg, 'utf8')).replace('echo READY', 'echo READY again'))
    await until(() => runsEnded(w) === 3, 'the end of the cycle after a config edit')
    expect(await readPids()).toEqual([first!])

    // …and once locked the old one goes before the new one starts.
    lock(root)
    await until(() => runsEnded(w) === 4, 'the end of the cycle after a re-lock')
    const all = await readPids()
    expect(all).toHaveLength(2)
    expect(isAlive(first!)).toBe(false)
    expect(isAlive(all[1]!)).toBe(true)

    w.proc.kill('SIGTERM')
    expect(await w.proc.exited).toBe(0)
    expect(isAlive(all[1]!)).toBe(false)
  }, 40_000)

  it('a server that keeps rewriting a file in its project is named after three cycles (item 948)', async () => {
    // Its write lands after the cycle before ended, so the streak never
    // counted it: 12 cycles in 8 s and no word of why.
    // It writes only once watch is armed: a write before the arm is the
    // initial run's, never an event, and a loaded runner took longer than
    // the 0.3 s to arm, so no cycle ever started (CI, 2026-10-06).
    // Stamped to the second, so most writes are the same bytes and their
    // judgements find nothing: each reset the streak, as an event macOS
    // delivers late can for a nanosecond stamp (CI, 2026-10-29).
    const armed = path.join(outside, 'armed')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { dev: { exec: {
        command: 'echo $$ >> ${pids}; echo READY; until [ -e ${armed} ]; do sleep 0.05; done; while :; do sleep 0.3; date +%s > server.log; done',
        persistent: { readyWhen: 'READY' },
      } } } }\n`,
    )
    watch = startWatch(root, ['--all'], {}, 'dev')
    const w = watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await writeFile(armed, '')
    await until(
      () => w.out().includes('server.log has started 3 cycles in a row'),
      'the notice naming the server-written file',
    )
    expect(w.out()).toContain('a persistent task rewrites it. Add it to .gitignore')
    // Stopped as a user stops it, mid-storm: a SIGKILL here raced the
    // server a cycle was spawning, and the teardown's cleanup with it.
    // The stop waits for the cycle in flight and every server it held.
    w.proc.kill('SIGTERM')
    expect(await w.proc.exited).toBe(0)
    watch = undefined
    const alive: number[] = []
    for (const pid of await readPids()) if (!(await waitForDead(pid, 2000))) alive.push(pid)
    expect(alive).toEqual([])
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
      await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      )
      await mkdir(path.join(root, 'src'))
      await writeFile(path.join(root, 'src', 'a.txt'), 'a1\n')
      gitInit(root)
      w.current = startWatch(root, [])
      const watch = w.current
      await until(() => watch.out().includes('watching '), 'the watching marker')
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
