// The files a claimed file's digests read besides it (`FingerprintDigests.extras`,
// recorded by `vx lock`): a `file:` dependency's directory, a patch. A run
// keys them, so a fresh `vx run` missed after an edit to one, and the watch
// heard none of them: it idled over outputs built from the old bytes.
// So did an edit to `.git/info/exclude`, which keys read as a `.gitignore`.

import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, packagesSource, pluginSource } from './helpers/plugin.js'
import {
  ARMS,
  BIN,
  arms,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

const claimant = (extras: readonly string[]): string =>
  `${PLUGIN_IMPORT}export default { plugins: [${packagesSource()}, ${pluginSource(
    'org/claimant',
    `{ fingerprint: { files: ['custom.lock'], affected: () => undefined, digests: () => ({ hash: 'h', projects: {}, extras: ${JSON.stringify(extras)} }) } }`,
  )}] }\n`

describe('vx watch and the files a claimed file names', () => {
  const f = useWatchFixture()
  let outside = ''
  afterEach(() => {
    if (outside !== '') rmSync(outside, { recursive: true, force: true })
    outside = ''
  })

  const seed = async (extras: readonly string[]): Promise<void> => {
    await writeFile(path.join(f.root, 'custom.lock'), 'v1\n')
    await mkdir(path.join(f.root, 'vendor/left/lib'), { recursive: true })
    await writeFile(path.join(f.root, 'vendor/left/lib/index.js'), 'L1\n')
    await mkdir(path.join(f.root, 'patches'), { recursive: true })
    await writeFile(path.join(f.root, 'patches/left.patch'), 'p1\n')
    await Bun.write(path.join(f.root, '.vx/workspace.mjs'), claimant(extras))
  }

  it('an edit under a recorded directory is a cycle', async () => {
    await seed(['vendor/left'])
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(f.root, 'vendor/left/lib/index.js'), 'L2\n')
    await until(() => w.cycles() === 1, 'the cycle for the linked directory')
    expect(w.out()).toContain('changed root vendor/left/lib/index.js')
  }, 40_000)

  it('an edit to a recorded patch file is a cycle', async () => {
    await seed(['patches/left.patch'])
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(f.root, 'patches/left.patch'), 'p2\n')
    await until(() => w.cycles() === 1, 'the cycle for the patch')
    expect(w.out()).toContain('changed root patches/left.patch')
  }, 40_000)

  it('a directory above the root is heard too', async () => {
    outside = mkdtempSync(path.join(os.tmpdir(), 'vx-watch-linked-'))
    await writeFile(path.join(outside, 'index.js'), 'O1\n')
    await seed([path.relative(f.root, outside)])
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(outside, 'index.js'), 'O2\n')
    await until(() => w.cycles() === 1, 'the cycle for the outside directory')
    expect(w.out()).toContain(`changed root ${path.relative(f.root, outside)}/index.js`)
  }, 40_000)

  it('a file a re-lock adds to the record is heard from the re-arm', async () => {
    await seed([])
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await Bun.write(path.join(f.root, '.vx/workspace.mjs'), claimant(['patches/left.patch']))
    await until(() => arms(w) === 2, 'the re-arm after the workspace config edit')
    const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: f.root,
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    expect(lock.exitCode).toBe(0)
    await until(() => arms(w) === 3, 'the re-arm after the re-lock')
    const before = w.cycles()
    await writeFile(path.join(f.root, 'patches/left.patch'), 'p2\n')
    await until(() => w.cycles() === before + 1, 'the cycle for the newly recorded patch')
    expect(w.out()).toContain('changed root patches/left.patch')
  }, 40_000)

  it('an edit to .git/info/exclude is a cycle', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(f.root, '.git/info/exclude'), '*.log\n')
    await until(() => w.cycles() === 1, 'the cycle for info/exclude')
    expect(w.out()).toContain('changed root .git/info/exclude')
  }, 40_000)
})
