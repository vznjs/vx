// An inotify watch holds an inode, not a path. A project's parent removed
// and made again (`rm -rf packages && git checkout packages`) left its
// watch on the deleted directory, and the root arm drops every name but
// its own files, so the directory coming back was no event, and no edit
// after it ran until a restart. Made again inside one window, the re-read
// found the same project paths and kept their dead watches.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'
import {
  BIN,
  executions,
  initialOnly,
  ARMS,
  arms,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

async function recreate(root: string, pause: boolean, wait?: () => Promise<void>) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-base-copy-'))
  await cp(path.join(root, 'packages'), path.join(copy, 'packages'), { recursive: true })
  await rm(path.join(root, 'packages'), { recursive: true, force: true })
  if (pause) await wait!()
  await cp(path.join(copy, 'packages'), path.join(root, 'packages'), { recursive: true })
  await rm(copy, { recursive: true, force: true })
}

/** The project gone: its cycle fails, as the lock still holds it, until it is back. */
function gone(w: { err: () => string }): () => Promise<void> {
  const misses = (): number => w.err().split('but its vx.config.mjs is gone').length
  const before = misses()
  return () => until(() => misses() > before, 'the read that misses it')
}

describe("vx watch over a project's parent made again", () => {
  const f = useWatchFixture()

  // Polled too: the parent's arm is non-recursive, and the poller sampled
  // files alone there, so it never heard the directory come back.
  it.each([
    ['', ['--all']],
    [' (--poll)', ['--all', '--poll']],
  ])(
    'a parent removed, then made again, is watched again%s',
    async (_mode, select) => {
      f.watch = startWatch(f.root, select, ARMS)
      const w = f.watch
      await until(() => w.out().includes('watching '), 'the watching marker')
      await initialOnly(w, f.log)
      await recreate(f.root, true, gone(w))
      await until(() => arms(w, 1) === 2, 'the re-arm after the parent came back')
      const before = await executions(f.log)
      await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
      await until(
        async () => (await executions(f.log)) > before,
        'the edit after the parent came back',
      )
      expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')
    },
    40_000,
  )

  it('a parent made again inside one window is watched again', async () => {
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await recreate(f.root, false)
    await until(() => w.cycles() >= 1, 'the cycle for the parent made again')
    await until(() => arms(w) >= 2, 'its re-arm')
    const before = await executions(f.log)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a3\n')
    await until(
      async () => (await executions(f.log)) > before,
      'the edit after the parent came back',
    )
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a3\n')
  }, 40_000)

  // A project added there joins with the lock that records it.
  it('a project added under a parent made again joins once locked', async () => {
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await recreate(f.root, false)
    await until(() => arms(w) >= 2, 'the re-arm')
    const dir = path.join(f.root, 'packages', 'later')
    await mkdir(dir)
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: f.root,
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    expect(lock.exitCode).toBe(0)
    await until(() => arms(w, 2) === 1, 'the new project joining')
  }, 40_000)
})

