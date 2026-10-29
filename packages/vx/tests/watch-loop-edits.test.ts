// vx watch loop (e2e), continued from watch-loop.test.ts: split so
// neither file holds a test shard alone (2026-10-22).

import { readFile, rename, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { packagesSource, PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { gitIn } from './helpers/workspace.js'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  runWarned,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch loop (e2e)', () => {
  const f = useWatchFixture()

  it('VX_WATCH_POLL=1 polls from the start, says so, and an edit still re-runs', async () => {
    // The switch for a host whose OS watcher is known not to deliver (a
    // sandbox without FSEvents access, a network mount, a container bind):
    // the loop arms the poller instead of probing the watcher for 2 s. The
    // notice is the observable — the poller and the watcher deliver the same
    // edits — and the re-run proves the poller is the one delivering them.
    f.watch = startWatch(f.root, ['--all'], { VX_WATCH_POLL: '1' })
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    expect(w.err()).toContain('vx watch: polling every 250 ms (watch.poll)')
    expect(w.err()).not.toContain('no OS watch events')

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'polled\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit, polled')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('polled\n')
  }, 40_000)

  // Every fs.watch refused with `code`, as a full inotify table (ENOSPC) or
  // fd table (EMFILE) refuses it.
  const refusingWatch = async (code: string): Promise<string> => {
    const shim = path.join(f.root, 'refusing-watch.ts')
    await writeFile(
      shim,
      "import fs from 'node:fs'\n" +
        `fs.watch = (() => { throw Object.assign(new Error('${code}: refused'), { code: '${code}' }) }) as typeof fs.watch\n`,
    )
    return shim
  }

  it.each(['ENOSPC', 'EMFILE'])(
    'an OS watch limit (%s) falls back to polling and says how to raise it',
    async (code) => {
      // Before, each arm printed "cannot watch", the loop said "watching",
      // and no edit ever re-ran.
      const shim = await refusingWatch(code)
      f.watch = startWatch(f.root, ['--all'], { BUN_OPTIONS: `--preload ${shim}` })
      const w = f.watch
      await until(() => w.out().includes('watching '), 'the watching marker')
      await initialOnly(w, f.log)
      expect(w.err()).toContain(
        // The directory is left out: macOS's temp dir is reached through a link.
        `: the OS watch limit is reached (${code}); polling every 250 ms instead — raise it (Linux: sysctl fs.inotify.max_user_watches) to watch natively\n`,
      )
      expect(w.err()).not.toContain('cannot watch')

      await writeFile(path.join(f.dir, 'src', 'a.txt'), 'polled\n')
      await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit, polled')
    },
    40_000,
  )

  it('CONTROL: a refusal that is not a limit is not papered over by the poller', async () => {
    // A directory this user may not watch is the directory's fault; polling
    // it would hide that. It is still named, as before.
    const shim = await refusingWatch('EACCES')
    f.watch = startWatch(f.root, ['--all'], { BUN_OPTIONS: `--preload ${shim}` })
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    expect(w.err()).toContain('cannot watch')
    expect(w.err()).toContain('EACCES: refused')
    expect(w.err()).not.toContain('polling every')
  }, 40_000)

  it('a first sighting is a change when it moved after the arm, whatever its mtime says', async () => {
    // The loop has never judged either path, so each is a FIRST sighting.
    // `fresh` is stamped after the arm. `restored` is a file moved in over
    // `stale.txt` with an mtime an hour old, as `mv`, `cp -p`, `rsync -a`
    // or `tar x` leave it: read by mtime alone it was "before the arm" and
    // never ran (item 945); its ctime is the move. The initial run's own
    // writes, which macOS delivers after the arm (CI, 2026-09-11), carry
    // both clocks from before it and still stay quiet: `modifiedBefore` is
    // pinned in `watch-rules.test.ts`. Neither file is an input, so a cycle
    // here is a hit: the cycle COUNT is the claim.
    const stale = path.join(f.dir, 'stale.txt')
    const fresh = path.join(f.dir, 'fresh.txt')
    await writeFile(stale, 'x\n')
    await writeFile(fresh, 'x\n')

    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    const restored = path.join(f.root, 'restored.txt')
    await writeFile(restored, 'y\n')
    const old = new Date(Date.now() - 3_600_000)
    await utimes(restored, old, old)
    await rename(restored, stale)
    await until(() => w.cycles() === 1, 'the cycle for the file moved in with an old mtime')

    const after = new Date()
    await utimes(fresh, after, after)
    await until(() => w.cycles() === 2, 'the cycle for the path stamped after the arm')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(2)
  }, 40_000)

  it('an edit to .vx/workspace.mjs is one cycle that runs under the new workspace config', async () => {
    // The workspace config is no task's input, so no project arm sees it;
    // its plugins, `config` stage and concurrency shape every cycle all the
    // same. Before 2026-09-10 the root arm listened for fingerprint files
    // only, and a plugin added under `vx watch` waited for a restart.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    await Bun.write(
      path.join(f.root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${packagesSource()}, ${pluginSource(
        'org/greeter',
        `{ config(_ws, ctx) { ctx.warn('WS-EDIT-SEEN') } }`,
      )}] }\n`,
    )
    await until(() => runWarned(w, 'WS-EDIT-SEEN'), 'the cycle under the edited workspace config')
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
    await until(() => w.out().includes('watching '), 'the watching marker')
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
    await until(() => w.out().includes('watching '), 'the watching marker')
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

  it('a writer that never pauses for a debounce window does not hold an edit back', async () => {
    // Each event reset the timer, so one every 50 ms (a dev server's log)
    // kept the loop idle for good and the edit never ran.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    let n = 0
    const writer = setInterval(() => void writeFile(path.join(f.dir, 'noise.log'), `${n++}\n`), 50)
    try {
      await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
      await until(async () => (await executions(f.log)) === 2, 'the re-run under the writer', 5_000)
    } finally {
      clearInterval(writer)
    }
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')
  }, 40_000)
})
