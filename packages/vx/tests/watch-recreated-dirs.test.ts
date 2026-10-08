// An inotify watch holds an inode, not a path. A member base removed and
// made again (`rm -rf packages && git checkout packages`) left its watch on
// the deleted directory, and the root arm drops every name but its own
// files, so the base coming back was no event: `watching 0 project(s)`,
// and no edit after it ran until a restart. Made again inside one window,
// the re-read found the same project paths and kept their dead watches.

import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'
import {
  executions,
  initialOnly,
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

describe('vx watch over a member base made again', () => {
  const f = useWatchFixture()

  it('a base removed, then made again, is watched again', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    await recreate(f.root, true, () =>
      until(() => w.out().includes('watching 0 project(s)'), 'the cycle that drops the project'),
    )
    await until(
      () => w.out().split('watching 1 project(s)').length === 3,
      'the re-arm after the base came back',
    )
    const before = await executions(f.log)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) > before, 'the edit after the base came back')
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')
  }, 40_000)

  it('a base made again inside one window is watched again', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    await recreate(f.root, false)
    await until(() => w.cycles() >= 1, 'the cycle for the base made again')
    await until(() => w.out().split('vx watch: watching').length >= 3, 'its re-arm')
    const before = await executions(f.log)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a3\n')
    await until(async () => (await executions(f.log)) > before, 'the edit after the base came back')
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a3\n')
  }, 40_000)

  // The base's own watch is what hears a package come: one kept on the
  // deleted directory left a package added after the base came back
  // unwatched and unrun.
  it('a package added to a base made again joins', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    await recreate(f.root, false)
    await until(() => w.out().split('vx watch: watching').length >= 3, 'the re-arm')
    const dir = path.join(f.root, 'packages', 'later')
    await mkdir(dir)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'later' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    await until(() => w.out().includes('watching 2 project(s)'), 'the new package joining')
  }, 40_000)
})

// A base two levels down (`apps/web/*`) whose parent went too: the parent's
// watch held a deleted directory, so the nearest one that exists is
// watched for the next name on the way down.
describe('vx watch over a nested base whose parent is made again', () => {
  it('a project under it runs on an edit after `apps/` comes back', async () => {
    const root = await makeWorkspace({ prefix: 'vx-nested-base-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-nested-count-'))
    const log = path.join(outside, 'runs.log')
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/web/*"\n')
    const dir = path.join(root, 'apps', 'web', 'site')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'site' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt && echo run >> ${log}' } } } }\n`,
    )
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
    const w = startWatch(root)
    try {
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-apps-copy-'))
      await cp(path.join(root, 'apps'), path.join(copy, 'apps'), { recursive: true })
      await rm(path.join(root, 'apps'), { recursive: true, force: true })
      await until(() => w.out().includes('watching 0 project(s)'), 'the cycle that drops it')
      await cp(path.join(copy, 'apps'), path.join(root, 'apps'), { recursive: true })
      await rm(copy, { recursive: true, force: true })
      await until(
        () => w.out().split('watching 1 project(s)').length === 3,
        'the re-arm after apps/ came back',
      )
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
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/web/*"\n')
    const dir = path.join(root, 'apps', 'web', 'site')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'site' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt && echo run >> ${log}' } } } }\n`,
    )
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
    const w = startWatch(root)
    const swap = async (rel: string, wait?: () => Promise<void>) => {
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-apps-copy-'))
      await cp(path.join(root, rel), path.join(copy, 'x'), { recursive: true })
      await rm(path.join(root, rel), { recursive: true, force: true })
      if (wait) await wait()
      await cp(path.join(copy, 'x'), path.join(root, rel), { recursive: true })
      await rm(copy, { recursive: true, force: true })
    }
    try {
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      await swap('apps')
      await until(() => w.out().split('vx watch: watching').length >= 3, 'the re-arm')
      await swap(path.join('apps', 'web'), () =>
        until(() => w.out().includes('watching 0 project(s)'), 'the cycle that drops it'),
      )
      await until(
        () => w.out().split('watching 0 project(s)')[1]!.includes('watching 1 project(s)'),
        'the re-arm after apps/web came back',
      )
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
// held the deleted directory, and an edit to the preset ran nothing.
describe('vx watch over a config import directory made again', () => {
  it('an edit to a restored preset re-runs under its new value', async () => {
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
    const w = startWatch(root)
    try {
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-shared-copy-'))
      await cp(path.join(root, 'shared'), path.join(copy, 'shared'), { recursive: true })
      await rm(path.join(root, 'shared'), { recursive: true, force: true })
      await until(() => w.err().includes('cycle failed'), 'the cycle that cannot load the preset')
      await cp(path.join(copy, 'shared'), path.join(root, 'shared'), { recursive: true })
      await rm(copy, { recursive: true, force: true })
      // Two re-arms: the failed cycle's read cannot resolve the missing
      // preset, so the cycle that loads it again must read once more.
      await until(
        () => w.out().split('vx watch: watching 1 project(s)\n').length >= 3,
        'the re-arm after the restore',
      )
      console.error(
        'OUT<<' +
          w.out().replace(/^[ ─]*(projects|tasks|cache|info|time|result|⏺|▰|1 ).*$/gm, '') +
          '>>',
      )
      await writeFile(path.join(root, 'shared', 'preset.mjs'), "export const word = 'v2'\n")
      await until(async () => (await readFile(log, 'utf8')).includes('v2'), 'the run under v2')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)

  // The failed cycle's re-read cannot resolve the deleted preset; kept,
  // its directory's return below the root's own files is still heard.
  it('a preset directory made again below the root is heard after the failed cycle', async () => {
    const root = await makeWorkspace({ prefix: 'vx-import-deep-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-import-count-'))
    const log = path.join(outside, 'runs.log')
    const deep = path.join(root, 'shared', 'deep')
    await mkdir(deep, { recursive: true })
    await writeFile(path.join(deep, 'preset.mjs'), "export const word = 'v1'\n")
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `import { word } from '../../shared/deep/preset.mjs'\nexport default { tasks: { build: { exec: { command: 'echo ' + word + ' >> ${log}' } } } }\n`,
    )
    const w = startWatch(root)
    try {
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      await rm(deep, { recursive: true, force: true })
      await until(() => w.err().includes('cycle failed'), 'the cycle that cannot load the preset')
      await until(() => w.out().includes('vx watch: watching 1 project(s)\n'), 'the failed re-arm')
      await mkdir(deep)
      await writeFile(path.join(deep, 'preset.mjs'), "export const word = 'v2'\n")
      await until(async () => (await readFile(log, 'utf8')).includes('v2'), 'the run under v2')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)
})

// A directory under a base with no package yet is watched for the
// `package.json` that makes it one (item 891). Made again inside one
// window, its name never left the base, so nothing re-armed it, and the
// manifest that landed after was heard by no one.
describe('vx watch over a package directory made again before its manifest', () => {
  const f = useWatchFixture()

  it('the manifest written after it is replaced joins the package', async () => {
    const later = path.join(f.root, 'packages', 'later')
    await mkdir(later)
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    // Replaced in one rename (POSIX renames onto an empty directory), so
    // the base's names never change: no member event, whatever the timing.
    const fresh = await mkdtemp(path.join(os.tmpdir(), 'vx-later-'))
    await rename(fresh, later)
    await until(() => w.out().split('vx watch: watching').length >= 3, 'the re-arm')
    await writeFile(path.join(later, 'package.json'), JSON.stringify({ name: 'later' }))
    await writeFile(
      path.join(later, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    await until(() => w.out().includes('watching 2 project(s)'), 'the package joining')
  }, 40_000)
})