// A project two levels down (`apps/web/site`) whose grandparent went too:
// the parent's watch held a deleted directory, so the nearest one that
// exists is watched for the next name on the way down.
describe('vx watch over a nested project whose ancestor is made again', () => {
  it('a project under it runs on an edit after `apps/` comes back', async () => {
    const root = await makeWorkspace({ prefix: 'vx-nested-base-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-nested-count-'))
    const log = path.join(outside, 'runs.log')
    const dir = path.join(root, 'apps', 'web', 'site')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'site' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt && echo run >> ${log}' } } } }\n`,
    )
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
    const w = startWatch(root, ['--all'], ARMS)
    try {
      await until(() => w.out().includes('watching '), 'the watching marker')
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-apps-copy-'))
      await cp(path.join(root, 'apps'), path.join(copy, 'apps'), { recursive: true })
      await rm(path.join(root, 'apps'), { recursive: true, force: true })
      await gone(w)()
      await cp(path.join(copy, 'apps'), path.join(root, 'apps'), { recursive: true })
      await rm(copy, { recursive: true, force: true })
      await until(() => arms(w, 1) === 2, 'the re-arm after apps/ came back')
      const before = await executions(log)
      await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
      await until(async () => (await executions(log)) > before, 'the edit after apps/ came back')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)

  // The parent's own watch is replaced when the parent is made again: kept
  // on the deleted `apps/`, a later `apps/web` removed and made again was
  // no event.
  it('after `apps/` is made again, `apps/web` made again is heard', async () => {
    const root = await makeWorkspace({ prefix: 'vx-nested-base-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-nested-count-'))
    const log = path.join(outside, 'runs.log')
    const dir = path.join(root, 'apps', 'web', 'site')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'site' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt && echo run >> ${log}' } } } }\n`,
    )
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
    const w = startWatch(root, ['--all'], ARMS)
    const swap = async (rel: string, wait?: () => Promise<void>) => {
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-apps-copy-'))
      await cp(path.join(root, rel), path.join(copy, 'x'), { recursive: true })
      await rm(path.join(root, rel), { recursive: true, force: true })
      if (wait) await wait()
      await cp(path.join(copy, 'x'), path.join(root, rel), { recursive: true })
      await rm(copy, { recursive: true, force: true })
    }
    try {
      await until(() => w.out().includes('watching '), 'the watching marker')
      await swap('apps')
      await until(() => arms(w) >= 2, 'the re-arm')
      const armed = arms(w, 1)
      await swap(path.join('apps', 'web'), gone(w))
      await until(() => arms(w, 1) > armed, 'the re-arm after apps/web came back')
      const before = await executions(log)
      await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
      await until(async () => (await executions(log)) > before, 'the edit after it came back')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)
})

// A config's import from outside the projects (`../../shared/preset.mjs`)
// is watched by directory (item 949): restored after removal, that watch
// held the deleted directory, and an edit to the preset ran nothing. A
// cycle runs the lock's configs, so the edit runs the old value until
// `vx lock` writes the new one.
describe('vx watch over a config import directory made again', () => {
  it('an edit to a restored preset is heard, and re-runs under its new value once locked', async () => {
    const root = await makeWorkspace({ prefix: 'vx-import-dir-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-import-count-'))
    const log = path.join(outside, 'runs.log')
    await mkdir(path.join(root, 'shared'))
    await writeFile(path.join(root, 'shared', 'preset.mjs'), "export const word = 'v1'\n")
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `import { word } from '../../shared/preset.mjs'\nexport default { tasks: { build: { exec: { command: 'echo ' + word + ' >> ${log}' } } } }\n`,
    )
    const w = startWatch(root, ['--all'], ARMS)
    const runs = async (): Promise<string[]> =>
      (await readFile(log, 'utf8')).split('\n').filter(Boolean)
    try {
      await until(() => w.out().includes('watching '), 'the watching marker')
      // The removal's cycle re-arms too, so the restore's re-arm is the
      // second: on macOS an edit before it landed in an unwatched gap.
      const rearms = (): number => arms(w) - 1
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-shared-copy-'))
      await cp(path.join(root, 'shared'), path.join(copy, 'shared'), { recursive: true })
      await rm(path.join(root, 'shared'), { recursive: true, force: true })
      await until(() => rearms() >= 1, 'the re-arm after the removal')
      await cp(path.join(copy, 'shared'), path.join(root, 'shared'), { recursive: true })
      await rm(copy, { recursive: true, force: true })
      await until(() => rearms() >= 2, 'the re-arm after the restore')
      const before = (await runs()).length
      await writeFile(path.join(root, 'shared', 'preset.mjs'), "export const word = 'v2'\n")
      await until(async () => (await runs()).length > before, 'the run the edit starts')
      expect((await runs()).at(-1)).toBe('v1')
      const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
      })
      expect(lock.exitCode).toBe(0)
      await until(async () => (await runs()).includes('v2'), 'the run under v2')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)
})
