// A restore dates each file it writes now, as the task's own write would.
// It used to apply the entry's saved mtime, older than outputs written
// since: a make-style dependant that keeps its outputs (`clean: false`)
// took a restored, changed upstream as older than its own output, skipped
// the copy, and saved the other upstream's bytes under this key, which
// every machine then hit.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { fsClockNow } from '../src/memo/index.js'
import { git } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

const TIMEOUT = 60_000

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args).text

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-restore-mtime-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'a restored upstream output is newer than a make-style dependant output',
  async () => {
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await Bun.write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await Bun.write(path.join(root, '.gitignore'), 'dist\n')
    await writeLocalWorkspace(root)
    const a = path.join(root, 'packages', 'a')
    const b = path.join(root, 'packages', 'b')
    await Bun.write(path.join(a, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    await Bun.write(path.join(b, 'package.json'), JSON.stringify({ name: 'b', version: '1.0.0' }))
    await Bun.write(
      path.join(a, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: 'mkdir -p dist && cp src/lib.txt dist/lib' },
         inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
       } } }\n`,
    )
    await Bun.write(
      path.join(b, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: 'mkdir -p dist && if [ dist/out -nt ../a/dist/lib ]; then :; else cp ../a/dist/lib dist/out; fi' },
         inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'], clean: false },
         dependsOn: ['a#build'], cache: true,
       } } }\n`,
    )
    await Bun.write(path.join(a, 'src', 'lib.txt'), 'v1')
    await Bun.write(path.join(b, 'src', 'readme'), 'note')
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const out = path.join(b, 'dist', 'out')
    const lib = path.join(a, 'dist', 'lib')

    vx(root, 'run', 'build', '--all')
    await Bun.write(path.join(a, 'src', 'lib.txt'), 'v2')
    vx(root, 'run', 'build', '--all')
    expect(await readFile(out, 'utf8')).toBe('v2')
    // Back to v1 with b's input edited: a restores, b runs over it.
    await Bun.write(path.join(a, 'src', 'lib.txt'), 'v1')
    await Bun.write(path.join(b, 'src', 'readme'), 'edited')
    const before = Math.floor(fsClockNow(root))
    vx(root, 'run', 'build', '--all')
    expect(await readFile(out, 'utf8')).toBe('v1')
    expect(statSync(lib).mtimeMs).toBeGreaterThanOrEqual(before)
    // The steady state still skips the restore: the stamp holds the new date.
    const warm = vx(root, 'run', 'build', '--all')
    expect(warm).not.toContain('restored')
    expect(warm).toContain('2✓')
  },
  TIMEOUT,
)
